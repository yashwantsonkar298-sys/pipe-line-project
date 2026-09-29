import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractSteps,
  parameterize,
  matchTemplate,
  applyParams,
  distill
} from '../server/skills/distill.js';

const trace = (task, steps) => ({ task, steps });
const ok = (step) => ({ outcome: 'ok', ...step });

test('extractSteps keeps the label so a tap can be re-resolved later', () => {
  const steps = extractSteps(trace('x', [
    ok({ name: 'tap_element', target: { label: 'Airplane mode', nx: 0.86, ny: 0.29 }, description: 'Tap Airplane mode' })
  ]));

  assert.equal(steps.length, 1);
  assert.equal(steps[0].name, 'tap_element');
  assert.equal(steps[0].label, 'Airplane mode');
  // Coordinates survive only as a fallback, not as the primary target.
  assert.deepEqual(steps[0].fallback, { x: 0.86, y: 0.29 });
});

test('extractSteps drops failed steps and non-replayable primitives', () => {
  const steps = extractSteps(trace('x', [
    ok({ name: 'screenshot' }),
    { outcome: 'error', name: 'tap_element', target: { label: 'Nope', nx: 0.1, ny: 0.1 } },
    ok({ name: 'press_key', input: { key: 'back' } }),
    ok({ name: 'finish', input: {} })
  ]));

  assert.deepEqual(steps.map((s) => s.name), ['press_key']);
});

test('extractSteps skips a tap with neither label nor coordinates', () => {
  const steps = extractSteps(trace('x', [ok({ name: 'tap_element', target: {} })]));
  assert.equal(steps.length, 0);
});

test('parameterize lifts typed text that the user actually asked for', () => {
  const raw = [
    { name: 'open_app', input: { appName: 'YouTube' }, description: 'Open YouTube' },
    { name: 'type_text', input: { text: 'lofi beats' }, description: 'Type lofi beats' }
  ];
  const { template, params, steps } = parameterize('open YouTube and search for lofi beats', raw);

  assert.match(template, /\{\{value\d*\}\}/);
  assert.ok(params.length >= 1);
  const typed = steps.find((s) => s.name === 'type_text');
  assert.match(typed.input.text, /^\{\{value\d*\}\}$/);
});

test('a tap label that echoes a word in the task is not a parameter', () => {
  // Regression: "open YouTube and search for lofi beats" taps a button labelled
  // "Search". Treating that coincidence as a variable produced the template
  // "open {{a}} and {{b}} for {{c}}", which matched almost nothing.
  const raw = [
    { name: 'open_app', input: { appName: 'YouTube' } },
    { name: 'tap_element', label: 'Search' },
    { name: 'type_text', input: { text: 'lofi beats' } }
  ];
  const { template, params } = parameterize('open YouTube and search for lofi beats', raw);

  assert.equal(params.length, 1, 'only the typed query is a parameter');
  assert.equal(template, 'open YouTube and search for {{value}}');
});

test('an app name is not a parameter — a different app is a different screen', () => {
  const raw = [{ name: 'open_app', input: { appName: 'YouTube' } }];
  const { params, steps } = parameterize('open YouTube', raw);

  assert.equal(params.length, 0);
  assert.equal(steps[0].input.appName, 'YouTube');
});

test('parameterize leaves literals the user never mentioned alone', () => {
  const raw = [{ name: 'tap_element', label: 'Network & internet', description: 'Tap' }];
  const { params, steps } = parameterize('turn on airplane mode', raw);

  assert.equal(params.length, 0);
  assert.equal(steps[0].label, 'Network & internet');
});

test('matchTemplate fills a parameter from a new task', () => {
  const values = matchTemplate('open YouTube and search for {{value}}', 'open YouTube and search for jazz piano');
  assert.deepEqual(values, { value: 'jazz piano' });
});

test('matchTemplate refuses an unrelated task', () => {
  assert.equal(matchTemplate('open YouTube and search for {{value}}', 'turn on the flashlight'), null);
});

test('matchTemplate refuses a task with the value missing', () => {
  assert.equal(matchTemplate('open YouTube and search for {{value}}', 'open YouTube and search for'), null);
});

test('matchTemplate on a parameterless skill compares normalized text', () => {
  assert.deepEqual(matchTemplate('turn on airplane mode', 'airplane mode on'), {});
  assert.equal(matchTemplate('turn on airplane mode', 'turn on bluetooth'), null);
});

test('applyParams substitutes into both labels and inputs', () => {
  const steps = applyParams([
    { name: 'type_text', input: { text: '{{value}}' } },
    { name: 'tap_element', label: 'Search {{value}}' }
  ], { value: 'jazz' });

  assert.equal(steps[0].input.text, 'jazz');
  assert.equal(steps[1].label, 'Search jazz');
});

test('applyParams leaves unknown placeholders untouched rather than blanking them', () => {
  const steps = applyParams([{ name: 'type_text', input: { text: '{{missing}}' } }], {});
  assert.equal(steps[0].input.text, '{{missing}}');
});

test('distill produces a matchable, replayable skill end to end', () => {
  const skill = distill(trace('open YouTube and search for lofi beats', [
    ok({ name: 'open_app', input: { appName: 'YouTube' }, appPackage: 'com.google.android.youtube' }),
    ok({ name: 'tap_element', target: { label: 'Search', nx: 0.9, ny: 0.1 } }),
    ok({ name: 'type_text', input: { text: 'lofi beats' } })
  ]));

  assert.ok(skill, 'a skill should be produced');
  assert.equal(skill.app, 'com.google.android.youtube');

  // The whole point: a different query reuses the same recording.
  const values = matchTemplate(skill.template, 'open YouTube and search for tabla solo');
  assert.ok(values, 'a new query should match the learned template');

  const steps = applyParams(skill.steps, values);
  assert.equal(steps.find((s) => s.name === 'type_text').input.text, 'tabla solo');
});

test('distill returns null when a run replayed nothing', () => {
  assert.equal(distill(trace('look at the screen', [ok({ name: 'screenshot' })])), null);
  assert.equal(distill(trace('', [ok({ name: 'press_key', input: { key: 'back' } })])), null);
});
