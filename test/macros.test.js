import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateMacro,
  saveMacro,
  getMacroById,
  deleteMacro,
  executeMacro
} from '../server/macros.js';

test('validateMacro accepts a well-formed macro', () => {
  assert.doesNotThrow(() => validateMacro({
    name: 'Night Mode',
    description: 'dim + mute',
    steps: [{ command: 'brightness low', delay: 1000 }, { command: 'mute' }]
  }));
});

test('validateMacro rejects malformed macros', () => {
  assert.throws(() => validateMacro({ steps: [{ command: 'x' }] }), /format/i);          // no name
  assert.throws(() => validateMacro({ name: 'x', steps: [] }), /format/i);               // no steps
  assert.throws(() => validateMacro({ name: 'x', steps: [{ command: '' }] }), /format/i); // empty command
  assert.throws(() => validateMacro({ name: 'x', steps: [{ command: 'a', delay: 999999 }] }), /format/i); // delay too big
  assert.throws(() => validateMacro({ name: 'x', steps: [{ command: 'a' }], bogus: 1 }), /format/i); // extra prop
  assert.throws(() => validateMacro({
    name: 'x', steps: Array.from({ length: 51 }, () => ({ command: 'a' }))
  }), /format/i); // > 50 steps
});

test('executeMacro runs steps in order through the injected runner', async () => {
  const id = `__test_${Date.now()}`;
  saveMacro({
    id,
    name: 'Test Seq',
    steps: [
      { command: 'step one', delay: 0 },
      { command: 'step two', delay: 0 },
      { command: 'step three', delay: 0 }
    ]
  });
  try {
    const ran = [];
    const progress = [];
    const result = await executeMacro(
      id,
      async (cmd) => { ran.push(cmd); },
      (s) => progress.push(`${s.stepIndex}:${s.status}`)
    );

    assert.deepEqual(ran, ['step one', 'step two', 'step three']);
    assert.equal(result.success, true);
    assert.equal(result.successCount, 3);
    assert.ok(progress.includes('0:executing'));
    assert.ok(progress.includes('2:success'));
  } finally {
    deleteMacro(id);
  }
});

test('executeMacro reports a failing step without aborting the rest', async () => {
  const id = `__test_${Date.now()}_b`;
  saveMacro({ id, name: 'Test Fail', steps: [{ command: 'ok1' }, { command: 'boom' }, { command: 'ok2' }] });
  try {
    const ran = [];
    const result = await executeMacro(id, async (cmd) => {
      ran.push(cmd);
      if (cmd === 'boom') throw new Error('kaboom');
    }, () => {});
    assert.deepEqual(ran, ['ok1', 'boom', 'ok2']);
    assert.equal(result.success, false);
    assert.equal(result.successCount, 2);
  } finally {
    deleteMacro(id);
  }
});

test('validateMacro accepts a learned agent macro', () => {
  assert.doesNotThrow(() => validateMacro({
    name: 'Learned run',
    kind: 'agent',
    steps: [{ command: 'replay 2 recorded actions', delay: 0 }],
    primitives: [
      { name: 'tap_xy', input: { x: 0.5, y: 0.5 }, label: 'Go' },
      { name: 'type_text', input: { text: 'hi' } }
    ]
  }));
});

test('validateMacro rejects malformed agent macros', () => {
  const base = { name: 'x', steps: [{ command: 'replay' }] };
  assert.throws(() => validateMacro({ ...base, kind: 'nonsense' }), /format/i);
  assert.throws(() => validateMacro({ ...base, kind: 'agent', primitives: [] }), /format/i);
  assert.throws(() => validateMacro({ ...base, kind: 'agent', primitives: [{ input: {} }] }), /format/i); // no name
  assert.throws(() => validateMacro({ ...base, kind: 'agent', primitives: [{ name: 'tap_xy', bogus: 1 }] }), /format/i);
});

test('saveMacro defaults kind to command and drops an empty primitives list', () => {
  const id = `__test_${Date.now()}_kind`;
  saveMacro({ id, name: 'Plain', steps: [{ command: 'mute' }], primitives: [] });
  try {
    const stored = getMacroById(id);
    assert.equal(stored.kind, 'command');
    assert.equal(stored.primitives, undefined);
  } finally {
    deleteMacro(id);
  }
});

test('an agent macro replays primitives and never touches the command path', async () => {
  const id = `__test_${Date.now()}_agent`;
  saveMacro({
    id,
    name: 'Agent Replay',
    kind: 'agent',
    steps: [{ command: 'replay 2 recorded actions', delay: 0 }],
    primitives: [
      { name: 'tap_xy', input: { x: 0.5, y: 0.5 }, label: 'Go', delay: 0 },
      { name: 'type_text', input: { text: 'hi' }, label: 'Type "hi"', delay: 0 }
    ]
  });
  try {
    const commands = [];
    const primitives = [];
    const progress = [];
    const result = await executeMacro(
      id,
      async (c) => commands.push(c),
      (s) => progress.push(`${s.stepIndex}:${s.status}`),
      async (name, input) => primitives.push({ name, input })
    );

    assert.equal(commands.length, 0, 'the NLP path is not used');
    assert.deepEqual(primitives.map((p) => p.name), ['tap_xy', 'type_text']);
    assert.deepEqual(primitives[0].input, { x: 0.5, y: 0.5 });
    assert.equal(result.success, true);
    assert.equal(result.totalSteps, 2);
    assert.ok(progress.includes('1:success'));
  } finally {
    deleteMacro(id);
  }
});

test('an agent macro reports clearly when no primitive executor is available', async () => {
  const id = `__test_${Date.now()}_noexec`;
  saveMacro({
    id,
    name: 'Agent NoExec',
    kind: 'agent',
    steps: [{ command: 'replay', delay: 0 }],
    primitives: [{ name: 'tap_xy', input: { x: 0.5, y: 0.5 } }]
  });
  try {
    const result = await executeMacro(id, async () => {}, null);
    assert.equal(result.success, false);
    assert.match(result.error, /recorded actions/);
  } finally {
    deleteMacro(id);
  }
});

test('a failing primitive is reported without aborting the replay', async () => {
  const id = `__test_${Date.now()}_pfail`;
  saveMacro({
    id,
    name: 'Agent Fail',
    kind: 'agent',
    steps: [{ command: 'replay', delay: 0 }],
    primitives: [
      { name: 'tap_xy', input: { x: 0.1, y: 0.1 }, delay: 0 },
      { name: 'boom', input: {}, delay: 0 },
      { name: 'tap_xy', input: { x: 0.2, y: 0.2 }, delay: 0 }
    ]
  });
  try {
    const result = await executeMacro(id, async () => {}, null, async (name) => {
      if (name === 'boom') throw new Error('primitive failed');
    });
    assert.equal(result.success, false);
    assert.equal(result.totalSteps, 3);
    assert.equal(result.successCount, 2, 'the replay continues past a failure');
  } finally {
    deleteMacro(id);
  }
});

test('getMacroById / deleteMacro round-trip', () => {
  const id = `__test_${Date.now()}_c`;
  saveMacro({ id, name: 'RoundTrip', steps: [{ command: 'home' }] });
  assert.equal(getMacroById(id)?.name, 'RoundTrip');
  assert.equal(deleteMacro(id).success, true);
  assert.equal(getMacroById(id), null);
});
