/**
 * The skill library wired through the agent loop.
 *
 * These cover the seam the unit tests cannot: that recall short-circuits the
 * model entirely, that hints reach the planning prompt, and that a successful
 * run is handed to `learn` — using the loop's real code path with fakes on
 * either side of it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { runAgentTask } from '../server/agent/agentLoop.js';
import { NULL_SKILLS } from '../server/skills/index.js';

function fakeClient(script) {
  let i = 0;
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params);
        if (i >= script.length) throw new Error('fakeClient: script exhausted');
        return script[i++];
      }
    }
  };
}

const planResp = (lines) => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: lines.map((l) => `- ${l}`).join('\n') }],
  usage: { input_tokens: 100, output_tokens: 20 }
});

const actResp = (name, input = {}) => ({
  stop_reason: 'tool_use',
  content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name, input }],
  usage: { input_tokens: 200, output_tokens: 20 }
});

const state = {
  elements: [{ index: 0, label: 'Search', kind: 'button', clickable: true, bounds: { cx: 10, cy: 20 }, box: {} }],
  width: 1080, height: 2400, appPackage: 'com.example', degraded: false, imageB64: null
};

const perception = {
  captureState: async () => state,
  screenSignature: () => Math.random().toString(36),
  serializeForModel: () => 'screen',
  overlayElements: () => []
};

const tools = {
  buildAgentTools: () => [],
  resolveTarget: () => state.elements[0],
  runPrimitive: async (name, input) => {
    // `finish` reports through `control`, not through `ok` — without it the loop
    // has no way to know the task is over and just runs to its step cap.
    if (name === 'finish') {
      return { ok: true, detail: input.summary, control: { finish: { success: input.success, summary: input.summary } } };
    }
    return { ok: true, detail: `${name} ok` };
  }
};

const baseConfig = { agentMaxSteps: 6, agentCostCapUsd: 1, agentDryRun: false, agentAppAllowlist: [] };

/** Captures what the loop hands back to the library. */
function spySkills(recallResult) {
  const learned = [];
  const uses = [];
  return {
    learned,
    uses,
    recall: async () => recallResult,
    learn: async (record, payload) => { learned.push({ record, payload }); return { id: 'sk1' }; },
    formatHints: (similar) => (similar?.length ? `HINTS:${similar.length}` : ''),
    store: { recordUse: (id, ok) => uses.push({ id, ok }) }
  };
}

const fakeTrace = () => {
  const record = { task: '', steps: [], dryRun: false };
  return {
    runId: 'r1',
    start: ({ task }) => { record.task = task; },
    step: (entry) => { record.steps.push(entry); return entry; },
    finish: () => record,
    get record() { return record; }
  };
};

test('an exact recall replays the skill and never calls the model', async () => {
  const client = fakeClient([]); // any model call would throw "script exhausted"
  const skills = spySkills({
    exact: { id: 'sk1', name: 'Airplane on', steps: [{ name: 'press_key', input: { key: 'home' } }] },
    values: {},
    similar: []
  });

  const result = await runAgentTask({
    text: 'airplane mode on', client, tools, config: baseConfig, perception, skills
  });

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'recalled');
  assert.equal(client.calls.length, 0, 'the model must not be called at all');
  assert.equal(result.costUsd, 0, 'a replay costs nothing');
});

test('a successful replay is recorded against the skill', async () => {
  const skills = spySkills({
    exact: { id: 'sk7', name: 'X', steps: [{ name: 'press_key', input: { key: 'home' } }] },
    values: {},
    similar: []
  });

  await runAgentTask({ text: 'do x', client: fakeClient([]), tools, config: baseConfig, perception, skills });

  assert.deepEqual(skills.uses, [{ id: 'sk7', ok: true }]);
});

test('a stale skill falls through to the model instead of failing the task', async () => {
  const client = fakeClient([planResp(['step one']), actResp('finish', { success: true, summary: 'Did it.' })]);
  const skills = spySkills({
    // No fallback and a label that is not on screen: replay will report drift.
    exact: { id: 'sk1', name: 'Stale', steps: [{ name: 'tap_element', label: 'Long Gone', fallback: null }] },
    values: {},
    similar: []
  });

  const result = await runAgentTask({
    text: 'do the thing', client, tools, config: baseConfig, perception, skills
  });

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'finished', 'the model should have taken over');
  assert.ok(client.calls.length > 0, 'the model must be consulted after a failed replay');
  assert.deepEqual(skills.uses, [{ id: 'sk1', ok: false }], 'the failure is recorded against the skill');
});

test('similar past runs are injected into the planning prompt', async () => {
  const client = fakeClient([planResp(['a']), actResp('finish', { success: true, summary: 'ok' })]);
  const skills = spySkills({
    exact: null,
    values: {},
    similar: [{ skill: { task: 'older run', steps: [] }, score: 0.8 }]
  });

  await runAgentTask({ text: 'new but similar', client, tools, config: baseConfig, perception, skills });

  const planPrompt = client.calls[0].messages[0].content;
  assert.match(planPrompt, /HINTS:1/, 'the plan prompt should carry the recalled examples');
});

test('a successful run is offered to the library to learn from', async () => {
  const client = fakeClient([planResp(['a']), actResp('finish', { success: true, summary: 'ok' })]);
  const skills = spySkills({ exact: null, values: {}, similar: [] });

  await runAgentTask({
    text: 'something new', client, tools, config: baseConfig, perception, skills, trace: fakeTrace()
  });

  assert.equal(skills.learned.length, 1);
  assert.equal(skills.learned[0].payload.ok, true);
});

test('a failed run teaches nothing', async () => {
  const client = fakeClient([planResp(['a']), actResp('finish', { success: false, summary: 'could not' })]);
  const skills = spySkills({ exact: null, values: {}, similar: [] });

  await runAgentTask({
    text: 'doomed', client, tools, config: baseConfig, perception, skills, trace: fakeTrace()
  });

  assert.equal(skills.learned.length, 0);
});

test('without a skills module the loop behaves exactly as before', async () => {
  const client = fakeClient([planResp(['a']), actResp('finish', { success: true, summary: 'ok' })]);

  const result = await runAgentTask({
    text: 'plain run', client, tools, config: baseConfig, perception, trace: fakeTrace()
  });

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'finished');
  // NULL_SKILLS is the default and remembers nothing.
  assert.equal(await NULL_SKILLS.learn(), null);
  assert.deepEqual(await NULL_SKILLS.recall(), { exact: null, values: {}, similar: [] });
});
