/**
 * Task embeddings for skill recall.
 *
 * "Turn on airplane mode" and "airplane mode on kar do" are the same request in
 * two languages, and a keyword index will never say so. Embeddings will, which
 * is the whole reason recall can work across the Hinglish/English mix this
 * project invites.
 *
 * Everything here degrades instead of failing: with no API key, no network, or
 * a provider that is not Gemini, `embedText` returns null and callers fall back
 * to `lexicalScore`. Recall gets worse; nothing breaks.
 */

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const EMBED_MODEL = 'gemini-embedding-001';

/**
 * 3072 is the model's native width; 768 is a Matryoshka truncation of it that
 * the API will produce directly. Skills are compared against each other and
 * nothing else, so the smaller width costs nothing real and keeps each row at
 * 3KB instead of 12KB.
 */
export const EMBED_DIMS = 768;

const TIMEOUT_MS = 10000;

/**
 * @returns {Promise<Float32Array|null>} null whenever embedding is unavailable
 *   — the caller is expected to carry on with `lexicalScore`.
 */
export async function embedText(text, { fetchImpl = fetch, apiKey = process.env.GEMINI_API_KEY } = {}) {
  const value = String(text ?? '').trim();
  if (!value || !apiKey) return null;

  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${ENDPOINT}/${EMBED_MODEL}:embedContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        model: `models/${EMBED_MODEL}`,
        content: { parts: [{ text: value }] },
        outputDimensionality: EMBED_DIMS
      }),
      signal
    });
    if (!response.ok) return null;

    const json = await response.json();
    const values = json?.embedding?.values;
    if (!Array.isArray(values) || !values.length) return null;
    return Float32Array.from(values);
  } catch {
    return null;
  }
}

/** Cosine similarity in [-1, 1]. Mismatched lengths score 0 rather than throw. */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Filler, not content. `turn` earns its place next to the Hinglish verb fillers
 * for the same reason they are here: "turn on airplane mode" and "airplane mode
 * on kar do" are one request, and the exact-match tier should see them as one.
 * `switch` is deliberately absent — it is as often a UI element as a verb.
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'on', 'off', 'my', 'me', 'please', 'now', 'turn',
  'kar', 'karo', 'kro', 'do', 'de', 'dijiye', 'ka', 'ki', 'ke', 'mera', 'meri'
]);

function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9ऀ-ॿ]+/)
    .filter((t) => t && !STOPWORDS.has(t));
}

/**
 * Dice coefficient over content words — the fallback when embeddings are
 * unavailable. Same-language paraphrases score well; cross-language ones do not,
 * which is the limitation being accepted.
 */
export function lexicalScore(a, b) {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const token of ta) if (tb.has(token)) shared++;
  return (2 * shared) / (ta.size + tb.size);
}

/** Comparable across runs, so it can key an exact-match lookup. */
export function normalizeTask(text) {
  return tokenize(text).sort().join(' ');
}

export function toBlob(vector) {
  if (!vector) return null;
  return Buffer.from(Float32Array.from(vector).buffer);
}

export function fromBlob(blob) {
  if (!blob || !blob.byteLength) return null;
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}
