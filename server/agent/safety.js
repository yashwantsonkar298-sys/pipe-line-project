/**
 * Guardrails for the phone-use agent.
 *
 * The agent drives a real phone with a real SIM and real payment apps, so every
 * action is classified *before* it runs:
 *
 *   safe    → execute immediately
 *   confirm → ask the human first (or, in dry-run, narrate and skip)
 *   block   → never execute; the agent must ask the user to do it themselves
 *
 * Classification is deliberately conservative and text-based: it reads the
 * label of the element being touched plus the surrounding screen, so it works
 * in any app without per-app rules.
 */

export const RISK = Object.freeze({
  SAFE: 'safe',
  CONFIRM: 'confirm',
  BLOCK: 'block'
});

/** Buttons that spend money, contact someone, or destroy data. */
const IRREVERSIBLE_LABEL = new RegExp([
  '\\b(pay|paying|payment|buy|purchase|order|checkout|place\\s*order|confirm\\s*order)\\b',
  '\\b(subscribe|renew|upgrade|donate|transfer|withdraw|send\\s*money|book\\s*now)\\b',
  '\\b(send|submit|post|publish|share)\\b',
  '\\b(delete|remove|uninstall|erase|format|factory\\s*reset|clear\\s*all|discard)\\b',
  '\\b(call|dial|video\\s*call|voice\\s*call)\\b',
  '\\b(log\\s*out|sign\\s*out|deactivate|close\\s*account)\\b',
  // Hinglish surfaces on Indian apps and in agent-typed text alike.
  '(bhejo|bhej\\s*do|kharido|order\\s*karo|delete\\s*karo|hata\\s*do)'
].join('|'), 'i');

/** Screens where any confirmation-looking tap should be checked with a human. */
const PAYMENT_CONTEXT = new RegExp([
  '\\b(upi|cvv|card\\s*number|expiry|net\\s*banking|wallet)\\b',
  '\\b(total\\s*amount|amount\\s*payable|grand\\s*total|order\\s*summary)\\b',
  '\\b(payment\\s*method|place\\s*order|proceed\\s*to\\s*pay)\\b'
].join('|'), 'i');

/** Fields whose contents must never be produced by a model. */
const SECRET_FIELD = /\b(otp|o\.?t\.?p|cvv|pin|passcode|password|passphrase|seed\s*phrase|mpin)\b/i;

/** Packages where money moves; a tap here is never "safe" by default. */
const SENSITIVE_PACKAGE = /(paytm|phonepe|googlepay|google\.android\.apps\.nbu|bhim|upi|\.bank|banking|razorpay|cred\b)/i;

const TAP_ACTIONS = new Set(['tap_element', 'tap_xy']);

function decide(risk, reason) {
  return { risk, reason };
}

function screenText(state) {
  return (state?.elements || []).map((e) => e.label).filter(Boolean).join(' · ');
}

/** A bare 3-8 digit code, or a card-length number — never something to guess. */
function looksLikeSecret(text) {
  const trimmed = String(text).trim();
  return /^\d{3,8}$/.test(trimmed) || /^[\d\s-]{13,19}$/.test(trimmed);
}

/** Does this screen contain a credential field at all? */
function hasSecretField(state) {
  return (state?.elements || []).some((e) => e.password || SECRET_FIELD.test(e.label || ''));
}

/**
 * Is the foreground app allowed at all?
 * An empty allowlist means "any app" — the default, so demos are not annoying.
 */
export function checkAppAllowlist(state, allowlist = []) {
  const list = Array.isArray(allowlist) ? allowlist.filter(Boolean) : [];
  if (!list.length) return decide(RISK.SAFE, 'allowlist not configured');
  const pkg = state?.appPackage;
  if (!pkg) return decide(RISK.SAFE, 'foreground app unknown');
  const allowed = list.some((entry) => pkg === entry || pkg.startsWith(`${entry}.`));
  return allowed
    ? decide(RISK.SAFE, `${pkg} is on the allowlist`)
    : decide(RISK.BLOCK, `${pkg} is not on the agent app allowlist`);
}

/**
 * Classify one primitive action against the screen it will run on.
 *
 * @param {{name: string, input: object, target?: object}} action
 * @param {object} state    ScreenState from perception.js
 * @param {{appAllowlist?: string[]}} [options]
 * @returns {{risk: string, reason: string}}
 */
export function classifyAction(action, state, options = {}) {
  const name = String(action?.name || '');
  const input = action?.input || {};
  const target = action?.target || null;

  // Purely local / read-only primitives never need a gate.
  if (name === 'screenshot' || name === 'wait' || name === 'finish' || name === 'ask_user') {
    return decide(RISK.SAFE, 'non-mutating primitive');
  }

  const allowlist = checkAppAllowlist(state, options.appAllowlist);
  if (allowlist.risk === RISK.BLOCK) return allowlist;

  if (name === 'type_text') {
    const text = String(input.text ?? '');
    const focused = (state?.elements || []).find((e) => e.focused);

    if (target?.password) {
      return decide(RISK.BLOCK, 'refusing to type into a password field');
    }
    if (focused?.password) {
      return decide(RISK.BLOCK, 'the focused field is a password field');
    }
    if (SECRET_FIELD.test(target?.label || '') || SECRET_FIELD.test(focused?.label || '')) {
      return decide(RISK.BLOCK, 'refusing to fill an OTP/PIN/CVV field');
    }

    // Focus is not always reported in the hierarchy dump, so also refuse when
    // the screen itself is a credential screen and the text looks like a code.
    if (looksLikeSecret(text) && hasSecretField(state)) {
      return decide(RISK.BLOCK, 'this screen asks for a credential and the text looks like one');
    }

    if (IRREVERSIBLE_LABEL.test(text)) {
      return decide(RISK.CONFIRM, 'the text being typed reads as an irreversible instruction');
    }
    return decide(RISK.SAFE, 'ordinary text entry');
  }

  if (TAP_ACTIONS.has(name)) {
    const label = String(target?.label || '');
    if (target?.password || SECRET_FIELD.test(label)) {
      return decide(RISK.CONFIRM, 'tapping a credential field');
    }
    if (IRREVERSIBLE_LABEL.test(label)) {
      return decide(RISK.CONFIRM, `"${label}" looks irreversible`);
    }
    if (SENSITIVE_PACKAGE.test(state?.appPackage || '')) {
      return decide(RISK.CONFIRM, `${state.appPackage} handles payments`);
    }
    if (PAYMENT_CONTEXT.test(screenText(state))) {
      return decide(RISK.CONFIRM, 'this looks like a payment or checkout screen');
    }
    // A blind coordinate tap on a screen we could not read gets a lighter touch:
    // it is allowed, because tap_xy is the only fallback on a degraded screen.
    return decide(RISK.SAFE, 'ordinary tap');
  }

  if (name === 'press_key') {
    const key = String(input.key || '').toLowerCase();
    if (key === 'power') return decide(RISK.CONFIRM, 'the power key can lock or reboot the device');
    return decide(RISK.SAFE, 'navigation key');
  }

  if (name === 'open_app' || name === 'swipe') {
    return decide(RISK.SAFE, name === 'swipe' ? 'scrolling' : 'launching an app');
  }

  // Unknown primitive: fail closed.
  return decide(RISK.CONFIRM, `unrecognised action "${name}"`);
}

/**
 * Human-readable one-liner for the confirmation dialog and the trace.
 */
export function describeAction(action, target) {
  const name = String(action?.name || '');
  const input = action?.input || {};
  const label = target?.label ? `"${target.label}"` : null;

  switch (name) {
    case 'tap_element': return `Tap ${label || `element #${input.index}`}`;
    case 'tap_xy': return `Tap at (${input.x}, ${input.y})`;
    case 'type_text': return `Type "${String(input.text ?? '').slice(0, 60)}"`;
    case 'swipe': return `Swipe ${input.direction || 'custom'}`;
    case 'press_key': return `Press ${input.key}`;
    case 'open_app': return `Open ${input.appName}`;
    case 'wait': return `Wait ${input.ms}ms`;
    case 'screenshot': return 'Take a screenshot';
    case 'ask_user': return `Ask: ${String(input.question ?? '').slice(0, 60)}`;
    case 'finish': return `Finish: ${String(input.summary ?? '').slice(0, 60)}`;
    default: return name || 'unknown action';
  }
}
