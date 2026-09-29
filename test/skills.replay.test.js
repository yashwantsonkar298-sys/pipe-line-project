import test from 'node:test';
import assert from 'node:assert/strict';

import { replaySkill, findElement } from '../server/skills/replay.js';

const el = (index, label, extra = {}) => ({
  index,
  label,
  className: 'android.widget.Button',
  clickable: true,
  bounds: { cx: 100 + index, cy: 200 + index },
  ...extra
});

/** Perception that hands back a fixed screen, counting how often it is asked. */
function fakePerception(elements, { appPackage = 'com.android.settings' } = {}) {
  const calls = { count: 0 };
  return {
    calls,
    captureState: async () => {
      calls.count++;
      return { elements, appPackage, width: 1080, height: 2400 };
    }
  };
}

function fakeTools({ fail = null } = {}) {
  const ran = [];
  return {
    ran,
    resolveTarget: (name, input, state) =>
      (state.elements || []).find((e) => e.index === Number(input?.index)) || null,
    runPrimitive: async (name, input) => {
      ran.push({ name, input });
      if (fail && fail.name === name) return { ok: false, detail: fail.detail || 'nope' };
      return { ok: true, detail: `${name} ok` };
    }
  };
}

const skill = (steps, name = 'Test skill') => ({ id: 'sk1', name, steps });

test('re-resolves a recorded label to its current index, not its old position', async () => {
  // Recorded at index 3; the row has since moved to index 7.
  const perception = fakePerception([el(1, 'Wi-Fi'), el(7, 'Airplane mode')]);
  const tools = fakeTools();

  const result = await replaySkill(
    skill([{ name: 'tap_element', label: 'Airplane mode', fallback: { x: 0.5, y: 0.9 } }]),
    {},
    { perception, tools, deviceId: 'd1' }
  );

  assert.equal(result.ok, true);
  assert.equal(tools.ran.length, 1);
  assert.equal(tools.ran[0].name, 'tap_element');
  assert.equal(tools.ran[0].input.index, 7, 'should tap the label where it is now');
});

test('falls back to recorded coordinates when the label is gone', async () => {
  const perception = fakePerception([el(1, 'Something else')]);
  const tools = fakeTools();
  const notes = [];

  const result = await replaySkill(
    skill([{ name: 'tap_element', label: 'Airplane mode', fallback: { x: 0.5, y: 0.9 } }]),
    {},
    { perception, tools, deviceId: 'd1', onEvent: (e) => notes.push(e) }
  );

  assert.equal(result.ok, true);
  assert.equal(tools.ran[0].name, 'tap_xy');
  assert.deepEqual(tools.ran[0].input, { x: 0.5, y: 0.9 });
  assert.ok(notes.some((n) => n.type === 'skill_replay_note'));
});

test('reports drift instead of tapping blind when there is no fallback', async () => {
  const perception = fakePerception([el(1, 'Something else')]);
  const tools = fakeTools();

  const result = await replaySkill(
    skill([{ name: 'tap_element', label: 'Airplane mode', fallback: null }]),
    {},
    { perception, tools, deviceId: 'd1' }
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'drift');
  assert.equal(tools.ran.length, 0, 'nothing should have been tapped');
});

test('the safety gate still runs — a blocked step is not replayed', async () => {
  // Typing into the focused password field is BLOCK in the classifier's truth
  // table. Replay passes the *live* state, so the field it guards against is
  // the one focused right now, not the one recorded last week.
  const perception = fakePerception([
    el(2, 'Password', { className: 'android.widget.EditText', password: true, focused: true })
  ]);
  const tools = fakeTools();

  const result = await replaySkill(
    skill([{ name: 'type_text', input: { text: 'hunter2' } }]),
    {},
    { perception, tools, deviceId: 'd1' }
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'blocked');
  assert.equal(tools.ran.length, 0);
});

test('a confirm-risk step is declined when no confirmer is wired', async () => {
  const perception = fakePerception([el(1, 'Place order')]);
  const tools = fakeTools();

  const result = await replaySkill(
    skill([{ name: 'tap_element', label: 'Place order', fallback: { x: 0.5, y: 0.5 } }]),
    {},
    { perception, tools, deviceId: 'd1', confirm: null }
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'declined');
  assert.equal(tools.ran.length, 0);
});

test('a confirm-risk step runs once approved', async () => {
  const perception = fakePerception([el(1, 'Place order')]);
  const tools = fakeTools();

  const result = await replaySkill(
    skill([{ name: 'tap_element', label: 'Place order', fallback: { x: 0.5, y: 0.5 } }]),
    {},
    { perception, tools, deviceId: 'd1', confirm: async () => true }
  );

  assert.equal(result.ok, true);
  assert.equal(tools.ran.length, 1);
});

test('dry run narrates every step and touches nothing', async () => {
  const perception = fakePerception([el(1, 'Airplane mode')]);
  const tools = fakeTools();

  const result = await replaySkill(
    skill([
      { name: 'tap_element', label: 'Airplane mode', fallback: { x: 0, y: 0 } },
      { name: 'press_key', input: { key: 'home' } }
    ]),
    {},
    { perception, tools, deviceId: 'd1', dryRun: true }
  );

  assert.equal(result.ok, true);
  assert.equal(tools.ran.length, 0);
  assert.equal(result.actions.length, 2);
  assert.ok(result.actions.every((a) => a.outcome === 'dry_run'));
});

test('parameters are substituted into the replayed steps', async () => {
  const perception = fakePerception([el(1, 'Search')]);
  const tools = fakeTools();

  const result = await replaySkill(
    skill([{ name: 'type_text', input: { text: '{{value}}' } }]),
    { value: 'tabla solo' },
    { perception, tools, deviceId: 'd1' }
  );

  assert.equal(result.ok, true);
  assert.equal(tools.ran[0].input.text, 'tabla solo');
});

test('stops at the first failing step rather than ploughing on', async () => {
  const perception = fakePerception([el(1, 'A'), el(2, 'B')]);
  const tools = fakeTools({ fail: { name: 'press_key', detail: 'key rejected' } });

  const result = await replaySkill(
    skill([
      { name: 'press_key', input: { key: 'back' } },
      { name: 'tap_element', label: 'A', fallback: { x: 0, y: 0 } }
    ]),
    {},
    { perception, tools, deviceId: 'd1' }
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'failed');
  assert.equal(tools.ran.length, 1, 'the second step must not run');
});

test('re-observes between steps so later taps see the new screen', async () => {
  const perception = fakePerception([el(1, 'A'), el(2, 'B')]);
  const tools = fakeTools();

  await replaySkill(
    skill([
      { name: 'tap_element', label: 'A', fallback: { x: 0, y: 0 } },
      { name: 'tap_element', label: 'B', fallback: { x: 0, y: 0 } }
    ]),
    {},
    { perception, tools, deviceId: 'd1' }
  );

  // Once up front, once after the screen-changing first tap.
  assert.equal(perception.calls.count, 2);
});

test('findElement tolerates a label that gained a suffix', () => {
  const found = findElement('Airplane mode', [el(4, 'Airplane mode, off')]);
  assert.equal(found.index, 4);
});

test('findElement refuses to guess between two similar labels', () => {
  assert.equal(findElement('Wi', [el(1, 'Wi-Fi'), el(2, 'Wi-Fi calling')]), null);
});
