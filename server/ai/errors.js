/**
 * Provider-neutral AI errors.
 *
 * The agent loop and the assistant branch on these to decide what to tell the
 * user. Keeping them ours rather than a vendor SDK's is what lets the provider
 * underneath change without touching either caller.
 */

export class AiError extends Error {
  constructor(message, { status = null, code = null, cause = null } = {}) {
    super(message);
    this.name = 'AiError';
    this.status = status;
    this.code = code;
    if (cause) this.cause = cause;
  }
}

/** The key is missing, malformed, or rejected. */
export class AiAuthError extends AiError {
  constructor(message = 'The AI API key is missing or invalid.', options) {
    super(message, options);
    this.name = 'AiAuthError';
  }
}

/** Quota or requests-per-minute exhausted. `retryAfterMs` when the server said so. */
export class AiRateLimitError extends AiError {
  constructor(message = 'The AI provider is rate-limiting this key.', options = {}) {
    super(message, options);
    this.name = 'AiRateLimitError';
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

/** Could not reach the provider at all — DNS, TLS, offline, timeout. */
export class AiConnectionError extends AiError {
  constructor(message = 'Could not reach the AI provider.', options) {
    super(message, options);
    this.name = 'AiConnectionError';
  }
}

/** The model declined on safety grounds. */
export class AiSafetyError extends AiError {
  constructor(message = 'The model declined this request.', options) {
    super(message, options);
    this.name = 'AiSafetyError';
  }
}

/**
 * One place that turns any thrown error into the sentence a user should read.
 * Both the assistant and the agent loop use this, so the wording stays in step.
 */
export function describeAiError(error) {
  if (error instanceof AiRateLimitError) {
    return 'The AI is rate-limited right now — the free tier allows only a few requests per minute. Wait a moment and try again.';
  }
  if (error instanceof AiAuthError) {
    return 'The GEMINI_API_KEY on this server is missing or invalid. Get a free key at aistudio.google.com.';
  }
  if (error instanceof AiConnectionError) {
    return "Could not reach the AI provider — check the server's internet connection.";
  }
  if (error instanceof AiSafetyError) {
    return "The model declined that request.";
  }
  return `AI error: ${error?.message || 'unknown'}`;
}
