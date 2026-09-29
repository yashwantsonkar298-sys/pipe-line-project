/**
 * The skill library: what the agent remembers between runs.
 *
 * Two tiers, because they pay off differently:
 *
 *   exact   — the task fits a learned template. Replay the recording; the model
 *             is never called. Free, and several times faster.
 *   similar — nothing fits exactly, but related runs exist. They go into the
 *             planning prompt as worked examples, so the model starts from what
 *             worked before instead of from nothing.
 *
 * Only successful runs are learned from. A failed run is a recording of how to
 * get it wrong, and replaying that confidently is worse than not remembering.
 */

import { embedText, cosine, lexicalScore } from './embed.js';
import { distill, matchTemplate } from './distill.js';
import * as store from './store.js';

/** Below this a "similar" run is unrelated noise and only crowds the prompt. */
const SIMILARITY_FLOOR = 0.55;
const MAX_HINTS = 2;

/**
 * A skill that keeps failing on replay has gone stale — the app moved on. Stop
 * trusting it for exact replay; it can still serve as a hint.
 */
function isTrustworthy(skill) {
  if (skill.uses < 2) return true;
  return skill.successes / skill.uses >= 0.5;
}

/**
 * @returns {Promise<{exact: object|null, values: object, similar: object[]}>}
 */
export async function recall(task, { embed = embedText, limit = MAX_HINTS } = {}) {
  const text = String(task ?? '').trim();
  const empty = { exact: null, values: {}, similar: [] };
  if (!text) return empty;

  let skills;
  try {
    skills = store.listSkills({ limit: 200 });
  } catch {
    // A broken or unwritable database must not take the agent down with it.
    return empty;
  }
  if (!skills.length) return empty;

  // Tier 1: a template that accepts this task outright.
  let exact = null;
  let values = {};
  for (const skill of skills) {
    const match = matchTemplate(skill.template || skill.task, text);
    if (!match || !isTrustworthy(skill)) continue;
    // Prefer the skill with the better track record, then the more recent.
    if (!exact || skill.successes > exact.successes) {
      exact = skill;
      values = match;
    }
  }
  if (exact) return { exact, values, similar: [] };

  // Tier 2: nearest neighbours as worked examples.
  const vector = await embed(text);
  const scored = skills
    .map((skill) => ({
      skill,
      score: vector && skill.embedding
        ? cosine(vector, skill.embedding)
        : lexicalScore(text, skill.task)
    }))
    .filter((entry) => entry.score >= SIMILARITY_FLOOR)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return { exact: null, values: {}, similar: scored };
}

/**
 * Fold a finished run into the library. Never throws: failing to remember a run
 * is not a reason to fail the run.
 *
 * @returns {Promise<object|null>} the stored skill, or null if nothing was learned.
 */
export async function learn(trace, result, { embed = embedText } = {}) {
  try {
    if (!result?.ok) return null;
    // A dry run never touched the phone, so its steps were never proven.
    if (trace?.dryRun) return null;

    const skill = distill(trace);
    if (!skill) return null;

    skill.embedding = await embed(skill.template);
    return store.saveSkill(skill);
  } catch {
    return null;
  }
}

/** Worked examples, rendered for the planning prompt. */
export function formatHints(similar) {
  if (!similar?.length) return '';

  const blocks = similar.map(({ skill, score }) => {
    const steps = skill.steps
      .map((s, i) => `    ${i + 1}. ${s.description || s.name}`)
      .join('\n');
    return `  Task: "${skill.task}" (${Math.round(score * 100)}% similar)\n${steps}`;
  });

  return [
    'You have done related things before. These runs succeeded:',
    ...blocks,
    'Use them as a guide, not a script — verify against the screen you actually see.'
  ].join('\n');
}

/**
 * A library that remembers nothing.
 *
 * This is what `runAgentTask` uses unless a caller passes the real module, so
 * the loop stays pure by default: tests neither touch SQLite nor reach the
 * embedding API, and the benchmark can run the same task with memory on and off
 * to measure what it is actually worth.
 */
export const NULL_SKILLS = Object.freeze({
  recall: async () => ({ exact: null, values: {}, similar: [] }),
  learn: async () => null,
  formatHints: () => '',
  store: { recordUse() {  } }
});

export { store };
