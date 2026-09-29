/**
 * Google Gemini provider, spoken over the Interactions API with plain `fetch`.
 *
 * NexusFlow's internal message format stays what it always was — `messages[]`
 * of `{role, content}` with `tool_use` / `tool_result` / `image` blocks, and a
 * response carrying `stop_reason`. This file is the only place that knows
 * Gemini exists: it translates our format out, and Gemini's `steps[]` back.
 *
 * That seam is why `agentLoop.js` and `assistant.js` did not have to change
 * when the provider did.
 *
 * Docs: https://ai.google.dev/gemini-api/docs/interactions-overview
 */

import {
  AiError,
  AiAuthError,
  AiRateLimitError,
  AiConnectionError
} from './errors.js';
import { toGeminiTools } from './geminiSchema.js';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const MAX_RETRIES = 3;

/** Gemini interaction status → the `stop_reason` our loop already branches on. */
const STATUS_TO_STOP_REASON = {
  completed: 'end_turn',
  requires_action: 'tool_use',
  incomplete: 'max_tokens',
  budget_exceeded: 'max_tokens'
};

/** Error codes that mean "the model declined", not "something broke". */
const SAFETY_CODE = /safety|blocked|prohibited|policy|recitation/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- outbound --

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

/**
 * Our `messages[]` → Gemini's `input` step array.
 *
 * Only two step types are emitted: `user_input` and `model_output`. That is a
 * deliberate narrowing, established by probing the live API:
 *
 *  - Echoing a `function_call` step back as input is rejected outright, in
 *    every field spelling and even verbatim from the response.
 *  - A `function_result` step is accepted only as the *last* entry in `input`
 *    — the API treats it as "here is the result, now answer". Our loop always
 *    appends a fresh screen observation after it, which made every multi-step
 *    run fail with "Invalid input received".
 *
 * So a tool's outcome is folded into the following user turn as plain text
 * ("Result of open_app: Opened Clock"). The model still sees what it asked
 * for, what it said, what happened, and the new screen — which is the whole
 * transcript it needs. Verified end to end against a real device.
 */
export function toInteractionInput(messages = []) {
  const steps = [];
  // tool_use id → tool name, so a later tool_result can name the tool it
  // belongs to. Our internal tool_result blocks carry only the id.
  const callNames = new Map();

  for (const message of messages) {
    const { role, content } = message;

    if (role === 'assistant') {
      const blocks = Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }];
      for (const block of blocks) {
        if (block.type === 'tool_use' && block.id) callNames.set(block.id, block.name);
      }
      const text = textOf(blocks);
      if (text) steps.push({ type: 'model_output', content: [{ type: 'text', text }] });
      continue;
    }

    if (typeof content === 'string') {
      steps.push({ type: 'user_input', content: [{ type: 'text', text: content }] });
      continue;
    }
    if (!Array.isArray(content)) continue;

    const userContent = [];
    for (const block of content) {
      if (block.type === 'tool_result') {
        const name = block.name || callNames.get(block.tool_use_id) || 'tool';
        const body = blockText(block.content);
        userContent.push({
          type: 'text',
          text: block.is_error ? `Error from ${name}: ${body}` : `Result of ${name}: ${body}`
        });
      } else if (block.type === 'text') {
        userContent.push({ type: 'text', text: block.text });
      } else if (block.type === 'image') {
        // Ours nests the payload under `source`; Gemini's is flat.
        userContent.push({
          type: 'image',
          data: block.source?.data,
          mime_type: block.source?.media_type || 'image/png'
        });
      }
    }
    if (userContent.length) steps.push({ type: 'user_input', content: userContent });
  }

  return steps;
}

function blockText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => c.text ?? '').join('');
  return String(content ?? '');
}

// ----------------------------------------------------------------- inbound --

function usageToInternal(usage = {}) {
  // Thinking tokens are generated and billed like output, so they belong in the
  // output count — otherwise the cost meter under-reports on a thinking model.
  const output = (Number(usage.total_output_tokens) || 0) + (Number(usage.total_thought_tokens) || 0);
  return {
    input_tokens: Number(usage.total_input_tokens) || 0,
    output_tokens: output,
    cache_read_input_tokens: Number(usage.total_cached_tokens) || 0
  };
}

/**
 * Gemini interaction → the response shape our loop expects
 * (`{content: blocks[], stop_reason, usage}`).
 */
export function toInternalResponse(interaction = {}) {
  const steps = Array.isArray(interaction.steps) ? interaction.steps : [];
  const content = [];

  // Only the steps from this turn matter; earlier ones are history we sent.
  for (const step of steps) {
    if (step.type === 'model_output') {
      const text = (step.content || [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('');
      if (text) content.push({ type: 'text', text });
    } else if (step.type === 'function_call') {
      content.push({
        type: 'tool_use',
        // The wire returns `id` on a function_call step; `call_id` is what it
        // expects back on the matching function_result. Accept either here.
        id: step.id || step.call_id,
        name: step.name,
        input: normalizeArguments(step.arguments)
      });
    }
    // `thought` steps are internal reasoning; deliberately not surfaced.
  }

  const errors = Array.isArray(interaction.errors) ? interaction.errors : [];
  const safety = errors.find((e) => SAFETY_CODE.test(String(e?.code || e?.message || '')));

  let stopReason = STATUS_TO_STOP_REASON[interaction.status] || 'end_turn';
  if (safety) stopReason = 'refusal';
  else if (interaction.status === 'failed' || interaction.status === 'cancelled') {
    throw new AiError(errors[0]?.message || `Interaction ${interaction.status}`, {
      code: errors[0]?.code || interaction.status
    });
  }

  // A turn that says requires_action but carries no call would spin the loop.
  if (stopReason === 'tool_use' && !content.some((b) => b.type === 'tool_use')) {
    stopReason = 'end_turn';
  }

  return {
    id: interaction.id,
    content,
    stop_reason: stopReason,
    usage: usageToInternal(interaction.usage)
  };
}

/** Arguments may arrive as an object or as a JSON string. */
function normalizeArguments(args) {
  if (args && typeof args === 'object') return args;
  if (typeof args === 'string') {
    try { return JSON.parse(args); } catch { return {}; }
  }
  return {};
}

// ------------------------------------------------------------------ client --

/**
 * A minimum-interval throttle. The free tier limits requests per minute and an
 * unhandled 429 mid-demo is the likeliest way this falls over, so runs are
 * paced rather than allowed to burst.
 */
function createThrottle(requestsPerMinute) {
  const minIntervalMs = requestsPerMinute > 0 ? Math.ceil(60_000 / requestsPerMinute) : 0;
  let nextFreeAt = 0;
  return async function wait() {
    if (!minIntervalMs) return;
    const now = Date.now();
    const startAt = Math.max(now, nextFreeAt);
    nextFreeAt = startAt + minIntervalMs;
    if (startAt > now) await sleep(startAt - now);
  };
}

function retryDelayMs(response, attempt, baseMs) {
  const header = response?.headers?.get?.('retry-after');
  if (header !== null && header !== undefined && header !== '') {
    const seconds = Number(header);
    // A server-supplied 0 is a real instruction ("retry now"), not a missing value.
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  }
  return Math.min(baseMs * 2 ** attempt, 30_000);
}

/**
 * Build a client exposing the same `{ messages: { create() } }` surface the
 * loop and every test already use.
 *
 * @param {object} options
 * @param {string} options.apiKey
 * @param {number} [options.requestsPerMinute] client-side pacing
 * @param {string} [options.thinkingLevel] minimal | low | medium | high
 * @param {Function} [options.fetchImpl] injectable for tests
 * @param {number} [options.retryBaseMs] backoff base; lowered in tests
 */
export function createGeminiClient({
  apiKey,
  requestsPerMinute = 10,
  thinkingLevel = 'low',
  fetchImpl = globalThis.fetch,
  endpoint = ENDPOINT,
  retryBaseMs = 1000
} = {}) {
  if (!apiKey) throw new AiAuthError('No Gemini API key configured.');
  const throttle = createThrottle(requestsPerMinute);

  async function create(params = {}) {
    const body = {
      model: params.model,
      input: toInteractionInput(params.messages),
      // Stateless: we send the whole (pruned) history every turn. Server-side
      // history would keep every screenshot we deliberately dropped.
      store: false,
      generation_config: {
        max_output_tokens: params.max_tokens,
        thinking_level: thinkingLevel
      }
    };
    if (params.system) body.system_instruction = params.system;

    const tools = toGeminiTools(params.tools);
    if (tools) {
      body.tools = tools;
      body.generation_config.tool_choice = 'auto';
    }

    let lastError = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      await throttle();

      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey
          },
          body: JSON.stringify(body)
        });
      } catch (error) {
        lastError = new AiConnectionError(error.message, { cause: error });
        if (attempt === MAX_RETRIES) throw lastError;
        await sleep(retryDelayMs(null, attempt, retryBaseMs));
        continue;
      }

      if (response.ok) {
        const json = await response.json();
        return toInternalResponse(json);
      }

      const detail = await readError(response);

      if (response.status === 429 || response.status >= 500) {
        lastError = response.status === 429
          ? new AiRateLimitError(detail, { status: 429, retryAfterMs: retryDelayMs(response, attempt, retryBaseMs) })
          : new AiError(detail, { status: response.status });
        if (attempt === MAX_RETRIES) throw lastError;
        await sleep(retryDelayMs(response, attempt, retryBaseMs));
        continue;
      }

      if (response.status === 401 || response.status === 403) {
        throw new AiAuthError(detail, { status: response.status });
      }
      throw new AiError(detail, { status: response.status });
    }

    throw lastError || new AiError('Request failed.');
  }

  return { messages: { create }, provider: 'gemini' };
}

async function readError(response) {
  try {
    const json = await response.json();
    return json?.error?.message || json?.message || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}
