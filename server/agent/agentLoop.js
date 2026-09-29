/**
 * The phone-use agent loop: Perceive → Plan → Act → Verify.
 *
 * Shape follows `ai/assistant.js` (history handling, typed error mapping) but
 * the contract is different: the model gets a fresh observation of the real
 * screen before every action and may take exactly one action per turn.
 *
 * Every collaborator is injectable so the whole loop is testable with no phone
 * and no API key.
 */

import { describeAiError } from '../ai/errors.js';
import { getClient, AI_MODEL } from '../ai/client.js';
import { readConfig } from '../config/index.js';
import { AgentBudget, STOP_REASONS } from './budget.js';
import { classifyAction, describeAction, RISK } from './safety.js';
import * as realTools from './tools.js';
import * as realPerception from './perception.js';
import { NULL_SKILLS } from '../skills/index.js';
import { replaySkill as realReplaySkill } from '../skills/replay.js';
import {
  AGENT_SYSTEM_PROMPT,
  buildPlanPrompt,
  parsePlan,
  buildObservation,
  STUCK_NOTE,
  verifyNote
} from './prompt.js';

const OBSERVATION_TAG = 'Step ';
const STUCK_THRESHOLD = 3;
const KEEP_FULL_OBSERVATIONS = 2;

// A turn only has to produce one short thought plus one tool call, but on
// thinking-enabled models the reasoning is billed against max_tokens too — too
// low a ceiling truncates the response *before* the tool_use block and the loop
// sees a turn with no action. Leave real headroom; the cost cap is the actual
// spending control, not this.
const ACT_MAX_TOKENS = 4096;
const PLAN_MAX_TOKENS = 1500;

/**
 * Bound history growth: older observations are the bulk of the tokens and the
 * model only needs the most recent screen. Images are dropped first.
 */
function pruneHistory(history) {
  const cutoff = history.length - (KEEP_FULL_OBSERVATIONS * 2);
  for (let i = 0; i < cutoff; i++) {
    const message = history[i];
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    message.content = message.content.map((block) => {
      if (block.type === 'image') return { type: 'text', text: '[screenshot omitted]' };
      if (block.type === 'text' && block.text.startsWith(OBSERVATION_TAG)) {
        return { type: 'text', text: `${block.text.split('\n')[0]}\n[screen listing omitted]` };
      }
      return block;
    });
  }
}

function imageBlock(base64) {
  return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } };
}

const errorReply = describeAiError;

/**
 * Run one autonomous task against the connected phone.
 *
 * @returns {Promise<{ok:boolean, reason:string, summary:string, steps:number,
 *                    costUsd:number, actions:object[]}>}
 */
export async function runAgentTask({
  text,
  session = {},
  onEvent = () => {},
  actionCtx = {},
  deviceId,
  client,
  config,
  perception = realPerception,
  tools: toolsModule = realTools,
  trace = null,
  // Memory is opt-in: the caller supplies the real skill library. Left out, the
  // loop behaves exactly as it did before it existed.
  skills = NULL_SKILLS,
  replaySkill = realReplaySkill
} = {}) {
  const model = client === undefined ? getClient() : client;
  const task = String(text ?? '').trim();

  if (!model) {
    const summary = 'Vani Autopilot is off. Add GEMINI_API_KEY to a .env file and restart, or set NEXUSFLOW_AI_PROVIDER=mock.';
    onEvent({ type: 'agent_done', ok: false, disabled: true, summary });
    return { ok: false, disabled: true, reason: 'disabled', summary, steps: 0, costUsd: 0, actions: [] };
  }
  if (!task) {
    const summary = 'No task was given.';
    onEvent({ type: 'agent_done', ok: false, summary });
    return { ok: false, reason: 'empty', summary, steps: 0, costUsd: 0, actions: [] };
  }

  const cfg = config || readConfig();
  const budget = new AgentBudget({ maxSteps: cfg.agentMaxSteps, costCapUsd: cfg.agentCostCapUsd });
  const dryRun = Boolean(cfg.agentDryRun);
  const appAllowlist = cfg.agentAppAllowlist || [];

  // Exposed so the WS `agent_abort` handler can stop a run already in flight.
  session.agentBudget = budget;

  const tools = toolsModule.buildAgentTools();
  const actions = [];
  let pendingImage = false;
  let lastSignature = null;
  let repeats = 0;
  let note = null;

  const finishRun = async (result) => {
    session.agentBudget = null;
    const payload = { ...result, steps: budget.steps, costUsd: budget.snapshot().costUsd, actions };
    onEvent({ type: 'agent_done', ...payload, budget: budget.snapshot() });

    if (trace) {
      const record = trace.finish(payload);
      // Fold a successful run into the library so the next identical task skips
      // the model entirely. Not for replays — that skill is already stored, and
      // re-learning it from its own output would teach nothing.
      if (payload.ok && payload.reason !== 'recalled') {
        const learned = await skills.learn(record, payload);
        if (learned) {
          onEvent({
            type: 'agent_event',
            level: 'info',
            message: `Learned this as a reusable skill — next time it runs with no AI calls.`
          });
        }
      }
    }
    return payload;
  };

  onEvent({
    type: 'agent_start',
    task,
    dryRun,
    maxSteps: budget.maxSteps,
    costCapUsd: budget.costCapUsd
  });

  const history = [];

  try {
    // ---- Recall (round -1) --------------------------------------------------
    // What we already know about this task, from runs that worked before.
    const memory = await skills.recall(task);

    if (memory.exact) {
      // The whole point of the library: a task we have solved before does not
      // need the model at all.
      onEvent({
        type: 'agent_event',
        level: 'info',
        message: `Recalled a learned skill — replaying "${memory.exact.name}" with no AI calls.`
      });
      if (trace) trace.start({ task, subgoals: [], dryRun });

      const replayed = await replaySkill(memory.exact, memory.values, {
        perception,
        tools: toolsModule,
        deviceId,
        dryRun,
        confirm: actionCtx.confirm || null,
        appAllowlist,
        onEvent
      });

      skills.store.recordUse(memory.exact.id, replayed.ok);

      // A stale recording should not sink the task — fall through to the model,
      // which will re-learn the current layout and replace the skill.
      if (replayed.ok) {
        for (const action of replayed.actions) actions.push(action);
        return finishRun({ ok: true, reason: 'recalled', summary: replayed.summary, skill: memory.exact.name });
      }

      onEvent({
        type: 'agent_event',
        level: 'warn',
        message: `Replay did not stick (${replayed.reason}) — working it out from scratch.`
      });
    }

    // ---- Plan (round 0) -----------------------------------------------------
    onEvent({ type: 'agent_phase', phase: 'planning' });
    let subgoals = [];
    const hints = skills.formatHints(memory.similar);
    try {
      const planRes = await model.messages.create({
        model: AI_MODEL,
        max_tokens: PLAN_MAX_TOKENS,
        system: AGENT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: hints ? `${hints}\n\n${buildPlanPrompt(task)}` : buildPlanPrompt(task) }]
      });
      budget.recordUsage(planRes.usage);
      const planText = (planRes.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      subgoals = parsePlan(planText);
    } catch (planError) {
      // A failed plan is cosmetic — the loop works without a checklist.
      onEvent({ type: 'agent_event', level: 'warn', message: `Planning failed: ${planError.message}` });
    }
    onEvent({ type: 'agent_plan', subgoals, budget: budget.snapshot() });
    if (trace) trace.start({ task, subgoals, dryRun });

    history.push({
      role: 'user',
      content: subgoals.length
        ? `Task: ${task}\n\nYour plan:\n${subgoals.map((s) => `- ${s}`).join('\n')}\n\nNow carry it out one action at a time.`
        : `Task: ${task}\n\nCarry it out one action at a time.`
    });

    // ---- Act / verify loop --------------------------------------------------
    let noToolNudges = 0;

    for (;;) {
      const stop = budget.checkBeforeStep();
      if (stop) {
        return finishRun({
          ok: false,
          reason: stop.reason,
          summary: stop.message,
          aborted: stop.reason === STOP_REASONS.ABORTED
        });
      }

      const stepNumber = budget.countStep();

      // --- PERCEIVE ---
      onEvent({ type: 'agent_phase', phase: 'perceiving', step: stepNumber });
      const wantImage = pendingImage || stepNumber === 1;
      pendingImage = false;
      const state = await perception.captureState({ deviceId, withImage: wantImage });

      // --- VERIFY the previous action by comparing screen fingerprints ---
      const signature = perception.screenSignature(state);
      if (lastSignature !== null && signature === lastSignature) {
        repeats += 1;
        const last = actions[actions.length - 1];
        if (last && !note) note = verifyNote(last.detail || last.name);
        onEvent({ type: 'agent_verify', step: stepNumber, changed: false, repeats });
      } else {
        repeats = 0;
        if (lastSignature !== null) onEvent({ type: 'agent_verify', step: stepNumber, changed: true });
      }
      lastSignature = signature;
      if (repeats >= STUCK_THRESHOLD) {
        note = STUCK_NOTE;
        onEvent({ type: 'agent_event', level: 'warn', message: 'Agent appears stuck — asking it to replan.' });
      }

      onEvent({
        type: 'agent_observe',
        step: stepNumber,
        appPackage: state.appPackage,
        degraded: Boolean(state.degraded),
        elements: perception.overlayElements(state)
      });

      const observation = [{
        type: 'text',
        text: buildObservation({
          screenText: perception.serializeForModel(state),
          stepNumber,
          maxSteps: budget.maxSteps,
          note
        })
      }];
      if (state.imageB64) observation.push(imageBlock(state.imageB64));
      note = null;

      history.push({ role: 'user', content: observation });
      pruneHistory(history);

      // --- THINK ---
      onEvent({ type: 'agent_phase', phase: 'thinking', step: stepNumber });
      const res = await model.messages.create({
        model: AI_MODEL,
        max_tokens: ACT_MAX_TOKENS,
        system: AGENT_SYSTEM_PROMPT,
        tools,
        messages: history
      });
      budget.recordUsage(res.usage);
      history.push({ role: 'assistant', content: res.content });

      if (res.stop_reason === 'refusal') {
        return finishRun({ ok: false, reason: 'refusal', summary: "I can't help with that request." });
      }

      if (res.stop_reason === 'max_tokens') {
        // The turn was cut off, so any tool call it was building is incomplete.
        // Say so plainly rather than letting it look like the model chose not
        // to act.
        onEvent({
          type: 'agent_event',
          level: 'warn',
          message: `Step ${budget.steps}: the model hit the ${ACT_MAX_TOKENS}-token response limit.`
        });
        return finishRun({
          ok: false,
          reason: 'max_tokens',
          summary: 'The model ran out of response room mid-step. Try a narrower task.'
        });
      }

      const blocks = res.content || [];
      const thought = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      const toolUses = blocks.filter((b) => b.type === 'tool_use');

      onEvent({
        type: 'agent_step',
        step: stepNumber,
        thought,
        budget: budget.snapshot()
      });

      if (!toolUses.length) {
        // The model answered instead of acting. Nudge once, then take it as the answer.
        if (noToolNudges === 0) {
          noToolNudges += 1;
          history.push({
            role: 'user',
            content: 'You must call a tool to make progress, or call finish if the task is done or impossible.'
          });
          continue;
        }
        return finishRun({ ok: true, reason: 'replied', summary: thought || 'Done.' });
      }

      // --- ACT (exactly one action per turn) ---
      onEvent({ type: 'agent_phase', phase: 'acting', step: stepNumber });
      const [primary, ...extras] = toolUses;
      const results = [];
      let control = null;

      const input = primary.input && typeof primary.input === 'object' ? primary.input : {};
      const target = toolsModule.resolveTarget(primary.name, input, state);
      const description = describeAction({ name: primary.name, input }, target);
      const verdict = classifyAction({ name: primary.name, input, target }, state, { appAllowlist });

      if (verdict.risk === RISK.BLOCK) {
        onEvent({
          type: 'agent_action',
          step: stepNumber,
          name: primary.name,
          description,
          outcome: 'blocked',
          reason: verdict.reason
        });
        if (trace) trace.step({ step: stepNumber, thought, description, outcome: 'blocked', reason: verdict.reason, state });
        results.push({
          type: 'tool_result',
          tool_use_id: primary.id,
          is_error: true,
          content: `Blocked by the safety layer: ${verdict.reason}. Do not retry — ask the user instead.`
        });
      } else if (verdict.risk === RISK.CONFIRM && dryRun) {
        // Dry run is the demo mode: go right up to the irreversible step, then stop.
        onEvent({
          type: 'agent_action',
          step: stepNumber,
          name: primary.name,
          description,
          outcome: 'dry_run',
          reason: verdict.reason
        });
        if (trace) trace.step({ step: stepNumber, thought, description, outcome: 'dry_run', reason: verdict.reason, state });
        return finishRun({
          ok: true,
          reason: 'dry_run',
          dryRun: true,
          summary: `Dry run — stopped before the irreversible step. Next action would have been: ${description} (${verdict.reason}).`
        });
      } else {
        let approved = true;
        if (verdict.risk === RISK.CONFIRM) {
          if (typeof actionCtx.confirm === 'function') {
            onEvent({ type: 'agent_phase', phase: 'awaiting_confirm', step: stepNumber, description });
            approved = await actionCtx.confirm(`${description} — ${verdict.reason}`);
          } else {
            // Nothing here can ask a human, so this action cannot be approved.
            // Fail closed: an unattended caller must never auto-approve a step
            // the safety layer flagged as irreversible.
            approved = false;
            onEvent({
              type: 'agent_event',
              level: 'warn',
              message: `Refused "${description}" — it needs confirmation and no one is available to give it.`
            });
          }
        }

        if (!approved) {
          onEvent({ type: 'agent_action', step: stepNumber, name: primary.name, description, outcome: 'declined' });
          if (trace) trace.step({ step: stepNumber, thought, description, outcome: 'declined', state });
          results.push({
            type: 'tool_result',
            tool_use_id: primary.id,
            is_error: true,
            content: 'The user declined this action. Do not retry it.'
          });
        } else {
          try {
            const outcome = await toolsModule.runPrimitive(primary.name, input, { state, deviceId });
            control = outcome.control || null;
            if (outcome.requestImage) pendingImage = true;
            actions.push({ name: primary.name, detail: outcome.detail, step: stepNumber });
            onEvent({
              type: 'agent_action',
              step: stepNumber,
              name: primary.name,
              description,
              outcome: outcome.ok ? 'ok' : 'failed',
              detail: outcome.detail,
              target: target ? { index: target.index, box: target.box, label: target.label } : null
            });
            if (trace) {
              trace.step({
                step: stepNumber, thought, description,
                outcome: outcome.ok ? 'ok' : 'failed', detail: outcome.detail,
                name: primary.name, input, target, state
              });
            }
            results.push({
              type: 'tool_result',
              tool_use_id: primary.id,
              is_error: !outcome.ok,
              content: outcome.detail || 'done'
            });
          } catch (actionError) {
            onEvent({
              type: 'agent_action',
              step: stepNumber, name: primary.name, description,
              outcome: 'failed', detail: actionError.message
            });
            if (trace) trace.step({ step: stepNumber, thought, description, outcome: 'failed', detail: actionError.message, state });
            results.push({
              type: 'tool_result',
              tool_use_id: primary.id,
              is_error: true,
              content: String(actionError.message).slice(0, 400)
            });
          }
        }
      }

      // The API needs a result for every tool_use block, even ones we skipped.
      for (const extra of extras) {
        results.push({
          type: 'tool_result',
          tool_use_id: extra.id,
          is_error: true,
          content: 'Only one action runs per turn — this one was not executed. Re-request it next turn if still needed.'
        });
      }

      history.push({ role: 'user', content: results });

      if (control?.finish) {
        return finishRun({
          ok: Boolean(control.finish.success),
          reason: control.finish.success ? 'finished' : 'failed',
          summary: control.finish.summary
        });
      }
      if (control?.ask) {
        onEvent({ type: 'agent_ask', step: stepNumber, question: control.ask });
        return finishRun({ ok: false, reason: 'ask_user', summary: control.ask, question: control.ask });
      }
    }
  } catch (err) {
    return finishRun({ ok: false, reason: 'error', error: err.message, summary: errorReply(err) });
  }
}
