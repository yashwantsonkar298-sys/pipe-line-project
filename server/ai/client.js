import { getProviderClient, isProviderReady, providerName } from './provider.js';

/**
 * Default model. `gemini-3.8-flash` is Google's Flash model aimed at
 * long-horizon agentic work, and it is reachable on the AI Studio free tier.
 * Override with NEXUSFLOW_AI_MODEL if a newer id ships.
 */
export const AI_MODEL = process.env.NEXUSFLOW_AI_MODEL || 'gemini-3.8-flash';

export function isAiEnabled() {
  return isProviderReady();
}

export function getClient() {
  return getProviderClient();
}

export { providerName };
