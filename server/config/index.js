import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(__dirname, '..');

export const CONFIG_FILE = path.join(SERVER_DIR, 'config.json');
export const CONTACTS_FILE = path.join(SERVER_DIR, 'contacts.json');
export const MACROS_FILE = path.join(SERVER_DIR, 'macros.json');
export const RUNTIME_DIR = path.join(SERVER_DIR, '.runtime');
export const TRACES_DIR = path.join(RUNTIME_DIR, 'traces');

export const DEFAULT_CONFIG = Object.freeze({
  unlockPin: '',
  autoUnlock: false,
  whatsappCoords: { x: 0.91, y: 0.55 },
  agentMode: true,
  agentDryRun: false,
  agentMaxSteps: 25,
  agentCostCapUsd: 0.5,
  agentAppAllowlist: [],
  // Free-tier Gemini limits requests per minute, so the agent paces itself.
  aiRequestsPerMinute: 10
});

export const AGENT_LIMITS = Object.freeze({
  maxStepsCeiling: 60,
  costCapCeiling: 5,
  requestsPerMinuteCeiling: 60
});

export const CONFIG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    unlockPin: { type: 'string', pattern: '^[0-9]{0,16}$' },
    autoUnlock: { type: 'boolean' },
    whatsappCoords: {
      type: 'object',
      additionalProperties: false,
      properties: {
        x: { type: 'number', minimum: 0, maximum: 1 },
        y: { type: 'number', minimum: 0, maximum: 1 }
      },
      required: ['x', 'y']
    },
    agentMode: { type: 'boolean' },
    agentDryRun: { type: 'boolean' },
    agentMaxSteps: { type: 'integer', minimum: 1, maximum: AGENT_LIMITS.maxStepsCeiling },
    agentCostCapUsd: { type: 'number', minimum: 0.01, maximum: AGENT_LIMITS.costCapCeiling },
    agentAppAllowlist: {
      type: 'array',
      maxItems: 50,
      items: { type: 'string', minLength: 1, maxLength: 120 }
    },
    aiRequestsPerMinute: {
      type: 'integer',
      minimum: 1,
      maximum: AGENT_LIMITS.requestsPerMinuteCeiling
    }
  }
};

export const CONTACTS_SCHEMA = {
  type: 'array',
  maxItems: 2000,
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', maxLength: 64 },
      name: { type: 'string', minLength: 1, maxLength: 80 },
      number: { type: 'string', pattern: '^\\+?[0-9]{6,15}$' }
    },
    required: ['name', 'number']
  }
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function readConfig() {
  const raw = readJson(CONFIG_FILE, {});
  return {
    unlockPin: typeof raw.unlockPin === 'string' ? raw.unlockPin : '',
    autoUnlock: raw.autoUnlock === true,
    whatsappCoords: {
      x: Number(raw?.whatsappCoords?.x ?? DEFAULT_CONFIG.whatsappCoords.x),
      y: Number(raw?.whatsappCoords?.y ?? DEFAULT_CONFIG.whatsappCoords.y)
    },
    agentMode: raw.agentMode !== false,
    agentDryRun: raw.agentDryRun === true,
    agentMaxSteps: Math.round(
      clampNumber(raw.agentMaxSteps, DEFAULT_CONFIG.agentMaxSteps, 1, AGENT_LIMITS.maxStepsCeiling)
    ),
    agentCostCapUsd: clampNumber(
      raw.agentCostCapUsd, DEFAULT_CONFIG.agentCostCapUsd, 0.01, AGENT_LIMITS.costCapCeiling
    ),
    agentAppAllowlist: Array.isArray(raw.agentAppAllowlist)
      ? raw.agentAppAllowlist.filter((s) => typeof s === 'string' && s.trim()).slice(0, 50)
      : [],
    aiRequestsPerMinute: Math.round(
      clampNumber(raw.aiRequestsPerMinute, DEFAULT_CONFIG.aiRequestsPerMinute, 1, AGENT_LIMITS.requestsPerMinuteCeiling)
    )
  };
}

export function writeConfig(next) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
}

export function readPublicConfig() {
  const cfg = readConfig();
  return {
    whatsappCoords: cfg.whatsappCoords,
    unlockPin: '',
    hasUnlockPin: Boolean(cfg.unlockPin),
    autoUnlock: cfg.autoUnlock,
    agentMode: cfg.agentMode,
    agentDryRun: cfg.agentDryRun,
    agentMaxSteps: cfg.agentMaxSteps,
    agentCostCapUsd: cfg.agentCostCapUsd,
    agentAppAllowlist: cfg.agentAppAllowlist,
    aiRequestsPerMinute: cfg.aiRequestsPerMinute
  };
}

export function mergeConfig(body) {
  const current = readConfig();
  const pin = typeof body.unlockPin === 'string' && body.unlockPin.length
    ? body.unlockPin
    : current.unlockPin;
  return {
    unlockPin: pin,
    autoUnlock: typeof body.autoUnlock === 'boolean' ? body.autoUnlock : current.autoUnlock,
    whatsappCoords: body.whatsappCoords ?? current.whatsappCoords,
    agentMode: typeof body.agentMode === 'boolean' ? body.agentMode : current.agentMode,
    agentDryRun: typeof body.agentDryRun === 'boolean' ? body.agentDryRun : current.agentDryRun,
    agentMaxSteps: Number.isFinite(Number(body.agentMaxSteps))
      ? Math.round(clampNumber(body.agentMaxSteps, current.agentMaxSteps, 1, AGENT_LIMITS.maxStepsCeiling))
      : current.agentMaxSteps,
    agentCostCapUsd: Number.isFinite(Number(body.agentCostCapUsd))
      ? clampNumber(body.agentCostCapUsd, current.agentCostCapUsd, 0.01, AGENT_LIMITS.costCapCeiling)
      : current.agentCostCapUsd,
    agentAppAllowlist: Array.isArray(body.agentAppAllowlist)
      ? body.agentAppAllowlist.filter((s) => typeof s === 'string' && s.trim()).slice(0, 50)
      : current.agentAppAllowlist,
    aiRequestsPerMinute: Number.isFinite(Number(body.aiRequestsPerMinute))
      ? Math.round(clampNumber(body.aiRequestsPerMinute, current.aiRequestsPerMinute, 1, AGENT_LIMITS.requestsPerMinuteCeiling))
      : current.aiRequestsPerMinute
  };
}

export function readContacts() {
  const list = readJson(CONTACTS_FILE, []);
  return Array.isArray(list) ? list : [];
}

export function writeContacts(list) {
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(list, null, 2));
}


export function getAuthToken(env = process.env) {
  const v = env.NEXUSFLOW_AUTH_TOKEN;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export function getGeminiKey(env = process.env) {
  const v = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** 'gemini' (default) or 'mock' — the offline, no-quota provider. */
export function getAiProvider(env = process.env) {
  const v = String(env.NEXUSFLOW_AI_PROVIDER || '').trim().toLowerCase();
  return v === 'mock' ? 'mock' : 'gemini';
}

export function getAllowedOrigins(env = process.env, port) {
  const raw = env.NEXUSFLOW_ALLOWED_ORIGINS;
  if (raw && raw.trim()) return raw.split(',').map((s) => s.trim()).filter(Boolean);
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
}

export function ensureRuntimeDir() {
  if (!fs.existsSync(RUNTIME_DIR)) fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  return RUNTIME_DIR;
}

export function ensureTracesDir() {
  if (!fs.existsSync(TRACES_DIR)) fs.mkdirSync(TRACES_DIR, { recursive: true });
  return TRACES_DIR;
}
