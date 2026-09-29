import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { parseCandidates } from './nlp.js';
import { getDeviceDiagnostics } from './adb.js';
import { runAction, getAction } from './actions/registry.js';
import { runAssistant } from './ai/assistant.js';
import { isAiEnabled } from './ai/client.js';
import { runAgentTask } from './agent/agentLoop.js';
import { createTrace } from './agent/trace.js';
import * as skills from './skills/index.js';
import { readConfig } from './config/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTACTS_FILE = path.join(__dirname, 'contacts.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');

const STEP_DELAY_MS = 120;

let _broadcast = () => {};
let _startPcShutdown = () => {
  throw new Error('PC shutdown trigger not configured');
};
let _runMacroByName = null;

export function configurePipeline({ broadcast, startPcShutdown, runMacroByName } = {}) {
  if (typeof broadcast === 'function') _broadcast = broadcast;
  if (typeof startPcShutdown === 'function') _startPcShutdown = startPcShutdown;
  if (typeof runMacroByName === 'function') _runMacroByName = runMacroByName;
}

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function buildActionCtx(config, session) {
  return {
    config,
    broadcast: _broadcast,
    log: (message, type = 'info') => _broadcast({ type: 'adb_log', log: { type, message } }),
    startPcShutdown: _startPcShutdown,
    runMacro: _runMacroByName ? (name) => _runMacroByName(name) : undefined,
    requireConfirm: Boolean(session.requireConfirm),
    confirm: session.confirm
  };
}

export async function runAssistantText(message, session = {}) {
  const broadcast = _broadcast;

  if (!isAiEnabled()) {
    const reply = 'Vani AI is off. Add GEMINI_API_KEY to a .env file (see .env.example) and restart to enable it — a free key comes from aistudio.google.com.';
    broadcast({ type: 'ai_reply', reply, disabled: true });
    return { ok: false, disabled: true, reply };
  }

  const config = readJsonFile(CONFIG_FILE, { unlockPin: '', whatsappCoords: { x: 0.91, y: 0.55 } });
  broadcast({ type: 'pipeline_start', command: message });
  broadcast({ type: 'pipeline_step', step: 0, status: 'success', message: 'Routing to Vani (Gemini)...' });

  const result = await runAssistant({
    text: message,
    session,
    onEvent: (e) => broadcast(e.type.startsWith('ai_') ? e : { type: 'ai_event', ...e }),
    actionCtx: buildActionCtx(config, session)
  });

  broadcast({
    type: 'pipeline_end',
    success: result.ok,
    error: result.ok ? undefined : (result.error || result.reply),
    ttsMessage: result.reply
  });
  return result;
}

/**
 * Map the agent's loop phases onto the five pipeline-visualiser nodes, so the
 * existing HUD animates the Perceive → Plan → Act → Verify cycle.
 */
const AGENT_NODE = { perceiving: 0, planning: 1, thinking: 1, acting: 2, awaiting_confirm: 2 };

/**
 * Run one autonomous agent task. This is the "advanced pipeline": instead of
 * one parse → one action, it is a bounded observe/act/verify loop that reads the
 * real screen between every step.
 */
export async function runAgentText(taskText, session = {}) {
  const broadcast = _broadcast;
  const task = String(taskText || '').trim();
  if (!task) return { ok: false, intent: 'AGENT', error: 'Empty task' };

  const config = readConfig();
  broadcast({ type: 'pipeline_start', command: task });

  const diagnostics = await getDeviceDiagnostics();
  if (!diagnostics.connected) {
    const error = 'Mobile device not connected';
    broadcast({ type: 'pipeline_step', step: 0, status: 'failed', message: 'Device disconnected! Connect the phone over USB with USB debugging enabled.' });
    broadcast({ type: 'pipeline_end', success: false, error });
    broadcast({ type: 'agent_done', ok: false, reason: 'no_device', summary: error, steps: 0, costUsd: 0, actions: [] });
    return { ok: false, intent: 'AGENT', error };
  }

  const trace = createTrace();
  broadcast({ type: 'agent_trace', runId: trace.runId, task });

  const result = await runAgentTask({
    text: task,
    session,
    deviceId: diagnostics.deviceId,
    config,
    trace,
    // The app is where memory is switched on; the loop itself stays pure so the
    // tests and the benchmark can run without it.
    skills,
    actionCtx: buildActionCtx(config, session),
    onEvent: (event) => {
      broadcast(event);

      if (event.type === 'agent_phase' && AGENT_NODE[event.phase] !== undefined) {
        broadcast({
          type: 'pipeline_step',
          step: AGENT_NODE[event.phase],
          status: 'pending',
          message: `${event.phase.replace('_', ' ')}${event.step ? ` (step ${event.step})` : ''}`
        });
      } else if (event.type === 'agent_action') {
        broadcast({
          type: 'pipeline_step',
          step: 2,
          status: event.outcome === 'ok' ? 'success' : 'failed',
          message: `${event.description} — ${event.outcome}`
        });
      } else if (event.type === 'agent_verify') {
        broadcast({
          type: 'pipeline_step',
          step: 3,
          status: event.changed ? 'success' : 'failed',
          message: event.changed ? 'Screen changed as expected.' : 'Screen did not change.'
        });
      }
    }
  });

  broadcast({
    type: 'pipeline_step',
    step: 4,
    status: result.ok ? 'success' : 'failed',
    message: result.summary || (result.ok ? 'Task complete.' : 'Task did not complete.')
  });
  broadcast({
    type: 'pipeline_end',
    success: result.ok,
    error: result.ok ? undefined : result.summary,
    ttsMessage: result.summary
  });

  return {
    ok: result.ok,
    intent: 'AGENT',
    runId: trace.runId,
    tts: result.summary,
    error: result.ok ? undefined : result.summary,
    result
  };
}

export async function runCommandText(commandText, session = {}, opts = {}) {
  const broadcast = _broadcast;
  const trimmed = String(commandText || '').trim();
  const altList = Array.isArray(opts.alternatives) ? opts.alternatives.filter((s) => typeof s === 'string' && s.trim()) : [];
  const fromVoice = opts.source === 'voice';

  if (/^ai\s*:/i.test(trimmed)) {
    const r = await runAssistantText(trimmed.replace(/^ai\s*:/i, '').trim(), session);
    return { ok: r.ok, intent: 'AI', tts: r.reply, error: r.ok ? undefined : r.error };
  }

  broadcast({ type: 'pipeline_start', command: commandText });

  const contacts = readJsonFile(CONTACTS_FILE, []);
  const config = readJsonFile(CONFIG_FILE, { unlockPin: '', whatsappCoords: { x: 0.91, y: 0.55 } });

  broadcast({ type: 'pipeline_step', step: 0, status: 'pending', message: 'Parsing natural language intent...' });
  await wait(STEP_DELAY_MS);

  const candidates = [commandText, ...altList];
  const { parsed, chosenText, tried } = parseCandidates(candidates, contacts, session.nlpContext);
  if (tried.length > 1) {
    broadcast({ type: 'adb_log', log: { type: 'adb-debug', message: `[STT] candidates: ${tried.map((t) => `"${t}"`).join(', ')} -> "${chosenText}"` } });
  }

  if (parsed.details && parsed.details.wakeWordDetected) {
    broadcast({
      type: 'adb_log',
      log: { type: 'success', message: "[WAKE WORD] Wake word 'Vani' authenticated! Triggering automated pipelines..." }
    });
  }

  if (parsed.intent === 'UNKNOWN') {
    if (isAiEnabled()) {
      broadcast({ type: 'pipeline_step', step: 0, status: 'success', message: 'NLP miss - escalating to Vani (Gemini)...' });
      const aiText = (fromVoice && tried.length > 1)
        ? `The user spoke a command (speech-to-text, may contain errors). Candidates, best first:\n${tried.map((t, i) => `${i + 1}) ${t}`).join('\n')}\nPick the intended command and act on it.`
        : commandText;
      const r = await runAssistant({
        text: aiText,
        session,
        onEvent: (e) => broadcast(e.type.startsWith('ai_') ? e : { type: 'ai_event', ...e }),
        actionCtx: buildActionCtx(config, session)
      });
      broadcast({
        type: 'pipeline_end',
        success: r.ok,
        error: r.ok ? undefined : (r.error || r.reply),
        ttsMessage: r.reply
      });
      return { ok: r.ok, intent: 'AI', tts: r.reply, error: r.ok ? undefined : r.error };
    }
    broadcast({ type: 'pipeline_step', step: 0, status: 'failed', message: `Could not extract an intent from: "${commandText}"` });
    broadcast({ type: 'pipeline_end', success: false, error: 'Command not recognized' });
    return { ok: false, intent: 'UNKNOWN', error: 'Command not recognized' };
  }

  const action = getAction(parsed.intent);
  broadcast({
    type: 'pipeline_step',
    step: 0,
    status: 'success',
    message: `Intent detected: ${parsed.intent}. Pipeline: [${(parsed.pipeline || []).join(' ➔ ')}]`
  });

  broadcast({ type: 'pipeline_step', step: 1, status: 'pending', message: 'Verifying command parameters...' });
  await wait(STEP_DELAY_MS);

  if ((parsed.intent === 'CALL' || parsed.intent === 'WHATSAPP') && !parsed.details.number) {
    broadcast({ type: 'pipeline_step', step: 1, status: 'failed', message: 'Contact or phone number could not be resolved.' });
    broadcast({ type: 'pipeline_end', success: false, error: 'Unresolved phone number' });
    return { ok: false, intent: parsed.intent, error: 'Unresolved phone number' };
  }
  broadcast({
    type: 'pipeline_step',
    step: 1,
    status: 'success',
    message: parsed.details.number
      ? `Resolved: ${parsed.details.name || 'Raw Number'} (${parsed.details.number})`
      : `Parameters resolved for ${parsed.intent}`
  });

  broadcast({ type: 'pipeline_step', step: 2, status: 'pending', message: 'Checking execution endpoint state...' });
  if (action?.local || action?.readOnly) {
    broadcast({ type: 'pipeline_step', step: 2, status: 'success', message: 'Local endpoint online. Proceeding...' });
  } else {
    const diagnostics = await getDeviceDiagnostics();
    if (!diagnostics.connected) {
      broadcast({
        type: 'pipeline_step',
        step: 2,
        status: 'failed',
        message: 'Device disconnected! Connect the phone over USB with USB debugging enabled.'
      });
      broadcast({ type: 'pipeline_end', success: false, error: 'Mobile device not connected' });
      return { ok: false, intent: parsed.intent, error: 'Mobile device not connected' };
    }
    broadcast({
      type: 'pipeline_step',
      step: 2,
      status: 'success',
      message: `Connected to ${diagnostics.brand} ${diagnostics.model} via ADB`
    });
  }

  broadcast({ type: 'pipeline_step', step: 3, status: 'pending', message: 'Compiling automation script...' });
  await wait(STEP_DELAY_MS);
  const summary = action?.summary ? action.summary(parsed.details) : parsed.intent;
  broadcast({ type: 'pipeline_step', step: 3, status: 'success', message: `Script compiled: ${summary}` });

  broadcast({ type: 'pipeline_step', step: 4, status: 'pending', message: 'Executing instruction pipeline...' });

  const ctx = buildActionCtx(config, session);

  try {
    const outcome = await runAction(parsed.intent, parsed.details, ctx);

    if (outcome.skipped) {
      broadcast({ type: 'pipeline_step', step: 4, status: 'failed', message: 'Cancelled — confirmation declined.' });
      broadcast({ type: 'pipeline_end', success: false, error: 'declined', ttsMessage: 'Okay, maine cancel kar diya.' });
      return { ok: false, skipped: true, intent: parsed.intent };
    }

    broadcast({ type: 'pipeline_step', step: 4, status: 'success', message: 'Execution completed. Action transmitted.' });
    broadcast({ type: 'pipeline_end', success: true, ttsMessage: outcome.tts || '' });

    if (!action?.local) {
      setTimeout(async () => {
        try {
          const diagnostics = await getDeviceDiagnostics();
          broadcast({ type: 'diagnostics', data: diagnostics });
        } catch {  }
      }, 4000);
    }

    return { ok: true, intent: parsed.intent, tts: outcome.tts, result: outcome.result };
  } catch (error) {
    broadcast({ type: 'pipeline_step', step: 4, status: 'failed', message: `Execution failed: ${error.message}` });
    broadcast({ type: 'pipeline_end', success: false, error: error.message, ttsMessage: `Pipeline failed. ${error.message}` });
    return { ok: false, intent: parsed.intent, error: error.message };
  }
}
