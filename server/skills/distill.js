/**
 * Turning a finished run into a reusable skill.
 *
 * Two things separate this from `trace.traceToMacro`, which already freezes a
 * run into a macro:
 *
 * 1. **Labels beat coordinates.** traceToMacro rewrites every `tap_element`
 *    into a `tap_xy` at the recorded point, which is exact today and wrong the
 *    moment a row shifts, a banner appears, or the font size changes. A skill
 *    keeps the label and re-resolves it against the live screen, falling back to
 *    the coordinates only if the label is gone.
 *
 * 2. **Skills take arguments.** "search for lofi beats" and "search for jazz"
 *    are one skill, not two. Any literal that appears both in a step and in the
 *    task text is lifted into a parameter, so the recorded run becomes a
 *    template that later tasks can fill in.
 *
 * Parameter detection is deliberately mechanical — string containment, no model
 * call. It catches the case that actually recurs (typed text) and is cheap,
 * deterministic and testable, which a model-written generalisation would not be.
 */

import { normalizeTask } from './embed.js';

/** Actions that change the device and can therefore be replayed. */
const REPLAYABLE = new Set(['tap_element', 'tap_xy', 'type_text', 'swipe', 'press_key', 'open_app', 'wait']);

/** Shorter than this and a "parameter" is just a common word. */
const MIN_PARAM_LENGTH = 3;

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/**
 * Pull the replayable steps out of a trace, keeping what is needed to re-find
 * each target rather than only where it happened to be.
 */
export function extractSteps(trace) {
  const steps = [];

  for (const step of trace?.steps || []) {
    if (step.outcome !== 'ok' || !REPLAYABLE.has(step.name)) continue;

    if (step.name === 'tap_element') {
      const label = step.target?.label || '';
      const hasPoint = typeof step.target?.nx === 'number';
      // Nothing to re-find it by and nowhere to fall back to.
      if (!label && !hasPoint) continue;
      steps.push({
        name: 'tap_element',
        label,
        fallback: hasPoint ? { x: step.target.nx, y: step.target.ny } : null,
        description: step.description || label
      });
      continue;
    }

    steps.push({
      name: step.name,
      input: step.input || {},
      description: step.description || step.name
    });
  }

  return steps;
}

/**
 * The literal strings a step contributes as parameter candidates.
 *
 * Typed text only, and deliberately so:
 *
 * - **Tap labels are not parameters.** "open YouTube and search for lofi beats"
 *   contains the word "search", and the run taps a button labelled "Search" —
 *   a coincidence, not a variable. Lifting it produced the template
 *   `open {{a}} and {{b}} for {{c}}`, which is nonsense.
 * - **App names are not parameters either.** Swapping YouTube for Spotify does
 *   not just change a word; it changes the whole screen, and the recorded taps
 *   would not survive the trip. A different app deserves a different skill.
 *
 * What genuinely varies while the UI path stays put is what the user typed.
 */
function literalsOf(step) {
  if (step.name !== 'type_text') return [];
  const text = step.input?.text;
  if (typeof text !== 'string' || text.trim().length < MIN_PARAM_LENGTH) return [];
  return [text];
}

function replaceLiteral(step, literal, token) {
  const swap = (v) => (typeof v === 'string' && v === literal ? token : v);
  if (step.name === 'type_text') return { ...step, input: { ...step.input, text: swap(step.input.text) } };
  if (step.name === 'open_app') return { ...step, input: { ...step.input, appName: swap(step.input.appName) } };
  if (step.name === 'tap_element') return { ...step, label: swap(step.label) };
  return step;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Lift task-derived literals into named parameters.
 *
 * @returns {{template:string, params:object[], steps:object[]}} `template` is
 *   the task text with parameter values replaced by `{{name}}` tokens.
 */
export function parameterize(task, steps) {
  const taskText = String(task ?? '');
  const lower = taskText.toLowerCase();

  const seen = new Map();
  let out = steps;
  let template = taskText;

  for (const step of steps) {
    for (const literal of literalsOf(step)) {
      const trimmed = literal.trim();
      if (seen.has(trimmed)) continue;
      // Only a literal the user actually said is a parameter; anything else is
      // an implementation detail of this particular run.
      if (!lower.includes(trimmed.toLowerCase())) continue;

      const name = seen.size === 0 ? 'value' : `value${seen.size + 1}`;
      seen.set(trimmed, name);

      const token = `{{${name}}}`;
      out = out.map((s) => replaceLiteral(s, trimmed, token));
      template = template.replace(new RegExp(escapeRe(trimmed), 'i'), token);
    }
  }

  const params = [...seen.entries()].map(([example, name]) => ({ name, example }));
  return { template, params, steps: out };
}

/**
 * Does `task` fit this skill's template, and with what values?
 *
 * The template is matched as ordered literal segments with free text between
 * them, so "open youtube and search for {{value}}" accepts any query while
 * still refusing an unrelated task.
 *
 * @returns {object|null} parameter values, or null if it does not match.
 */
export function matchTemplate(template, task) {
  const text = String(task ?? '').trim();
  if (!text) return null;

  const names = [...String(template ?? '').matchAll(PLACEHOLDER)].map((m) => m[1]);
  if (!names.length) {
    return normalizeTask(template) === normalizeTask(text) ? {} : null;
  }

  const pattern = String(template)
    .split(PLACEHOLDER)
    // split() with a capturing group interleaves literals and names.
    .map((part, i) => (i % 2 === 1 ? '(.+?)' : escapeRe(part.trim())))
    .join('\\s*');

  const match = new RegExp(`^\\s*${pattern}\\s*$`, 'i').exec(text);
  if (!match) return null;

  const values = {};
  names.forEach((name, i) => { values[name] = (match[i + 1] || '').trim(); });
  // An empty capture means the caller said nothing where a value belongs.
  return Object.values(values).every((v) => v.length) ? values : null;
}

/** Fill `{{name}}` tokens in a skill's steps with concrete values. */
export function applyParams(steps, values = {}) {
  const fill = (v) => (typeof v === 'string'
    ? v.replace(PLACEHOLDER, (whole, name) => (name in values ? values[name] : whole))
    : v);

  return steps.map((step) => {
    const next = { ...step };
    if (typeof next.label === 'string') next.label = fill(next.label);
    if (next.input) {
      next.input = { ...next.input };
      for (const [k, v] of Object.entries(next.input)) next.input[k] = fill(v);
    }
    return next;
  });
}

/**
 * Trace → skill, or null when the run left nothing worth replaying.
 */
export function distill(trace, { id } = {}) {
  const raw = extractSteps(trace);
  if (!raw.length) return null;

  const task = String(trace?.task || '').trim();
  if (!task) return null;

  const { template, params, steps } = parameterize(task, raw);

  return {
    id: id || `sk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name: task.slice(0, 80),
    task,
    template,
    normalized: normalizeTask(template),
    app: trace?.steps?.find((s) => s.appPackage)?.appPackage || null,
    params,
    steps
  };
}
