/**
 * NexusFlow command pipeline.
 *
 * Extracted from index.js so it can be imported and tested without booting the
 * HTTP server. `configurePipeline()` injects the transport (broadcast) and the
 * PC-shutdown trigger; `runCommandText()` is the single entry point shared by
 * the WebSocket command handler, macros and the AI assistant.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { parseCommand } from './nlp.js';
import { getDeviceDiagnostics } from './adb.js';
import { runAction, getAction } from './actions/registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTACTS_FILE = path.join(__dirname, 'contacts.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');

const STEP_DELAY_MS = 120; // brief pause so the pipeline visualiser animates

let _broadcast = () => {};
let _startPcShutdown = () => {
  throw new Error('PC shutdown trigger not configured');
};

export function configurePipeline({ broadcast, startPcShutdown } = {}) {
  if (typeof broadcast === 'function') _broadcast = broadcast;
  if (typeof startPcShutdown === 'function') _startPcShutdown = startPcShutdown;
}

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Parse + execute one natural-language command.
 *
 * @param {string} commandText
 * @param {object} [session]  { id?, requireConfirm?, confirm?, nlpContext? }
 * @returns {Promise<{ok:boolean, intent:string, tts?:string, error?:string, skipped?:boolean}>}
 */
export async function runCommandText(commandText, session = {}) {
  const broadcast = _broadcast;
  broadcast({ type: 'pipeline_start', command: commandText });

  const contacts = readJsonFile(CONTACTS_FILE, []);
  const config = readJsonFile(CONFIG_FILE, { unlockPin: '', whatsappCoords: { x: 0.91, y: 0.55 } });

  // Step 0 - intent extraction
  broadcast({ type: 'pipeline_step', step: 0, status: 'pending', message: 'Parsing natural language intent...' });
  await wait(STEP_DELAY_MS);

  const parsed = parseCommand(commandText, contacts, session.nlpContext);

  if (parsed.details && parsed.details.wakeWordDetected) {
    broadcast({
      type: 'adb_log',
      log: { type: 'success', message: "[WAKE WORD] Wake word 'Vani' authenticated! Triggering automated pipelines..." }
    });
  }

  if (parsed.intent === 'UNKNOWN') {
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

  // Step 1 - parameter resolution
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

  // Step 2 - endpoint handshake (skipped for PC-local / no-device actions)
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

  // Step 3 - compile
  broadcast({ type: 'pipeline_step', step: 3, status: 'pending', message: 'Compiling automation script...' });
  await wait(STEP_DELAY_MS);
  const summary = action?.summary ? action.summary(parsed.details) : parsed.intent;
  broadcast({ type: 'pipeline_step', step: 3, status: 'success', message: `Script compiled: ${summary}` });

  // Step 4 - execute via the Action Registry
  broadcast({ type: 'pipeline_step', step: 4, status: 'pending', message: 'Executing instruction pipeline...' });

  const ctx = {
    config,
    broadcast,
    log: (message, type = 'info') => broadcast({ type: 'adb_log', log: { type, message } }),
    startPcShutdown: _startPcShutdown,
    requireConfirm: Boolean(session.requireConfirm),
    confirm: session.confirm
  };

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
        } catch { /* background refresh only */ }
      }, 4000);
    }

    return { ok: true, intent: parsed.intent, tts: outcome.tts, result: outcome.result };
  } catch (error) {
    broadcast({ type: 'pipeline_step', step: 4, status: 'failed', message: `Execution failed: ${error.message}` });
    broadcast({ type: 'pipeline_end', success: false, error: error.message, ttsMessage: `Pipeline failed. ${error.message}` });
    return { ok: false, intent: parsed.intent, error: error.message };
  }
}
