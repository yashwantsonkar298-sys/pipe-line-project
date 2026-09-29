import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import {
  createTrace,
  newRunId,
  assertRunId,
  getTrace,
  listTraces,
  getStepImagePath,
  traceToMacro
} from '../server/agent/trace.js';
import { TRACES_DIR } from '../server/config/index.js';
import { validateMacro, MACRO_SCHEMA } from '../server/macros.js';
import { validateJsonSchema } from '../server/security.js';

// A 1x1 PNG, so the screenshot path is exercised without a device.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const created = [];
function freshTrace() {
  const t = createTrace(`test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  created.push(t.runId);
  return t;
}

test.after(() => {
  for (const runId of created) {
    try { fs.rmSync(path.join(TRACES_DIR, runId), { recursive: true, force: true }); } catch {  }
  }
});

test('run ids are validated against path traversal', () => {
  assert.equal(assertRunId('run_123_abc'), 'run_123_abc');
  for (const bad of ['../escape', 'a/b', 'a\\b', '', 'x'.repeat(65), null, 'has space']) {
    assert.throws(() => assertRunId(bad), /Invalid trace id/, String(bad));
  }
});

test('newRunId produces an id that passes validation', () => {
  assert.doesNotThrow(() => assertRunId(newRunId()));
});

test('a trace records the task, steps and result and reads back', () => {
  const trace = freshTrace();
  trace.start({ task: 'turn on airplane mode', subgoals: ['Open Settings', 'Toggle it'], dryRun: false });
  trace.step({
    step: 1, thought: 'opening settings', description: 'Open Settings',
    outcome: 'ok', name: 'open_app', input: { appName: 'Settings' },
    state: { appPackage: 'com.android.settings' }
  });
  trace.step({
    step: 2, thought: 'tapping the toggle', description: 'Tap "Airplane mode"',
    outcome: 'ok', name: 'tap_element', input: { index: 4 },
    target: { index: 4, label: 'Airplane mode', nx: 0.86, ny: 0.3 },
    state: { appPackage: 'com.android.settings' }
  });
  trace.finish({ ok: true, reason: 'finished', summary: 'Airplane mode is on', steps: 2, costUsd: 0.012 });

  const stored = getTrace(trace.runId);
  assert.equal(stored.task, 'turn on airplane mode');
  assert.deepEqual(stored.subgoals, ['Open Settings', 'Toggle it']);
  assert.equal(stored.steps.length, 2);
  assert.equal(stored.steps[1].target.label, 'Airplane mode');
  assert.equal(stored.result.ok, true);
  assert.equal(stored.result.costUsd, 0.012);
  assert.ok(stored.finishedAt >= stored.startedAt);
});

test('a step with a screenshot writes a png that can be served back', () => {
  const trace = freshTrace();
  trace.start({ task: 'look' });
  trace.step({ step: 1, description: 'Look', outcome: 'ok', name: 'screenshot', state: { imageB64: PNG_B64 } });
  trace.finish({ ok: true, summary: 'seen' });

  const stored = getTrace(trace.runId);
  assert.equal(stored.steps[0].screenshot, 'step01.png');

  const file = getStepImagePath(trace.runId, 1);
  assert.ok(file && fs.existsSync(file));
  assert.ok(fs.readFileSync(file).length > 0);
});

test('a step without a screenshot reports no image', () => {
  const trace = freshTrace();
  trace.start({ task: 'x' });
  trace.step({ step: 1, description: 'Wait', outcome: 'ok', name: 'wait', input: { ms: 100 }, state: {} });
  trace.finish({ ok: true, summary: 'done' });

  assert.equal(getStepImagePath(trace.runId, 1), null);
  assert.equal(getStepImagePath(trace.runId, 99), null);
});

test('getTrace returns null for an unknown run', () => {
  assert.equal(getTrace('test_does_not_exist'), null);
});

test('listTraces includes a finished run with a summary but no step detail', () => {
  const trace = freshTrace();
  trace.start({ task: 'listed run' });
  trace.step({ step: 1, description: 'Wait', outcome: 'ok', name: 'wait', input: { ms: 1 }, state: {} });
  trace.finish({ ok: true, summary: 'done', steps: 1 });

  const row = listTraces().find((t) => t.runId === trace.runId);
  assert.ok(row, 'the run is listed');
  assert.equal(row.task, 'listed run');
  assert.equal(row.stepCount, 1);
  assert.equal(row.result.ok, true);
  assert.equal(row.steps, undefined, 'the listing stays lightweight');
});

test('traceToMacro rewrites element taps as coordinate taps', () => {
  const trace = freshTrace();
  trace.start({ task: 'search lofi' });
  trace.step({ step: 1, description: 'Open YouTube', outcome: 'ok', name: 'open_app', input: { appName: 'YouTube' }, state: {} });
  trace.step({
    step: 2, description: 'Tap "Search"', outcome: 'ok', name: 'tap_element', input: { index: 3 },
    target: { index: 3, label: 'Search', nx: 0.9, ny: 0.06 }, state: {}
  });
  trace.step({ step: 3, description: 'Type "lofi"', outcome: 'ok', name: 'type_text', input: { text: 'lofi' }, state: {} });
  trace.finish({ ok: true, summary: 'searched' });

  const macro = traceToMacro(trace.runId, { name: 'Lofi search' });
  assert.equal(macro.kind, 'agent');
  assert.equal(macro.name, 'Lofi search');
  assert.deepEqual(macro.primitives.map((p) => p.name), ['open_app', 'tap_xy', 'type_text']);
  assert.deepEqual(macro.primitives[1].input, { x: 0.9, y: 0.06 });
  assert.equal(macro.primitives[1].label, 'Search');
});

test('traceToMacro skips failed, blocked and non-replayable steps', () => {
  const trace = freshTrace();
  trace.start({ task: 'messy run' });
  trace.step({ step: 1, description: 'Wait', outcome: 'ok', name: 'wait', input: { ms: 500 }, state: {} });
  trace.step({ step: 2, description: 'Tap X', outcome: 'failed', name: 'tap_element', input: { index: 1 }, target: { index: 1, nx: 0.1, ny: 0.1 }, state: {} });
  trace.step({ step: 3, description: 'Type otp', outcome: 'blocked', name: 'type_text', input: { text: '1234' }, state: {} });
  trace.step({ step: 4, description: 'Screenshot', outcome: 'ok', name: 'screenshot', input: {}, state: {} });
  trace.step({ step: 5, description: 'Finish', outcome: 'ok', name: 'finish', input: {}, state: {} });
  trace.finish({ ok: true, summary: 'done' });

  const macro = traceToMacro(trace.runId);
  assert.deepEqual(macro.primitives.map((p) => p.name), ['wait']);
});

test('traceToMacro refuses a run with nothing replayable', () => {
  const trace = freshTrace();
  trace.start({ task: 'nothing happened' });
  trace.step({ step: 1, description: 'Finish', outcome: 'ok', name: 'finish', input: {}, state: {} });
  trace.finish({ ok: false, summary: 'nope' });

  assert.throws(() => traceToMacro(trace.runId), /no replayable steps/);
  assert.throws(() => traceToMacro('test_missing_run'), /Trace not found/);
});

test('a macro produced from a trace is schema-valid', () => {
  const trace = freshTrace();
  trace.start({ task: 'valid macro' });
  trace.step({
    step: 1, description: 'Tap "Go"', outcome: 'ok', name: 'tap_element', input: { index: 0 },
    target: { index: 0, label: 'Go', nx: 0.5, ny: 0.5 }, state: {}
  });
  trace.finish({ ok: true, summary: 'done' });

  const macro = traceToMacro(trace.runId);
  assert.doesNotThrow(() => validateMacro(macro));
  assert.equal(validateJsonSchema(macro, MACRO_SCHEMA).valid, true);
});

test('legacy natural-language macros still validate', () => {
  const legacy = {
    name: 'Night Mode',
    description: 'dim and mute',
    steps: [{ command: 'brightness low', delay: 1000 }, { command: 'mute' }],
    schedule: null
  };
  assert.doesNotThrow(() => validateMacro(legacy));
});

// NOTE: macro *execution* is covered in test/macros.test.js. Those tests share
// server/macros.json, and `node --test` runs test files in parallel processes,
// so they must all live in one file to avoid racing on that store.
