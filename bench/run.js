/**
 * Vani Autopilot benchmark.
 *
 *   npm run bench                 # every task
 *   npm run bench -- airplane     # only tasks whose id contains "airplane"
 *
 * Needs a real phone on USB with debugging enabled, and GEMINI_API_KEY set.
 * The provider paces itself to the configured requests-per-minute, so a full
 * run on the free tier takes a while — that is the quota, not the agent.
 * Prints a per-task table and the headline success rate.
 */

import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env before any of the dynamic imports below read process.env at module
// scope (notably ai/client.js and its AI_MODEL). See server/env.js.
await import('../server/env.js');

const { runAgentTask } = await import('../server/agent/agentLoop.js');
const { getDeviceDiagnostics } = await import('../server/adb.js');
const { isAiEnabled, AI_MODEL } = await import('../server/ai/client.js');
const { readConfig } = await import('../server/config/index.js');
const { TASKS } = await import('./tasks.js');

const filter = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const tasks = filter.length
  ? TASKS.filter((t) => filter.some((f) => t.id.includes(f)))
  : TASKS;

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bail(message) {
  console.error(C.red(`\n  ${message}\n`));
  process.exit(1);
}

if (!isAiEnabled()) bail('GEMINI_API_KEY is not set — get a free key at aistudio.google.com, put it in .env and retry.');
if (!tasks.length) bail(`No tasks matched ${JSON.stringify(filter.join(' '))}.`);

const diagnostics = await getDeviceDiagnostics();
if (!diagnostics.connected) bail('No device connected. Plug the phone in with USB debugging enabled.');

const deviceId = diagnostics.deviceId;
const config = { ...readConfig(), agentDryRun: false };

console.log(C.bold('\n  Vani Autopilot benchmark'));
console.log(C.dim(`  device ${diagnostics.brand} ${diagnostics.model} · Android ${diagnostics.androidVersion}`));
console.log(C.dim(`  model  ${AI_MODEL} · up to ${config.agentMaxSteps} steps, $${config.agentCostCapUsd} cap per task\n`));

const results = [];

for (const task of tasks) {
  process.stdout.write(`  ${task.id.padEnd(18)} `);

  try { await task.setup?.(deviceId); } catch {  }
  await sleep(800);

  const startedAt = Date.now();
  let confirmsRequested = 0;
  let outcome;

  try {
    outcome = await runAgentTask({
      text: task.prompt,
      deviceId,
      config,
      session: {},
      // Bench tasks are all reversible settings changes; nothing here should
      // trip the safety gate. If something does, that is a result worth seeing.
      actionCtx: { confirm: async () => { confirmsRequested += 1; return false; } },
      onEvent: (e) => {
        if (e.type === 'agent_action') process.stdout.write(C.dim('·'));
      }
    });
  } catch (error) {
    outcome = { ok: false, reason: 'crash', summary: error.message, steps: 0, costUsd: 0 };
  }

  const seconds = (Date.now() - startedAt) / 1000;
  await sleep(1200);

  let passed = false;
  let checkError = null;
  try {
    passed = Boolean(await task.check(deviceId));
  } catch (error) {
    checkError = error.message;
  }

  try { await task.restore?.(deviceId); } catch {  }

  results.push({
    id: task.id,
    passed,
    steps: outcome.steps || 0,
    seconds,
    costUsd: outcome.costUsd || 0,
    reason: outcome.reason,
    summary: outcome.summary,
    confirmsRequested,
    checkError
  });

  const verdict = passed ? C.green(' PASS') : C.red(' FAIL');
  const detail = C.dim(`${outcome.steps || 0} steps · ${seconds.toFixed(1)}s · $${(outcome.costUsd || 0).toFixed(3)}`);
  console.log(`${verdict}  ${detail}`);
  if (!passed) {
    console.log(C.dim(`      ${checkError ? `checker error: ${checkError}` : `${outcome.reason}: ${outcome.summary}`}`));
  }
  if (confirmsRequested) {
    console.log(C.yellow(`      safety gate asked for confirmation ${confirmsRequested}× (auto-declined)`));
  }
}

// ------------------------------------------------------------------ summary --

const passed = results.filter((r) => r.passed);
const rate = (passed.length / results.length) * 100;
const median = (nums) => {
  const s = [...nums].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
const totalCost = results.reduce((sum, r) => sum + r.costUsd, 0);

console.log(C.bold('\n  ─────────────────────────────────────────────'));
console.log(`  ${C.bold('Success rate')}   ${rate >= 70 ? C.green(`${passed.length}/${results.length}  (${rate.toFixed(0)}%)`) : C.yellow(`${passed.length}/${results.length}  (${rate.toFixed(0)}%)`)}`);
console.log(`  Median steps   ${median(results.map((r) => r.steps))}`);
console.log(`  Median time    ${median(results.map((r) => r.seconds)).toFixed(1)}s`);
console.log(`  Cost / task    $${(totalCost / results.length).toFixed(3)}  (total $${totalCost.toFixed(3)})`);
console.log(C.bold('  ─────────────────────────────────────────────\n'));

process.exit(passed.length === results.length ? 0 : 1);
