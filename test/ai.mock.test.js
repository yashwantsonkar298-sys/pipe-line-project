import assert from 'node:assert/strict';
import test from 'node:test';

import { createMockClient } from '../server/ai/mock.js';
import { runAgentTask } from '../server/agent/agentLoop.js';
import { buildAgentTools, PRIMITIVES } from '../server/agent/tools.js';

const NO_LATENCY = { latencyMs: 0 };

const baseConfig = {
  agentMaxSteps: 12,
  agentCostCapUsd: 1,
  agentDryRun: false,
  agentAppAllowlist: []
};

function fakePerception() {
  let i = 0;
  return {
    captureState: async () => ({
      elements: [
        { index: 0, label: 'Airplane mode', kind: 'toggle', clickable: true, bounds: { cx: 500, cy: 700 }, box: { x: 0, y: 0.3, w: 1, h: 0.07 } }
      ],
      width: 1080,
      height: 2400,
      appPackage: 'com.android.settings',
      degraded: false,
      imageB64: null
    }),
    screenSignature: () => `screen_${i++}`,
    serializeForModel: () => '#0 [toggle] "Airplane mode"',
    overlayElements: (s) => s.elements
  };
}

/** Records primitives instead of driving a phone. */
function spyTools() {
  const ran = [];
  return {
    ran,
    buildAgentTools,
    resolveTarget: (name, input, state) =>
      name === 'tap_element' ? state.elements.find((e) => e.index === Number(input.index)) || null : null,
    runPrimitive: async (name, input) => {
      ran.push(name);
      if (name === 'finish') {
        return { ok: true, detail: input.summary, control: { finish: { success: input.success, summary: input.summary } } };
      }
      if (name === 'screenshot') return { ok: true, detail: 'queued', requestImage: true };
      return { ok: true, detail: `${name} ok` };
    }
  };
}

test('the mock client answers a plan request with a subgoal list', async () => {
  const client = createMockClient(NO_LATENCY);
  const res = await client.messages.create({
    messages: [{ role: 'user', content: 'Task: "airplane mode on kar do"\n\nList 2 to 6 short subgoals' }]
  });
  assert.equal(res.stop_reason, 'end_turn');
  assert.match(res.content[0].text, /^- /m);
});

test('the mock client only ever asks for real primitives', async () => {
  const client = createMockClient(NO_LATENCY);
  const names = new Set();

  for (let i = 0; i < 8; i++) {
    const res = await client.messages.create({
      messages: [{ role: 'user', content: 'turn on airplane mode' }]
    });
    for (const block of res.content) {
      if (block.type === 'tool_use') names.add(block.name);
    }
  }

  assert.ok(names.size > 0);
  for (const name of names) {
    assert.ok(PRIMITIVES[name], `mock asked for "${name}", which is not a real primitive`);
  }
});

test('every tool_use the mock emits carries a unique id', async () => {
  const client = createMockClient(NO_LATENCY);
  const ids = new Set();
  for (let i = 0; i < 6; i++) {
    const res = await client.messages.create({ messages: [{ role: 'user', content: 'open youtube' }] });
    for (const block of res.content) {
      if (block.type !== 'tool_use') continue;
      assert.ok(block.id, 'a tool call needs an id for the result to match');
      assert.ok(!ids.has(block.id), 'ids must be unique or tool results cross-wire');
      ids.add(block.id);
    }
  }
});

test('a full agent run completes with no network and no key', async () => {
  const tools = spyTools();
  const events = [];

  const r = await runAgentTask({
    text: 'airplane mode on kar do',
    client: createMockClient(NO_LATENCY),
    tools,
    config: baseConfig,
    perception: fakePerception(),
    actionCtx: { confirm: async () => true },
    onEvent: (e) => events.push(e)
  });

  assert.equal(r.ok, true);
  assert.equal(r.reason, 'finished');
  assert.ok(tools.ran.includes('open_app'), 'it actually drove the device layer');
  assert.equal(tools.ran.at(-1), 'finish');

  // The events the UI renders must all still arrive.
  for (const type of ['agent_start', 'agent_plan', 'agent_observe', 'agent_step', 'agent_action', 'agent_done']) {
    assert.ok(events.some((e) => e.type === type), `missing ${type}`);
  }
  const plan = events.find((e) => e.type === 'agent_plan');
  assert.ok(plan.subgoals.length >= 2, 'the plan checklist has something in it');
});

test('two runs in one session do not share a script cursor', async () => {
  const client = createMockClient(NO_LATENCY);
  const runOne = spyTools();
  const runTwo = spyTools();

  for (const tools of [runOne, runTwo]) {
    await runAgentTask({
      text: 'open youtube and search',
      client, tools, config: baseConfig,
      perception: fakePerception(),
      actionCtx: { confirm: async () => true }
    });
  }

  assert.deepEqual(runOne.ran, runTwo.ran, 'a second run replays from the start');
});

test('an unrecognised task still finishes on the fallback script', async () => {
  const tools = spyTools();
  const r = await runAgentTask({
    text: 'do something nobody scripted',
    client: createMockClient(NO_LATENCY),
    tools,
    config: baseConfig,
    perception: fakePerception(),
    actionCtx: { confirm: async () => true }
  });

  assert.equal(r.ok, true);
  assert.match(r.summary, /GEMINI_API_KEY/, 'it says how to get a real run');
});

test('the mock reports usage so the token meter still moves', async () => {
  const client = createMockClient(NO_LATENCY);
  const res = await client.messages.create({ messages: [{ role: 'user', content: 'x' }] });
  assert.ok(res.usage.input_tokens > 0);
  assert.ok(res.usage.output_tokens > 0);
});

test('the mock identifies itself so the UI can label the run', () => {
  assert.equal(createMockClient(NO_LATENCY).provider, 'mock');
});
