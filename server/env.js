/**
 * Loads `.env` before anything else runs.
 *
 * This has to be its own module, imported first. ES module imports are
 * evaluated before any statement in the importing file, so calling
 * `loadEnvFile()` partway down `index.js` was too late: `ai/client.js` had
 * already been evaluated and had already read `process.env.NEXUSFLOW_AI_MODEL`
 * — which was still undefined. The symptom was a `.env` model setting being
 * silently ignored while the API key (read lazily) worked fine.
 *
 * Anything that reads `process.env` at module scope depends on this running
 * first, so import it at the very top of every entry point.
 */

import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let loaded = false;

export function loadEnv() {
  if (loaded) return;
  loaded = true;
  try {
    process.loadEnvFile(path.join(__dirname, '..', '.env'));
    console.log('[CONFIG] Loaded .env');
  } catch {
    // No .env is a normal setup — real environment variables still apply.
  }
}

loadEnv();
