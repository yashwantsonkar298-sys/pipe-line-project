/**
 * Run traces: every agent run is recorded step by step so it can be reviewed,
 * replayed, and — when it worked — frozen into a deterministic macro that needs
 * no model call at all.
 *
 * Layout: `<TRACES_DIR>/<runId>/trace.json` plus `stepNN.png` for the steps
 * where a screenshot was actually taken.
 */

import fs from 'fs';
import path from 'path';

import { TRACES_DIR, ensureTracesDir } from '../config/index.js';

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TRACES = 50;

/** Reject anything that could escape the traces directory. */
export function assertRunId(id) {
  if (typeof id !== 'string' || !RUN_ID.test(id)) {
    throw new Error(`Invalid trace id: ${JSON.stringify(id)}`);
  }
  return id;
}

export function newRunId() {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function traceDir(runId) {
  return path.join(TRACES_DIR, assertRunId(runId));
}

function tracePath(runId) {
  return path.join(traceDir(runId), 'trace.json');
}

/** Keep the traces directory from growing without bound. */
function pruneOldTraces() {
  try {
    const entries = fs.readdirSync(TRACES_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && RUN_ID.test(e.name))
      .map((e) => ({ name: e.name, at: fs.statSync(path.join(TRACES_DIR, e.name)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const stale of entries.slice(MAX_TRACES)) {
      fs.rmSync(path.join(TRACES_DIR, stale.name), { recursive: true, force: true });
    }
  } catch {  }
}

/**
 * A recorder for one run. Every method is failure-tolerant: a broken disk must
 * never take down a run that is otherwise working.
 */
export function createTrace(runId = newRunId()) {
  assertRunId(runId);
  const dir = traceDir(runId);
  const record = {
    runId,
    task: '',
    subgoals: [],
    dryRun: false,
    startedAt: Date.now(),
    finishedAt: null,
    result: null,
    steps: []
  };

  const flush = () => {
    try {
      ensureTracesDir();
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tracePath(runId), JSON.stringify(record, null, 2));
    } catch {  }
  };

  return {
    runId,
    get record() { return record; },

    start({ task, subgoals, dryRun } = {}) {
      record.task = String(task || '');
      record.subgoals = Array.isArray(subgoals) ? subgoals : [];
      record.dryRun = Boolean(dryRun);
      flush();
    },

    step({ step, thought, description, outcome, detail, reason, name, input, target, state } = {}) {
      const entry = {
        step: Number(step) || record.steps.length + 1,
        at: Date.now(),
        thought: String(thought || ''),
        description: String(description || ''),
        outcome: String(outcome || 'ok'),
        detail: detail ? String(detail) : undefined,
        reason: reason ? String(reason) : undefined,
        name: name || undefined,
        input: input || undefined,
        appPackage: state?.appPackage || null,
        target: target ? { index: target.index, label: target.label, nx: target.nx, ny: target.ny } : null,
        screenshot: null
      };

      if (state?.imageB64) {
        const file = `step${String(entry.step).padStart(2, '0')}.png`;
        try {
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, file), Buffer.from(state.imageB64, 'base64'));
          entry.screenshot = file;
        } catch {  }
      }

      record.steps.push(entry);
      flush();
      return entry;
    },

    finish(result = {}) {
      record.finishedAt = Date.now();
      record.result = {
        ok: Boolean(result.ok),
        reason: result.reason || null,
        summary: result.summary || '',
        steps: result.steps ?? record.steps.length,
        costUsd: result.costUsd ?? 0
      };
      flush();
      pruneOldTraces();
      return record;
    }
  };
}

/** Newest first, without the per-step detail. */
export function listTraces() {
  try {
    if (!fs.existsSync(TRACES_DIR)) return [];
    return fs.readdirSync(TRACES_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && RUN_ID.test(e.name))
      .map((e) => {
        try {
          const t = JSON.parse(fs.readFileSync(path.join(TRACES_DIR, e.name, 'trace.json'), 'utf8'));
          return {
            runId: t.runId,
            task: t.task,
            startedAt: t.startedAt,
            finishedAt: t.finishedAt,
            stepCount: (t.steps || []).length,
            result: t.result
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  } catch {
    return [];
  }
}

export function getTrace(runId) {
  try {
    return JSON.parse(fs.readFileSync(tracePath(runId), 'utf8'));
  } catch {
    return null;
  }
}

/** Absolute path to one step's screenshot, or null if that step has none. */
export function getStepImagePath(runId, stepNumber) {
  const trace = getTrace(runId);
  const entry = trace?.steps?.find((s) => s.step === Number(stepNumber));
  if (!entry?.screenshot) return null;
  const file = path.join(traceDir(runId), path.basename(entry.screenshot));
  return fs.existsSync(file) ? file : null;
}

/** Actions that change the device and can therefore be replayed verbatim. */
const REPLAYABLE = new Set(['tap_element', 'tap_xy', 'type_text', 'swipe', 'press_key', 'open_app', 'wait']);

/**
 * Freeze a successful run into a deterministic macro.
 *
 * Element indices are meaningless on a later run, so `tap_element` steps are
 * rewritten as `tap_xy` using the normalized centre recorded at the time.
 */
export function traceToMacro(runId, { name } = {}) {
  const trace = getTrace(runId);
  if (!trace) throw new Error('Trace not found');

  const primitives = [];
  for (const step of trace.steps || []) {
    if (step.outcome !== 'ok' || !REPLAYABLE.has(step.name)) continue;

    if (step.name === 'tap_element') {
      if (!step.target || typeof step.target.nx !== 'number') continue;
      primitives.push({
        name: 'tap_xy',
        input: { x: step.target.nx, y: step.target.ny },
        label: step.target.label || step.description
      });
    } else {
      primitives.push({ name: step.name, input: step.input || {}, label: step.description });
    }
  }

  if (!primitives.length) throw new Error('This run has no replayable steps');

  return {
    name: String(name || trace.task || 'Agent run').slice(0, 80),
    description: `Learned from agent run ${trace.runId}`.slice(0, 200),
    kind: 'agent',
    primitives,
    steps: [{ command: `replay ${primitives.length} recorded actions`, delay: 0 }]
  };
}
