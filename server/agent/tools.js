/**
 * The agent's primitive tool set.
 *
 * Deliberately tiny and composable — the opposite of `actions/registry.js`,
 * which exposes ~30 bespoke intents. Anything the phone can do is reachable by
 * composing these ten primitives against what `perception.js` sees, so the
 * agent is not limited to what someone pre-wired.
 */

import { assertJsonSchema } from '../security.js';
import { sendTap, sendSwipe } from '../screenMirror.js';
import { typeText, openApp, pressKeyEvent, listKeyEventNames } from '../adb.js';

const normalized = { type: 'number', minimum: 0, maximum: 1 };

export const PRIMITIVES = Object.freeze({
  tap_element: {
    description:
      'Tap an element from the current screen listing, by its # index. Always prefer this over tap_xy.',
    input_schema: {
      type: 'object',
      properties: { index: { type: 'integer', minimum: 0, maximum: 200 } },
      required: ['index'],
      additionalProperties: false
    }
  },
  tap_xy: {
    description:
      'Tap normalized screen coordinates (0-1, origin top-left). Only use when no element index fits, e.g. on a screen whose hierarchy could not be read.',
    input_schema: {
      type: 'object',
      properties: { x: normalized, y: normalized },
      required: ['x', 'y'],
      additionalProperties: false
    }
  },
  type_text: {
    description:
      'Type text into the currently focused input field. Tap the field first. Does not press enter.',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string', minLength: 1, maxLength: 500 } },
      required: ['text'],
      additionalProperties: false
    }
  },
  swipe: {
    description:
      'Swipe the screen. `direction` is the direction your finger moves: "up" scrolls further down a list, "down" scrolls back up.',
    input_schema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        distance: { ...normalized, description: 'Fraction of the screen to travel. Default 0.4.' }
      },
      required: ['direction'],
      additionalProperties: false
    }
  },
  press_key: {
    description: 'Press a hardware/navigation key.',
    input_schema: {
      type: 'object',
      properties: { key: { type: 'string', enum: listKeyEventNames() } },
      required: ['key'],
      additionalProperties: false
    }
  },
  open_app: {
    description: 'Launch an app by its display name, e.g. "Settings", "YouTube", "WhatsApp".',
    input_schema: {
      type: 'object',
      properties: { appName: { type: 'string', minLength: 1, maxLength: 64 } },
      required: ['appName'],
      additionalProperties: false
    }
  },
  wait: {
    description: 'Wait for the screen to settle, e.g. after launching an app or submitting a form.',
    input_schema: {
      type: 'object',
      properties: { ms: { type: 'integer', minimum: 100, maximum: 8000 } },
      required: ['ms'],
      additionalProperties: false
    }
  },
  screenshot: {
    description:
      'Attach a screenshot image to the next observation. Use when the element list alone is not enough to tell what is on screen.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false }
  },
  ask_user: {
    description:
      'Stop and ask the human a question. Use when you are blocked, need a credential, or need a decision only they can make.',
    input_schema: {
      type: 'object',
      properties: { question: { type: 'string', minLength: 1, maxLength: 300 } },
      required: ['question'],
      additionalProperties: false
    }
  },
  finish: {
    description: 'End the task. Call this as soon as the goal is met, or when it cannot be met.',
    input_schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        summary: { type: 'string', minLength: 1, maxLength: 400 }
      },
      required: ['success', 'summary'],
      additionalProperties: false
    }
  }
});

/**
 * The tool list handed to the model. The provider adapter translates these
 * schemas into whatever the current vendor accepts (see `ai/geminiSchema.js`).
 */
export function buildAgentTools() {
  return Object.entries(PRIMITIVES).map(([name, spec]) => ({
    name,
    description: spec.description,
    input_schema: spec.input_schema
  }));
}

export function isPrimitive(name) {
  return Object.prototype.hasOwnProperty.call(PRIMITIVES, name);
}

/** The element a tap-style action is aimed at, for safety checks and the trace. */
export function resolveTarget(name, input, state) {
  if (name !== 'tap_element') return null;
  const index = Number(input?.index);
  return (state?.elements || []).find((el) => el.index === index) || null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function toDevicePx(nx, ny, state) {
  const w = state?.width || 1080;
  const h = state?.height || 2400;
  return {
    x: Math.round(Math.min(1, Math.max(0, Number(nx) || 0)) * (w - 1)),
    y: Math.round(Math.min(1, Math.max(0, Number(ny) || 0)) * (h - 1))
  };
}

function swipePath(direction, distance, state) {
  const d = Math.min(0.9, Math.max(0.05, Number(distance) || 0.4));
  const half = d / 2;
  const paths = {
    up: [0.5, 0.5 + half, 0.5, 0.5 - half],
    down: [0.5, 0.5 - half, 0.5, 0.5 + half],
    left: [0.5 + half, 0.5, 0.5 - half, 0.5],
    right: [0.5 - half, 0.5, 0.5 + half, 0.5]
  };
  const [x1, y1, x2, y2] = paths[direction] || paths.up;
  const a = toDevicePx(x1, y1, state);
  const b = toDevicePx(x2, y2, state);
  return { a, b };
}

/**
 * Execute one primitive.
 *
 * @returns {Promise<{ok: boolean, detail: string, control?: object, requestImage?: boolean}>}
 *   `control` carries loop-level outcomes (`finish` / `ask`) rather than device effects.
 */
export async function runPrimitive(name, rawInput, ctx = {}) {
  if (!isPrimitive(name)) throw new Error(`Unknown primitive: ${name}`);
  const spec = PRIMITIVES[name];
  const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
  assertJsonSchema(input, spec.input_schema);

  const { state, deviceId } = ctx;

  switch (name) {
    case 'tap_element': {
      const target = resolveTarget(name, input, state);
      if (!target) {
        return { ok: false, detail: `No element #${input.index} on this screen. Re-read the listing.` };
      }
      await sendTap(target.bounds.cx, target.bounds.cy, deviceId);
      return { ok: true, detail: `Tapped #${target.index} "${target.label || target.className}"` };
    }

    case 'tap_xy': {
      const { x, y } = toDevicePx(input.x, input.y, state);
      await sendTap(x, y, deviceId);
      return { ok: true, detail: `Tapped (${x}, ${y})` };
    }

    case 'type_text': {
      await typeText(input.text);
      return { ok: true, detail: `Typed "${input.text.slice(0, 60)}"` };
    }

    case 'swipe': {
      const { a, b } = swipePath(input.direction, input.distance, state);
      await sendSwipe(a.x, a.y, b.x, b.y, 300, deviceId);
      return { ok: true, detail: `Swiped ${input.direction}` };
    }

    case 'press_key': {
      await pressKeyEvent(input.key, deviceId);
      return { ok: true, detail: `Pressed ${input.key}` };
    }

    case 'open_app': {
      await openApp(input.appName);
      await sleep(1200);
      return { ok: true, detail: `Opened ${input.appName}` };
    }

    case 'wait': {
      await sleep(input.ms);
      return { ok: true, detail: `Waited ${input.ms}ms` };
    }

    case 'screenshot':
      return { ok: true, detail: 'Screenshot attached to the next observation.', requestImage: true };

    case 'ask_user':
      return { ok: true, detail: input.question, control: { ask: input.question } };

    case 'finish':
      return {
        ok: true,
        detail: input.summary,
        control: { finish: { success: Boolean(input.success), summary: input.summary } }
      };

    default:
      throw new Error(`Unhandled primitive: ${name}`);
  }
}
