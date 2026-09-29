import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { assertJsonSchema } from './security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MACROS_FILE = path.join(__dirname, 'macros.json');

export const MACRO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', maxLength: 64 },
    name: { type: 'string', minLength: 1, maxLength: 80 },
    description: { type: 'string', maxLength: 200 },
    schedule: { type: ['string', 'null'], maxLength: 64 },
    // 'command' (the original) replays natural-language steps through the NLP
    // pipeline; 'agent' replays raw primitives captured from an agent run.
    kind: { type: 'string', enum: ['command', 'agent'] },
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: 50,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string', minLength: 1, maxLength: 200 },
          delay: { type: 'number', minimum: 0, maximum: 30000 }
        },
        required: ['command']
      }
    },
    primitives: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 32 },
          input: { type: 'object' },
          label: { type: 'string', maxLength: 120 },
          delay: { type: 'number', minimum: 0, maximum: 30000 }
        },
        required: ['name']
      }
    }
  },
  required: ['name', 'steps']
};

export function validateMacro(body) {
  assertJsonSchema(body ?? {}, MACRO_SCHEMA);
  return body;
}

const DEFAULT_MACROS = [
  {
    id: 'morning-routine',
    name: 'Morning Routine ☀️',
    description: 'WiFi ON → Brightness Max → Open WhatsApp',
    steps: [
      { command: 'wifi on', delay: 2000 },
      { command: 'brightness max', delay: 1000 },
      { command: 'open whatsapp', delay: 2000 }
    ],
    schedule: null,
    createdAt: Date.now()
  },
  {
    id: 'night-mode',
    name: 'Night Mode 🌙',
    description: 'Brightness Low → Mute → WiFi OFF',
    steps: [
      { command: 'brightness low', delay: 1000 },
      { command: 'mute', delay: 1000 },
      { command: 'wifi off', delay: 1000 }
    ],
    schedule: null,
    createdAt: Date.now()
  },
  {
    id: 'quick-photo',
    name: 'Quick Photo 📸',
    description: 'Unlock → Open Camera → Take Photo',
    steps: [
      { command: 'unlock phone', delay: 3000 },
      { command: 'open camera', delay: 3000 },
      { command: 'take photo', delay: 2000 }
    ],
    schedule: null,
    createdAt: Date.now()
  }
];

if (!fs.existsSync(MACROS_FILE)) {
  fs.writeFileSync(MACROS_FILE, JSON.stringify(DEFAULT_MACROS, null, 2));
}

export function getMacros() {
  try {
    const data = fs.readFileSync(MACROS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return DEFAULT_MACROS;
  }
}

export function getMacroById(id) {
  const macros = getMacros();
  return macros.find(m => m.id === id) || null;
}

export function saveMacro(macro) {
  const macros = getMacros();

  const newMacro = {
    id: macro.id || `macro-${Date.now()}`,
    name: macro.name || 'Untitled Macro',
    description: macro.description || '',
    kind: macro.kind === 'agent' ? 'agent' : 'command',
    steps: macro.steps || [],
    schedule: macro.schedule || null,
    createdAt: Date.now()
  };
  if (Array.isArray(macro.primitives) && macro.primitives.length) {
    newMacro.primitives = macro.primitives;
  }

  macros.push(newMacro);
  fs.writeFileSync(MACROS_FILE, JSON.stringify(macros, null, 2));

  return { success: true, macro: newMacro };
}

export function updateMacro(id, updates) {
  const macros = getMacros();
  const index = macros.findIndex(m => m.id === id);

  if (index === -1) {
    return { success: false, error: 'Macro not found' };
  }

  macros[index] = { ...macros[index], ...updates };
  fs.writeFileSync(MACROS_FILE, JSON.stringify(macros, null, 2));

  return { success: true, macro: macros[index] };
}

export function deleteMacro(id) {
  let macros = getMacros();
  const before = macros.length;
  macros = macros.filter(m => m.id !== id);

  if (macros.length === before) {
    return { success: false, error: 'Macro not found' };
  }

  fs.writeFileSync(MACROS_FILE, JSON.stringify(macros, null, 2));
  return { success: true, message: 'Macro deleted' };
}

const DEFAULT_PRIMITIVE_DELAY_MS = 700;

/**
 * Run a macro.
 *
 * Two flavours share this driver:
 *  - `kind: 'command'` (the original) — each step is natural language, run
 *    through `executeCommand`, i.e. the NLP pipeline.
 *  - `kind: 'agent'` — each step is a raw primitive captured from an agent run,
 *    replayed through `executePrimitive` with no model call at all.
 *
 * Both executors are injected so this module stays free of ADB and AI imports.
 */
export async function executeMacro(id, executeCommand, onStep, executePrimitive) {
  const macro = getMacroById(id);
  if (!macro) {
    return { success: false, error: 'Macro not found' };
  }

  const replayPrimitives = macro.kind === 'agent'
    && Array.isArray(macro.primitives)
    && macro.primitives.length > 0;

  if (replayPrimitives && typeof executePrimitive !== 'function') {
    return { success: false, error: 'This macro replays recorded actions, which are not available here' };
  }

  const items = replayPrimitives ? macro.primitives : macro.steps;
  const results = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const label = replayPrimitives ? (item.label || item.name) : item.command;

    if (onStep) {
      onStep({
        macroId: id,
        macroName: macro.name,
        stepIndex: i,
        totalSteps: items.length,
        command: label,
        status: 'executing'
      });
    }

    try {
      if (replayPrimitives) await executePrimitive(item.name, item.input || {});
      else await executeCommand(item.command);

      results.push({ step: i, command: label, success: true });

      if (onStep) {
        onStep({
          macroId: id,
          stepIndex: i,
          totalSteps: items.length,
          command: label,
          status: 'success'
        });
      }
    } catch (error) {
      results.push({ step: i, command: label, success: false, error: error.message });

      if (onStep) {
        onStep({
          macroId: id,
          stepIndex: i,
          totalSteps: items.length,
          command: label,
          status: 'failed',
          error: error.message
        });
      }
    }

    const delay = item.delay ?? (replayPrimitives ? DEFAULT_PRIMITIVE_DELAY_MS : 0);
    if (delay && i < items.length - 1) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  return {
    success: results.every(r => r.success),
    macroName: macro.name,
    results,
    totalSteps: items.length,
    successCount: results.filter(r => r.success).length
  };
}
