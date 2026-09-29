/**
 * Replaying a learned skill — the tier that costs nothing.
 *
 * No model is called here at all. What makes that safe to do is that taps are
 * re-resolved against the live screen by label rather than fired at recorded
 * pixels: if the row moved, the label still finds it, and if the label is gone
 * the screen is genuinely different from the recording and we say so instead of
 * tapping whatever now occupies that spot.
 *
 * The safety classifier runs on every step exactly as it does in the agent
 * loop. A recording is not a licence — "Place order" needs confirming whether a
 * model chose it this second or a previous run chose it last week.
 */

import { classifyAction, describeAction, RISK } from '../agent/safety.js';
import { applyParams } from './distill.js';

/** Steps that move on to a new screen, after which a stale listing is useless. */
const CHANGES_SCREEN = new Set(['tap_element', 'tap_xy', 'press_key', 'open_app', 'swipe']);

function normalizeLabel(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Find the recorded element on the screen as it looks now.
 * Exact label first, then a contains-match for labels that gained a suffix
 * ("Airplane mode" → "Airplane mode, off").
 */
export function findElement(label, elements = []) {
  const want = normalizeLabel(label);
  if (!want) return null;

  const exact = elements.find((el) => normalizeLabel(el.label) === want);
  if (exact) return exact;

  const partial = elements.filter((el) => {
    const has = normalizeLabel(el.label);
    return has && (has.includes(want) || want.includes(has));
  });
  // Ambiguity here means guessing, and guessing is what coordinates already do.
  return partial.length === 1 ? partial[0] : null;
}

/**
 * Run a learned skill against the phone.
 *
 * @returns {Promise<{ok:boolean, reason:string, summary:string, steps:number, actions:object[]}>}
 */
export async function replaySkill(skill, values, {
  perception,
  tools,
  deviceId,
  dryRun = false,
  confirm = null,
  appAllowlist = [],
  onEvent = () => {  }
} = {}) {
  const steps = applyParams(skill.steps || [], values || {});
  const actions = [];

  if (!steps.length) {
    return { ok: false, reason: 'empty', summary: 'That skill has no steps to replay.', steps: 0, actions };
  }

  onEvent({ type: 'skill_replay_start', skill: { id: skill.id, name: skill.name }, steps: steps.length, values });

  let state = await perception.captureState({ deviceId, withImage: false });

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    let name = step.name;
    let input = { ...(step.input || {}) };

    // Re-resolve the recorded label against the screen in front of us.
    if (name === 'tap_element') {
      const element = findElement(step.label, state?.elements);
      if (element) {
        input = { index: element.index };
      } else if (step.fallback) {
        name = 'tap_xy';
        input = { x: step.fallback.x, y: step.fallback.y };
        onEvent({
          type: 'skill_replay_note',
          message: `"${step.label}" is not on this screen — falling back to the recorded position.`
        });
      } else {
        const summary = `The screen has changed: "${step.label}" is not here any more.`;
        onEvent({ type: 'skill_replay_done', ok: false, reason: 'drift', summary });
        return { ok: false, reason: 'drift', summary, steps: i, actions };
      }
    }

    // classifyAction reads the target off the action itself — passing it as an
    // option instead silently skips every target-based rule ("Place order",
    // password fields), which is exactly the check replay must not lose.
    const action = { name, input };
    if (name === 'tap_element') action.target = tools.resolveTarget(name, input, state);
    const verdict = classifyAction(action, state, { appAllowlist });

    if (verdict.risk === RISK.BLOCK) {
      const summary = `Stopped: ${describeAction(action)} is blocked (${verdict.reason}).`;
      onEvent({ type: 'skill_replay_done', ok: false, reason: 'blocked', summary });
      return { ok: false, reason: 'blocked', summary, steps: i, actions };
    }

    if (dryRun) {
      actions.push({ ...action, outcome: 'dry_run' });
      onEvent({ type: 'skill_replay_step', step: i + 1, description: describeAction(action), outcome: 'dry_run' });
      continue;
    }

    if (verdict.risk === RISK.CONFIRM) {
      const approved = confirm ? await confirm(describeAction(action), verdict.reason) : false;
      if (!approved) {
        const summary = `Stopped at "${describeAction(action)}" — not confirmed.`;
        onEvent({ type: 'skill_replay_done', ok: false, reason: 'declined', summary });
        return { ok: false, reason: 'declined', summary, steps: i, actions };
      }
    }

    let result;
    try {
      result = await tools.runPrimitive(name, input, { state, deviceId });
    } catch (error) {
      const summary = `"${describeAction(action)}" failed: ${error.message}`;
      onEvent({ type: 'skill_replay_done', ok: false, reason: 'error', summary });
      return { ok: false, reason: 'error', summary, steps: i, actions };
    }

    actions.push({ ...action, outcome: result.ok ? 'ok' : 'failed', detail: result.detail });
    onEvent({
      type: 'skill_replay_step',
      step: i + 1,
      description: describeAction(action),
      outcome: result.ok ? 'ok' : 'failed',
      detail: result.detail
    });

    if (!result.ok) {
      const summary = `Replay stopped: ${result.detail}`;
      onEvent({ type: 'skill_replay_done', ok: false, reason: 'failed', summary });
      return { ok: false, reason: 'failed', summary, steps: i + 1, actions };
    }

    if (CHANGES_SCREEN.has(name) && i < steps.length - 1) {
      state = await perception.captureState({ deviceId, withImage: false });
    }
  }

  const summary = dryRun
    ? `Dry run: would have replayed ${steps.length} recorded step(s) from "${skill.name}".`
    : `Replayed "${skill.name}" — ${steps.length} step(s), no AI calls.`;

  onEvent({ type: 'skill_replay_done', ok: true, reason: 'replayed', summary });
  return { ok: true, reason: 'replayed', summary, steps: steps.length, actions };
}
