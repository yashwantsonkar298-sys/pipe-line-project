/**
 * Chooses which model provider the app talks to.
 *
 * Everything upstream — the agent loop, the assistant, every test — only knows
 * the `{ messages: { create() } }` interface, so swapping providers is confined
 * to this file.
 */

import { getGeminiKey, getAiProvider, readConfig } from '../config/index.js';
import { createGeminiClient } from './gemini.js';
import { createMockClient } from './mock.js';

let cached = null;
let cacheKey = null;

/** Is a provider actually usable right now? */
export function isProviderReady(env = process.env) {
  return getAiProvider(env) === 'mock' || Boolean(getGeminiKey(env));
}

export function providerName(env = process.env) {
  return getAiProvider(env);
}

/**
 * @returns {{messages:{create:Function}, provider:string}|null} null when there
 *   is no key and the mock provider was not requested.
 */
export function getProviderClient(env = process.env) {
  const provider = getAiProvider(env);

  if (provider === 'mock') {
    if (!cached || cacheKey !== 'mock') {
      cached = createMockClient();
      cacheKey = 'mock';
    }
    return cached;
  }

  const key = getGeminiKey(env);
  if (!key) return null;

  const rpm = readConfig().aiRequestsPerMinute;
  const signature = `gemini:${key}:${rpm}`;
  if (!cached || cacheKey !== signature) {
    cached = createGeminiClient({ apiKey: key, requestsPerMinute: rpm });
    cacheKey = signature;
  }
  return cached;
}

/** Drop the memoised client — used when config changes the request pacing. */
export function resetProviderClient() {
  cached = null;
  cacheKey = null;
}
