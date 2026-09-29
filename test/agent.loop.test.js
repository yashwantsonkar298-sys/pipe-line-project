import assert from 'node:assert/strict';
import test from 'node:test';

import { runAgentTask } from '../server/agent/agentLoop.js';
import { buildAgentTools } from '../server/agent/tools.js';

/**
 * A fake model client that replays a scripted list of responses.
 *
 * Note the shape: this is NexusFlow's own internal message format, not any
 * vendor's. It did not change when the provider moved from Anthropic to Gemini,
 * which is exactly what these tests are meant to prove.
 */
function fakeClient(script) {
  let i = 0;
  const calls = [];
  return {
    calls,
    get remaining() { return script.length - i; },
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

const actResp = (name, input = {}, thought = 'doing it', id = `t${Math.random()}`) => ({
  stop_reason: 'tool_use',
  content: [
    { type: 'text', text: thought },
    { type: 'tool_use', id, name, input }
  ],
  usage: { input_tokens: 500, output_tokens: 40 }
});

const finishResp = (success, summary) => actResp('finish', { success, summary }, 'wrapping up');

/** A screen the agent can "see", with one benign button and one payment button. */
function fakeState(overrides = {}) {
  const elements = overrides.elements || [
    { index: 0, label: 'Search', kind: 'button', clickable: true, bounds: { cx: 100, cy: 200 }, box: { x: 0, y: 0, w: 0.2, h: 0.05 } },
    { index: 1, label: 'Place order', kind: 'button', clickable: true, bounds: { cx: 500, cy: 900 }, box: { x: 0.1, y: 0.4, w: 0.8, h: 0.06 } }
  ];
  return {
    elements,
    width: 1080,
    height: 2400,
    appPackage: 'com.example.shop',
    degraded: false,
    imageB64: null,
    ...overrides
  };
}

/**
 * Fake perception. `signatures` drives the stuck detector: each capture pops the
 * next value, repeating the last one forever.
 */
function fakePerception({ state = fakeState(), signatures = ['a', 'b', 'c', 'd', 'e', 'f'] } = {}) {
  let i = 0;
  const captures = [];
  return {
    captures,
    captureState: async (opts) => { captures.push(opts); return state; },
    screenSignature: () => signatures[Math.min(i++, signatures.length - 1)],
    serializeForModel: () => '#0 [button] "Search"\n#1 [button] "Place order"',
    overlayElements: (s) => (s.elements || []).map((e) => ({ index: e.index, label: e.label, kind: e.kind, box: e.box }))
  };
}

/** Spy tools module: records calls, never touches ADB. */
function spyTools(behaviour = {}) {
  const ran = [];
  return {
    ran,
    buildAgentTools,
    resolveTarget: (name, input, state) =>
      name === 'tap_element'
        ? (state.elements || []).find((e) => e.index === Number(input.index)) || null
        : null,
    runPrimitive: async (name, input) => {
      ran.push({ name, input });
      if (name === 'finish') {
        return { ok: true, detail: input.summary, control: { finish: { success: input.success, summary: input.summary } } };
      }
      if (name === 'ask_user') {
        return { ok: true, detail: input.question, control: { ask: input.question } };
      }
      if (name === 'screenshot') {
        return { ok: true, detail: 'screenshot queued', requestImage: true };
      }
      if (behaviour.throwOn === name) throw new Error('primitive exploded');
      return { ok: true, detail: `${name} ok` };
    }
  };
}

const baseConfig = {
  agentMaxSteps: 10,
  agentCostCapUsd: 1,
  agentDryRun: false,
  agentAppAllowlist: []
};

test('the agent plans, acts and finishes', async () => {
  const events = [];
  const tools = spyTools();
  const client = fakeClient([
    planResp(['Open the app', 'Tap search']),
    actResp('tap_element', { index: 0 }, 'tapping search'),
    finishResp(true, 'Search opened.')
  ]);

  const r = await runAgentTask({
    text: 'search something',
    client, tools, config: baseConfig,
    perception: fakePerception(),
    // The fixture screen carries a "Place order" button, so every tap on it is
    // classified `confirm`. This test is about the happy path, not the gate.
    actionCtx: { confirm: async () => true },
    onEvent: (e) => events.push(e)
  });

  assert.equal(r.ok, true);
  assert.equal(r.reason, 'finished');
  assert.equal(r.summary, 'Search opened.');
  assert.deepEqual(tools.ran.map((x) => x.name), ['tap_element', 'finish']);

  const plan = events.find((e) => e.type === 'agent_plan');
  assert.deepEqual(plan.subgoals, ['Open the app', 'Tap search']);
  assert.ok(events.some((e) => e.type === 'agent_start'));
  assert.ok(events.some((e) => e.type === 'agent_observe' && e.elements.length === 2));
  assert.ok(events.some((e) => e.type === 'agent_step' && e.thought === 'tapping search'));
  assert.ok(events.some((e) => e.type === 'agent_action' && e.outcome === 'ok'));
  assert.ok(events.some((e) => e.type === 'agent_done' && e.ok === true));
});

test('a screenshot is requested on the first step and only again on demand', async () => {
  const perception = fakePerception();
  const tools = spyTools();
  const client = fakeClient([
    planResp(['look']),
    actResp('tap_element', { index: 0 }),
    actResp('screenshot', {}),
    finishResp(true, 'seen')
  ]);

  await runAgentTask({ text: 'look at it', client, tools, config: baseConfig, perception });

  const withImage = perception.captures.map((c) => c.withImage);
  assert.equal(withImage[0], true, 'step 1 grounds the model with an image');
  assert.equal(withImage[1], false, 'later steps are text-only by default');
  assert.equal(withImage[2], true, 'the screenshot primitive re-enables it');
});

test('the safety layer blocks an action and the model is told not to retry', async () => {
  const events = [];
  const tools = spyTools();
  const state = fakeState({
    elements: [{ index: 0, label: 'Enter OTP', kind: 'input', password: true, focused: true, clickable: true, bounds: { cx: 5, cy: 5 }, box: {} }]
  });
  const client = fakeClient([
    planResp(['fill otp']),
    actResp('type_text', { text: '123456' }, 'typing the otp'),
    finishResp(false, 'Cannot fill the OTP.')
  ]);

  const r = await runAgentTask({
    text: 'fill the otp', client, tools, config: baseConfig,
    perception: fakePerception({ state }),
    onEvent: (e) => events.push(e)
  });

  assert.ok(!tools.ran.some((x) => x.name === 'type_text'), 'a blocked primitive never runs');
  assert.ok(events.some((e) => e.type === 'agent_action' && e.outcome === 'blocked'));
  assert.equal(r.ok, false);

  const toolResult = client.calls.at(-1).messages
    .filter((m) => m.role === 'user' && Array.isArray(m.content))
    .flatMap((m) => m.content)
    .find((b) => b.type === 'tool_result' && b.is_error);
  assert.match(toolResult.content, /Blocked by the safety layer/);
});

test('a risky action asks for confirmation and does not run when declined', async () => {
  const tools = spyTools();
  const asked = [];
  const client = fakeClient([
    planResp(['checkout']),
    actResp('tap_element', { index: 1 }, 'placing the order'),
    finishResp(false, 'User declined.')
  ]);

  await runAgentTask({
    text: 'place the order', client, tools, config: baseConfig,
    perception: fakePerception(),
    actionCtx: { confirm: async (summary) => { asked.push(summary); return false; } }
  });

  assert.equal(asked.length, 1, 'the human was asked exactly once');
  assert.match(asked[0], /Place order/);
  assert.ok(!tools.ran.some((x) => x.name === 'tap_element'), 'declined action never ran');
});

test('a risky action runs once confirmation is granted', async () => {
  const tools = spyTools();
  const client = fakeClient([
    planResp(['checkout']),
    actResp('tap_element', { index: 1 }),
    finishResp(true, 'Ordered.')
  ]);

  const r = await runAgentTask({
    text: 'place the order', client, tools, config: baseConfig,
    perception: fakePerception(),
    actionCtx: { confirm: async () => true }
  });

  assert.equal(r.ok, true);
  assert.ok(tools.ran.some((x) => x.name === 'tap_element'));
});

test('a risky action fails closed when there is no one to confirm it', async () => {
  const events = [];
  const tools = spyTools();
  const client = fakeClient([
    planResp(['checkout']),
    actResp('tap_element', { index: 1 }, 'placing the order'),
    finishResp(false, 'could not confirm')
  ]);

  await runAgentTask({
    text: 'place the order', client, tools, config: baseConfig,
    perception: fakePerception(),
    actionCtx: {},                    // no confirm handler — e.g. an unattended caller
    onEvent: (e) => events.push(e)
  });

  assert.ok(!tools.ran.some((x) => x.name === 'tap_element'),
    'an irreversible action must not run just because nobody could be asked');
  assert.ok(events.some((e) => e.type === 'agent_event' && /no one is available/.test(e.message)));
});

test('dry run stops the agent right before the irreversible step', async () => {
  const events = [];
  const tools = spyTools();
  const client = fakeClient([
    planResp(['checkout']),
    actResp('tap_element', { index: 1 }, 'about to place the order')
  ]);

  const r = await runAgentTask({
    text: 'place the order',
    client, tools,
    config: { ...baseConfig, agentDryRun: true },
    perception: fakePerception(),
    actionCtx: { confirm: async () => true },
    onEvent: (e) => events.push(e)
  });

  assert.equal(r.reason, 'dry_run');
  assert.equal(r.dryRun, true);
  assert.match(r.summary, /Place order/);
  assert.equal(tools.ran.length, 0, 'nothing was executed on the phone');
  assert.ok(events.some((e) => e.type === 'agent_action' && e.outcome === 'dry_run'));
});

test('the app allowlist blocks an off-list app', async () => {
  const tools = spyTools();
  const client = fakeClient([
    planResp(['tap']),
    actResp('tap_element', { index: 0 }),
    finishResp(false, 'blocked')
  ]);

  await runAgentTask({
    text: 'tap search', client, tools,
    config: { ...baseConfig, agentAppAllowlist: ['com.android.settings'] },
    perception: fakePerception()
  });

  assert.ok(!tools.ran.some((x) => x.name === 'tap_element'), 'no device action ran in a disallowed app');
});

test('an unfocused credential screen still refuses a code-shaped string', async () => {
  const tools = spyTools();
  const state = fakeState({
    // No `focused` flag — some dumps omit it. The screen context must still win.
    elements: [{ index: 0, label: 'One-time password', kind: 'input', clickable: true, bounds: { cx: 5, cy: 5 }, box: {} }]
  });
  const client = fakeClient([
    planResp(['fill it']),
    actResp('type_text', { text: '482913' }),
    finishResp(false, 'cannot')
  ]);

  await runAgentTask({ text: 'enter the otp', client, tools, config: baseConfig, perception: fakePerception({ state }) });
  assert.ok(!tools.ran.some((x) => x.name === 'type_text'), 'a code-shaped string is refused on a credential screen');
});

test('the step cap ends the run', async () => {
  const tools = spyTools();
  const client = fakeClient([
    planResp(['loop']),
    actResp('wait', { ms: 100 }),
    actResp('wait', { ms: 100 }),
    actResp('wait', { ms: 100 })
  ]);

  const r = await runAgentTask({
    text: 'go forever', client, tools,
    config: { ...baseConfig, agentMaxSteps: 2 },
    perception: fakePerception()
  });

  assert.equal(r.reason, 'step_cap');
  assert.equal(r.ok, false);
  assert.equal(r.steps, 2);
  assert.match(r.summary, /2-step limit/);
});

test('the cost cap ends the run', async () => {
  const tools = spyTools();
  const expensive = { ...actResp('wait', { ms: 100 }), usage: { input_tokens: 2_000_000, output_tokens: 0 } };
  const client = fakeClient([planResp(['x']), expensive, expensive, expensive]);

  const r = await runAgentTask({
    text: 'burn money', client, tools,
    config: { ...baseConfig, agentCostCapUsd: 1 },
    perception: fakePerception()
  });

  assert.equal(r.reason, 'cost_cap');
  assert.match(r.summary, /cost cap/);
});

test('abort stops the run at the next step boundary', async () => {
  const tools = spyTools();
  const session = {};
  const client = fakeClient([
    planResp(['x']),
    actResp('wait', { ms: 100 }),
    actResp('wait', { ms: 100 })
  ]);

  const r = await runAgentTask({
    text: 'stop me', client, tools, session,
    config: baseConfig,
    perception: fakePerception(),
    onEvent: (e) => {
      // Simulate the user hitting STOP after the first action lands.
      if (e.type === 'agent_action') session.agentBudget.abort('user');
    }
  });

  assert.equal(r.reason, 'aborted');
  assert.equal(r.aborted, true);
  assert.equal(session.agentBudget, null, 'the budget handle is released after the run');
});

test('an unchanged screen is reported and the model is nudged when stuck', async () => {
  const events = [];
  const tools = spyTools();
  const client = fakeClient([
    planResp(['x']),
    actResp('wait', { ms: 100 }),
    actResp('wait', { ms: 100 }),
    actResp('wait', { ms: 100 }),
    actResp('wait', { ms: 100 }),
    finishResp(false, 'stuck')
  ]);

  await runAgentTask({
    text: 'go nowhere', client, tools, config: baseConfig,
    perception: fakePerception({ signatures: ['same'] }),
    onEvent: (e) => events.push(e)
  });

  assert.ok(events.some((e) => e.type === 'agent_verify' && e.changed === false));
  assert.ok(events.some((e) => e.type === 'agent_event' && /stuck/i.test(e.message)));

  const observations = client.calls.at(-1).messages
    .filter((m) => m.role === 'user' && Array.isArray(m.content))
    .flatMap((m) => m.content)
    .filter((b) => b.type === 'text');
  assert.ok(observations.some((b) => /not changed for several actions/.test(b.text)));
});

test('ask_user pauses the run and surfaces the question', async () => {
  const events = [];
  const tools = spyTools();
  const client = fakeClient([
    planResp(['x']),
    actResp('ask_user', { question: 'Which account should I use?' })
  ]);

  const r = await runAgentTask({
    text: 'log in', client, tools, config: baseConfig,
    perception: fakePerception(),
    onEvent: (e) => events.push(e)
  });

  assert.equal(r.reason, 'ask_user');
  assert.equal(r.question, 'Which account should I use?');
  assert.ok(events.some((e) => e.type === 'agent_ask'));
});

test('only the first tool_use runs; the rest get a result saying so', async () => {
  const tools = spyTools();
  const twoCalls = {
    stop_reason: 'tool_use',
    content: [
      { type: 'tool_use', id: 'a', name: 'wait', input: { ms: 100 } },
      { type: 'tool_use', id: 'b', name: 'wait', input: { ms: 200 } }
    ],
    usage: { input_tokens: 10, output_tokens: 5 }
  };
  const client = fakeClient([planResp(['x']), twoCalls, finishResp(true, 'done')]);

  await runAgentTask({ text: 'do two things', client, tools, config: baseConfig, perception: fakePerception() });

  const waits = tools.ran.filter((x) => x.name === 'wait');
  assert.equal(waits.length, 1, 'exactly one action per turn');

  const results = client.calls.at(-1).messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => b.type === 'tool_result');
  assert.equal(results.filter((r) => r.tool_use_id === 'b')[0].is_error, true);
  assert.match(results.filter((r) => r.tool_use_id === 'b')[0].content, /Only one action runs per turn/);
});

test('a failing primitive is reported to the model instead of crashing the run', async () => {
  const events = [];
  const tools = spyTools({ throwOn: 'tap_element' });
  const client = fakeClient([
    planResp(['x']),
    actResp('tap_element', { index: 0 }),
    finishResp(false, 'could not tap')
  ]);

  const r = await runAgentTask({
    text: 'tap it', client, tools, config: baseConfig,
    perception: fakePerception(),
    actionCtx: { confirm: async () => true },
    onEvent: (e) => events.push(e)
  });

  assert.equal(r.reason, 'failed');
  assert.ok(events.some((e) => e.type === 'agent_action' && e.outcome === 'failed'));
});

test('a truncated turn is reported instead of looking like inaction', async () => {
  const events = [];
  const client = fakeClient([
    planResp(['x']),
    { stop_reason: 'max_tokens', content: [{ type: 'text', text: 'I will now' }], usage: {} }
  ]);

  const r = await runAgentTask({
    text: 'do a huge thing', client, tools: spyTools(),
    config: baseConfig, perception: fakePerception(),
    onEvent: (e) => events.push(e)
  });

  assert.equal(r.reason, 'max_tokens');
  assert.equal(r.ok, false);
  assert.equal(client.calls.length, 2, 'no retry after truncation');
  assert.ok(events.some((e) => e.type === 'agent_event' && /token response limit/.test(e.message)));
});

test('a refusal ends the run without retrying', async () => {
  const client = fakeClient([planResp(['x']), { stop_reason: 'refusal', content: [] }]);
  const r = await runAgentTask({
    text: 'do something disallowed', client, tools: spyTools(),
    config: baseConfig, perception: fakePerception()
  });
  assert.equal(r.reason, 'refusal');
  assert.equal(client.calls.length, 2, 'plan + one turn, no retry');
});

test('a text-only reply is nudged once, then accepted', async () => {
  const tools = spyTools();
  const client = fakeClient([
    planResp(['x']),
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'I think it is done' }], usage: {} },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Yes, done.' }], usage: {} }
  ]);

  const r = await runAgentTask({ text: 'is it done?', client, tools, config: baseConfig, perception: fakePerception() });

  assert.equal(r.reason, 'replied');
  assert.equal(r.summary, 'Yes, done.');
  const nudge = client.calls.at(-1).messages.find((m) => typeof m.content === 'string' && /must call a tool/.test(m.content));
  assert.ok(nudge, 'the model was nudged to use a tool');
});

test('history is pruned so old screenshots and listings do not accumulate', async () => {
  const tools = spyTools();
  const state = fakeState({ imageB64: 'AAAA' });
  const client = fakeClient([
    planResp(['x']),
    actResp('screenshot', {}),
    actResp('screenshot', {}),
    actResp('screenshot', {}),
    actResp('screenshot', {}),
    finishResp(true, 'done')
  ]);

  await runAgentTask({
    text: 'look repeatedly', client, tools, config: baseConfig,
    perception: fakePerception({ state })
  });

  const blocks = client.calls.at(-1).messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
  const images = blocks.filter((b) => b.type === 'image');
  assert.ok(images.length <= 2, `at most the recent screenshots are kept, got ${images.length}`);
  assert.ok(blocks.some((b) => b.type === 'text' && b.text === '[screenshot omitted]'));
  assert.ok(blocks.some((b) => b.type === 'text' && /\[screen listing omitted\]/.test(b.text)));
});

test('runs disabled-gracefully with no client', async () => {
  const r = await runAgentTask({ text: 'hi', client: null, config: baseConfig });
  assert.equal(r.disabled, true);
  assert.match(r.summary, /GEMINI_API_KEY/);
});

test('an empty task is rejected before any API call', async () => {
  const client = fakeClient([]);
  const r = await runAgentTask({ text: '   ', client, config: baseConfig });
  assert.equal(r.ok, false);
  assert.equal(client.calls.length, 0);
});

test('a planning failure does not stop the run', async () => {
  const tools = spyTools();
  let first = true;
  const client = {
    calls: [],
    messages: {
      create: async (params) => {
        client.calls.push(params);
        if (first) { first = false; throw new Error('planner down'); }
        return finishResp(true, 'did it anyway');
      }
    }
  };

  const r = await runAgentTask({ text: 'go', client, tools, config: baseConfig, perception: fakePerception() });
  assert.equal(r.ok, true);
  assert.equal(r.summary, 'did it anyway');
});

test('API errors are mapped to a friendly summary', async () => {
  const tools = spyTools();
  const client = {
    calls: [],
    messages: {
      create: async () => { throw new Error('socket hang up'); }
    }
  };
  const r = await runAgentTask({ text: 'go', client, tools, config: baseConfig, perception: fakePerception() });
  assert.equal(r.reason, 'error');
  assert.match(r.summary, /AI error: socket hang up/);
});

test('a rate-limit error explains the free-tier limit rather than leaking the class name', async () => {
  const { AiRateLimitError } = await import('../server/ai/errors.js');
  const client = {
    calls: [],
    messages: { create: async () => { throw new AiRateLimitError(); } }
  };
  const r = await runAgentTask({
    text: 'go', client, tools: spyTools(), config: baseConfig, perception: fakePerception()
  });
  assert.equal(r.reason, 'error');
  assert.match(r.summary, /rate-limited/i);
  assert.match(r.summary, /free tier/i);
});
