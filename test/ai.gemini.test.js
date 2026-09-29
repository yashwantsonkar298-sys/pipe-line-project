import assert from 'node:assert/strict';
import test from 'node:test';

import {
  toInteractionInput,
  toInternalResponse,
  createGeminiClient
} from '../server/ai/gemini.js';
import { toGeminiSchema, toGeminiTools } from '../server/ai/geminiSchema.js';
import { AiAuthError, AiRateLimitError, AiConnectionError, AiError } from '../server/ai/errors.js';
import { listAiTools } from '../server/actions/registry.js';
import { buildAgentTools } from '../server/agent/tools.js';

// Fast pacing and a tiny backoff base, so the retry tests exercise the real
// code path without spending seconds asleep.
const FAST = { requestsPerMinute: 6000, retryBaseMs: 1 };

function stubFetch(responses) {
  const calls = [];
  let i = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = responses[Math.min(i++, responses.length - 1)];
    if (typeof next === 'function') return next();
    return next;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const ok = (json) => ({ ok: true, status: 200, json: async () => json });
const fail = (status, message = 'nope', headers = {}) => ({
  ok: false,
  status,
  headers: { get: (k) => headers[k] ?? null },
  json: async () => ({ error: { message } })
});

const completed = (steps = [{ type: 'model_output', content: [{ type: 'text', text: 'hi' }] }]) => ({
  id: 'int_1',
  status: 'completed',
  steps,
  usage: { total_input_tokens: 10, total_output_tokens: 5 }
});

// ---------------------------------------------------------------- outbound --

test('a plain user turn becomes a user_input step', () => {
  const steps = toInteractionInput([{ role: 'user', content: 'hello' }]);
  assert.deepEqual(steps, [{ type: 'user_input', content: [{ type: 'text', text: 'hello' }] }]);
});

test('our nested image block flattens into Gemini shape', () => {
  const steps = toInteractionInput([{
    role: 'user',
    content: [
      { type: 'text', text: 'look' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
    ]
  }]);
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0].content[1], { type: 'image', data: 'AAAA', mime_type: 'image/png' });
});

test('an assistant turn replays its text but NOT its function_call', () => {
  // Verified against the live API: echoing a function_call step back as input
  // is rejected ("Unknown parameter ... at 'input[n]'"), even verbatim from the
  // response. Only the text is replayed; the function_result carries the rest.
  const steps = toInteractionInput([{
    role: 'assistant',
    content: [
      { type: 'text', text: 'tapping search' },
      { type: 'tool_use', id: 'call_7', name: 'tap_element', input: { index: 3 } }
    ]
  }]);
  assert.equal(steps.length, 1, 'the tool call must not be echoed');
  assert.equal(steps[0].type, 'model_output');
  assert.equal(steps[0].content[0].text, 'tapping search');
});

test('an unmatched tool result still names something rather than crashing', () => {
  const [step] = toInteractionInput([{
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'unknown_id', content: 'done' }]
  }]);
  assert.equal(step.content[0].text, 'Result of tool: done');
});

test('a tool result is folded into the user turn, naming the tool it came from', () => {
  // A function_result step is only accepted as the last entry in `input`, and
  // our loop always appends the next observation after it — so the outcome
  // travels as text instead.
  const steps = toInteractionInput([
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_7', name: 'tap_element', input: {} }] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'call_7', content: 'Tapped #3' },
      { type: 'text', text: 'Step 2 of 25.' }
    ] }
  ]);
  const user = steps.find((s) => s.type === 'user_input');
  assert.equal(user.content[0].text, 'Result of tap_element: Tapped #3');
  assert.equal(user.content[1].text, 'Step 2 of 25.');
});

test('an errored tool result reads as an error', () => {
  const [step] = toInteractionInput([{
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'c1', is_error: true, content: 'Blocked by the safety layer' }]
  }]);
  assert.match(step.content[0].text, /^Error from tool: Blocked by the safety layer/);
});

test('only user_input and model_output are ever sent', () => {
  // The live API rejects function_call as input outright, and function_result
  // anywhere but last. Narrowing to these two is what makes multi-step runs work.
  const steps = toInteractionInput([
    { role: 'user', content: 'open the clock app' },
    { role: 'user', content: [
      { type: 'text', text: 'Step 1 of 25.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
    ] },
    { role: 'assistant', content: [
      { type: 'text', text: 'Opening Clock.' },
      { type: 'tool_use', id: 'c1', name: 'open_app', input: { appName: 'Clock' } }
    ] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'Opened Clock' }] },
    { role: 'user', content: [{ type: 'text', text: 'Step 2 of 25.' }] }
  ]);

  assert.deepEqual([...new Set(steps.map((s) => s.type))].sort(), ['model_output', 'user_input']);
  assert.deepEqual(steps.map((s) => s.type),
    ['user_input', 'user_input', 'model_output', 'user_input', 'user_input']);
  assert.equal(steps[3].content[0].text, 'Result of open_app: Opened Clock');
});

// ----------------------------------------------------------------- inbound --

test('a function_call step arriving with `id` becomes a tool_use block', () => {
  // This is the real wire shape: the response carries `id` on a function_call
  // (keys observed live: id, type, name, arguments).
  const res = toInternalResponse({
    status: 'requires_action',
    steps: [
      { type: 'thought', signature: 'opaque' },
      { type: 'model_output', content: [{ type: 'text', text: 'tapping' }] },
      { type: 'function_call', id: 'call_9', name: 'tap_element', arguments: { index: 1 } }
    ],
    usage: {}
  });
  assert.equal(res.content[1].id, 'call_9');
  assert.equal(res.stop_reason, 'tool_use');
});

test('a function_call step arriving with `call_id` is also accepted', () => {
  const res = toInternalResponse({
    status: 'requires_action',
    steps: [
      { type: 'thought', content: [{ type: 'text', text: 'internal' }] },
      { type: 'model_output', content: [{ type: 'text', text: 'tapping' }] },
      { type: 'function_call', call_id: 'call_9', name: 'tap_element', arguments: { index: 1 } }
    ],
    usage: {}
  });

  assert.equal(res.stop_reason, 'tool_use');
  assert.deepEqual(res.content[0], { type: 'text', text: 'tapping' });
  assert.deepEqual(res.content[1], { type: 'tool_use', id: 'call_9', name: 'tap_element', input: { index: 1 } });
  assert.ok(!res.content.some((b) => b.text === 'internal'), 'thought steps are not surfaced');
});

test('tool arguments arriving as a JSON string are parsed', () => {
  const res = toInternalResponse({
    status: 'requires_action',
    steps: [{ type: 'function_call', call_id: 'c', name: 'wait', arguments: '{"ms":500}' }]
  });
  assert.deepEqual(res.content[0].input, { ms: 500 });
});

test('status maps onto the stop_reason the loop already understands', () => {
  const withCall = (status) => toInternalResponse({
    status,
    steps: [{ type: 'function_call', call_id: 'c', name: 'wait', arguments: {} }]
  }).stop_reason;

  assert.equal(toInternalResponse({ status: 'completed', steps: [] }).stop_reason, 'end_turn');
  assert.equal(withCall('requires_action'), 'tool_use');
  assert.equal(toInternalResponse({ status: 'incomplete', steps: [] }).stop_reason, 'max_tokens');
  assert.equal(toInternalResponse({ status: 'budget_exceeded', steps: [] }).stop_reason, 'max_tokens');
});

test('requires_action with no actual call does not spin the loop', () => {
  const res = toInternalResponse({ status: 'requires_action', steps: [] });
  assert.equal(res.stop_reason, 'end_turn', 'falls back rather than looping on nothing');
});

test('a safety error surfaces as a refusal, not a crash', () => {
  const res = toInternalResponse({
    status: 'failed',
    steps: [],
    errors: [{ code: 'SAFETY_BLOCKED', message: 'blocked' }]
  });
  assert.equal(res.stop_reason, 'refusal');
});

test('a non-safety failure throws with the provider message', () => {
  assert.throws(
    () => toInternalResponse({ status: 'failed', steps: [], errors: [{ code: 'INTERNAL', message: 'boom' }] }),
    /boom/
  );
});

test('usage maps to our field names, with thinking billed as output', () => {
  const res = toInternalResponse({
    status: 'completed',
    steps: [],
    usage: {
      total_input_tokens: 1000,
      total_output_tokens: 200,
      total_thought_tokens: 300,
      total_cached_tokens: 50
    }
  });
  assert.equal(res.usage.input_tokens, 1000);
  assert.equal(res.usage.output_tokens, 500, 'output + thinking');
  assert.equal(res.usage.cache_read_input_tokens, 50);
});

// ------------------------------------------------------------------ schema --

test('toGeminiSchema strips keywords Gemini rejects', () => {
  const out = toGeminiSchema({
    type: 'object',
    additionalProperties: false,
    properties: { x: { type: 'number', minimum: 0, maximum: 1 } },
    required: ['x']
  });
  assert.equal(out.additionalProperties, undefined);
  assert.equal(out.properties.x.minimum, undefined);
  assert.equal(out.properties.x.maximum, undefined);
  assert.deepEqual(out.required, ['x']);
});

test('stripped bounds survive as prose so the model still knows them', () => {
  const out = toGeminiSchema({
    type: 'object',
    properties: {
      x: { type: 'number', minimum: 0, maximum: 1 },
      text: { type: 'string', minLength: 1, maxLength: 500, description: 'What to type' }
    }
  });
  assert.match(out.properties.x.description, /0-1/);
  assert.match(out.properties.text.description, /What to type/);
  assert.match(out.properties.text.description, /1-500 characters/);
});

test('integer becomes number with a note, since Gemini has no integer type', () => {
  const out = toGeminiSchema({ type: 'integer', minimum: 100, maximum: 8000 });
  assert.equal(out.type, 'number');
  assert.match(out.description, /whole number/);
});

test('enum and nesting are preserved', () => {
  const out = toGeminiSchema({
    type: 'object',
    properties: {
      direction: { type: 'string', enum: ['up', 'down'] },
      nested: { type: 'object', properties: { deep: { type: 'string', maxLength: 5 } } }
    }
  });
  assert.deepEqual(out.properties.direction.enum, ['up', 'down']);
  assert.equal(out.properties.nested.properties.deep.type, 'string');
  assert.match(out.properties.nested.properties.deep.description, /max 5 characters/);
});

test('an object with no properties still declares an empty properties map', () => {
  const out = toGeminiSchema({ type: 'object', properties: {}, required: [], additionalProperties: false });
  assert.deepEqual(out.properties, {});
  assert.equal(out.required, undefined, 'an empty required list is omitted, not sent empty');
});

test('every real tool in the project survives translation', () => {
  const all = [...listAiTools(), ...buildAgentTools()];
  assert.ok(all.length > 30);

  const declarations = toGeminiTools(all);
  const banned = ['additionalProperties', 'minimum', 'maximum', 'minLength', 'maxLength', 'strict'];

  for (const decl of declarations) {
    assert.equal(decl.type, 'function');
    assert.match(decl.name, /^[a-z][a-z0-9_]*$/);
    assert.ok(decl.description, `${decl.name} needs a description`);
    assert.equal(decl.parameters.type, 'object');

    const json = JSON.stringify(decl.parameters);
    for (const key of banned) {
      assert.ok(!json.includes(`"${key}"`), `${decl.name} still carries ${key}`);
    }
  }
});

// ------------------------------------------------------------------ client --

test('the request body carries our params in Gemini shape', async () => {
  const fetchImpl = stubFetch([ok(completed())]);
  const client = createGeminiClient({ apiKey: 'k', fetchImpl, ...FAST });

  await client.messages.create({
    model: 'gemini-3.8-flash',
    max_tokens: 4096,
    system: 'You are Vani.',
    tools: [{ name: 'wait', description: 'wait', input_schema: { type: 'object', properties: {} } }],
    messages: [{ role: 'user', content: 'go' }]
  });

  const { body, init, url } = fetchImpl.calls[0];
  assert.match(url, /\/v1beta\/interactions$/);
  assert.equal(init.headers['x-goog-api-key'], 'k', 'the key goes in the header, not the query string');
  assert.equal(body.model, 'gemini-3.8-flash');
  assert.equal(body.system_instruction, 'You are Vani.');
  assert.equal(body.generation_config.max_output_tokens, 4096);
  assert.equal(body.store, false, 'history stays client-side so pruning still controls cost');
  assert.equal(body.tools[0].type, 'function');
});

test('401 becomes an auth error, not a retry loop', async () => {
  const fetchImpl = stubFetch([fail(401, 'bad key')]);
  const client = createGeminiClient({ apiKey: 'k', fetchImpl, ...FAST });
  await assert.rejects(() => client.messages.create({ messages: [] }), AiAuthError);
  assert.equal(fetchImpl.calls.length, 1, 'an invalid key is not worth retrying');
});

test('429 is retried and can succeed', async () => {
  const fetchImpl = stubFetch([
    fail(429, 'slow down', { 'retry-after': '0' }),
    ok(completed())
  ]);
  const client = createGeminiClient({ apiKey: 'k', fetchImpl, ...FAST });

  const res = await client.messages.create({ messages: [{ role: 'user', content: 'go' }] });
  assert.equal(res.stop_reason, 'end_turn');
  assert.equal(fetchImpl.calls.length, 2);
});

test('a persistent 429 surfaces as a rate-limit error after retries', async () => {
  const fetchImpl = stubFetch([fail(429, 'quota', { 'retry-after': '0' })]);
  const client = createGeminiClient({ apiKey: 'k', fetchImpl, ...FAST });
  await assert.rejects(() => client.messages.create({ messages: [] }), AiRateLimitError);
  assert.ok(fetchImpl.calls.length > 1, 'it did retry before giving up');
});

test('a network failure becomes a connection error', async () => {
  const fetchImpl = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
  const client = createGeminiClient({ apiKey: 'k', fetchImpl, ...FAST });
  await assert.rejects(() => client.messages.create({ messages: [] }), AiConnectionError);
});

test('a 400 is reported as-is rather than retried', async () => {
  const fetchImpl = stubFetch([fail(400, 'Invalid tool schema')]);
  const client = createGeminiClient({ apiKey: 'k', fetchImpl, ...FAST });
  await assert.rejects(() => client.messages.create({ messages: [] }), (e) => {
    assert.ok(e instanceof AiError);
    assert.match(e.message, /Invalid tool schema/);
    return true;
  });
  assert.equal(fetchImpl.calls.length, 1);
});

test('constructing without a key fails loudly', () => {
  assert.throws(() => createGeminiClient({ apiKey: '' }), AiAuthError);
});

test('requests are paced to the configured rate', async () => {
  const fetchImpl = stubFetch([ok(completed())]);
  const client = createGeminiClient({ apiKey: 'k', fetchImpl, requestsPerMinute: 120 }); // 500ms apart
  const started = Date.now();
  await client.messages.create({ messages: [] });
  await client.messages.create({ messages: [] });
  assert.ok(Date.now() - started >= 450, 'the second request waited for its slot');
});
