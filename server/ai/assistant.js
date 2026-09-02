/**
 * Server-side agentic loop for the "Vani" assistant.
 *
 *  user text
 *    -> Claude (with the registry's tools)
 *    -> for each tool_use: runAction() through the SAME execution layer the NLP
 *       fast-path uses (validated params, job queue, destructive-action confirm)
 *    -> tool_result blocks back to Claude
 *    -> repeat until end_turn
 *
 * Conversation history lives on `session.aiHistory` - per WebSocket/HTTP
 * session, never a module global.
 */

import Anthropic from '@anthropic-ai/sdk';

import { getClient, AI_MODEL } from './client.js';
import { SYSTEM_PROMPT } from './systemPrompt.js';
import { buildTools, intentForAiTool } from './tools.js';
import { getAction, runAction } from '../actions/registry.js';

const MAX_HISTORY_MESSAGES = 40; // ~20 turns
const MAX_TOOL_ROUNDS = 8;

function trimHistory(history) {
  if (history.length > MAX_HISTORY_MESSAGES) {
    history.splice(0, history.length - MAX_HISTORY_MESSAGES);
  }
  // History must start with a user message.
  while (history.length && history[0].role !== 'user') history.shift();
}

function toolResultText(outcome) {
  if (outcome.result && typeof outcome.result === 'object') {
    try { return JSON.stringify(outcome.result).slice(0, 2000); } catch { /* fall through */ }
  }
  return String(outcome.tts || 'done');
}

/**
 * @param {object} args
 * @param {string} args.text            user message
 * @param {object} args.session         { aiHistory?, confirm?, requireConfirm? }
 * @param {(e:object)=>void} [args.onEvent]  ai_delta / ai_reply events
 * @param {object} [args.actionCtx]     base ctx for runAction (config, broadcast, log, startPcShutdown, deviceId)
 * @returns {Promise<{ok:boolean, reply:string, actionsTaken?:Array, disabled?:boolean, error?:string, refusal?:boolean}>}
 */
export async function runAssistant({ text, session = {}, onEvent = () => {}, actionCtx = {}, client }) {
  // `client` undefined -> resolve the real one; `client` null -> force disabled.
  const anthropic = client === undefined ? getClient() : client;
  if (!anthropic) {
    const reply = 'AI is disabled on this server. Set ANTHROPIC_API_KEY to enable Vani.';
    onEvent({ type: 'ai_reply', reply, disabled: true });
    return { ok: false, disabled: true, reply };
  }

  if (!Array.isArray(session.aiHistory)) session.aiHistory = [];
  const history = session.aiHistory;
  history.push({ role: 'user', content: String(text ?? '') });
  trimHistory(history);

  const tools = buildTools();
  const actionsTaken = [];

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const res = await anthropic.messages.create({
        model: AI_MODEL,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        tools,
        messages: history
      });

      history.push({ role: 'assistant', content: res.content });

      if (res.stop_reason === 'refusal') {
        const reply = "Sorry - I can't help with that request.";
        onEvent({ type: 'ai_reply', reply, refusal: true });
        return { ok: false, refusal: true, reply, actionsTaken };
      }

      const toolUses = res.content.filter((b) => b.type === 'tool_use');
      const textOut = res.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();

      if (res.stop_reason !== 'tool_use' || toolUses.length === 0) {
        onEvent({ type: 'ai_reply', reply: textOut, actionsTaken });
        return { ok: true, reply: textOut, actionsTaken };
      }

      if (textOut) onEvent({ type: 'ai_delta', text: textOut });

      // Execute every tool_use, collect ALL tool_result blocks into one user msg.
      const results = [];
      for (const tu of toolUses) {
        const intent = intentForAiTool(tu.name);
        const action = intent && getAction(intent);
        if (!action) {
          results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: `Unknown tool: ${tu.name}` });
          continue;
        }
        const input = tu.input && typeof tu.input === 'object' ? tu.input : {};
        try {
          const outcome = await runAction(intent, input, {
            ...actionCtx,
            // AI-initiated destructive actions ALWAYS go through confirmation.
            requireConfirm: Boolean(action.destructive),
            confirm: session.confirm
          });
          if (outcome.skipped) {
            results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: 'The user declined this action.' });
          } else {
            actionsTaken.push({ tool: tu.name, intent });
            results.push({ type: 'tool_result', tool_use_id: tu.id, content: toolResultText(outcome) });
            onEvent({ type: 'ai_action', tool: tu.name, intent });
          }
        } catch (err) {
          results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: String(err.message).slice(0, 500) });
        }
      }
      history.push({ role: 'user', content: results });
    }

    const reply = 'I stopped after several steps without finishing. Can you narrow the request down?';
    onEvent({ type: 'ai_reply', reply, actionsTaken });
    return { ok: false, reply, actionsTaken };
  } catch (err) {
    let reply;
    if (err instanceof Anthropic.RateLimitError) reply = 'The AI is rate-limited right now - try again in a moment.';
    else if (err instanceof Anthropic.AuthenticationError) reply = 'The ANTHROPIC_API_KEY on this server is invalid.';
    else if (err instanceof Anthropic.APIConnectionError) reply = 'Could not reach the AI service - check the server\'s internet connection.';
    else reply = `AI error: ${err.message}`;
    onEvent({ type: 'ai_reply', reply, error: true });
    return { ok: false, error: err.message, reply, actionsTaken };
  }
}
