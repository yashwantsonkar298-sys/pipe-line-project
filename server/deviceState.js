/**
 * Cached, single-flight device diagnostics.
 *
 * getDeviceDiagnostics() fans out to 5+ `adb` calls. The server health poll and
 * every client's `request_diagnostics` used to trigger that independently and
 * concurrently. This module collapses them: one in-flight probe at a time, and
 * a short result cache so bursts are answered for free.
 */

import { getDeviceDiagnostics } from './adb.js';

const DEFAULT_TTL_MS = 1500;

let cache = { at: 0, value: null };
let inFlight = null;

/**
 * @param {{maxAgeMs?:number}} [opts]
 * @returns {Promise<object>} the diagnostics object (possibly from cache)
 */
export async function getDiagnostics({ maxAgeMs = DEFAULT_TTL_MS } = {}) {
  const now = Date.now();
  if (cache.value && now - cache.at < maxAgeMs) return cache.value;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const value = await getDeviceDiagnostics();
      cache = { at: Date.now(), value };
      return value;
    } catch (error) {
      // Never let a probe failure reject every awaiting caller with a raw throw.
      const value = { connected: false, error: error.message };
      cache = { at: Date.now(), value };
      return value;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Stable per-device resource key for the job queue. */
export async function currentDeviceKey() {
  const d = await getDiagnostics();
  return d && d.connected && d.deviceId ? String(d.deviceId) : 'no-device';
}

/** Force the next getDiagnostics() call to re-probe. */
export function invalidateDiagnostics() {
  cache = { at: 0, value: null };
}
