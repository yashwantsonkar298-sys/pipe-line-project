import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentBudget, estimateCostUsd, STOP_REASONS } from '../server/agent/budget.js';

test('a fresh budget allows the first step', () => {
  const budget = new AgentBudget({ maxSteps: 3, costCapUsd: 1 });
  assert.equal(budget.checkBeforeStep(), null);
  assert.equal(budget.steps, 0);
});

test('the step cap stops the run once the budget is spent', () => {
  const budget = new AgentBudget({ maxSteps: 2, costCapUsd: 1 });
  assert.equal(budget.checkBeforeStep(), null);
  budget.countStep();
  assert.equal(budget.checkBeforeStep(), null);
  budget.countStep();

  const stop = budget.checkBeforeStep();
  assert.equal(stop.reason, STOP_REASONS.STEP_CAP);
  assert.match(stop.message, /2-step limit/);
});

test('the cost cap stops the run', () => {
  const budget = new AgentBudget({ maxSteps: 100, costCapUsd: 0.05 });
  budget.recordUsage({ input_tokens: 20_000_000, output_tokens: 0 });

  const stop = budget.checkBeforeStep();
  assert.equal(stop.reason, STOP_REASONS.COST_CAP);
  assert.match(stop.message, /\$0\.05 cost cap/);
});

test('abort takes precedence over every other limit', () => {
  const budget = new AgentBudget({ maxSteps: 100, costCapUsd: 100 });
  budget.abort('user');

  const stop = budget.checkBeforeStep();
  assert.equal(stop.reason, STOP_REASONS.ABORTED);
  assert.equal(budget.abortReason, 'user');
  assert.match(stop.message, /Stopped by the user/);
});

test('usage accumulates across turns, including cache reads', () => {
  const budget = new AgentBudget();
  budget.recordUsage({ input_tokens: 100, output_tokens: 50 });
  budget.recordUsage({ input_tokens: 200, cache_read_input_tokens: 300, output_tokens: 25 });

  assert.equal(budget.inputTokens, 600);
  assert.equal(budget.outputTokens, 75);
});

test('recordUsage tolerates missing or partial usage objects', () => {
  const budget = new AgentBudget();
  budget.recordUsage(undefined);
  budget.recordUsage(null);
  budget.recordUsage({});
  assert.equal(budget.inputTokens, 0);
  assert.equal(budget.outputTokens, 0);
});

test('estimateCostUsd prices input and output separately', () => {
  // Rates track the default model in ai/client.js (gemini-3.8-flash).
  assert.equal(estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 0 }), 0.3);
  assert.equal(estimateCostUsd({ inputTokens: 0, outputTokens: 1_000_000 }), 2.5);
  assert.equal(estimateCostUsd({}), 0);
  assert.ok(estimateCostUsd({ inputTokens: 0, outputTokens: 1 }) > estimateCostUsd({ inputTokens: 1, outputTokens: 0 }),
    'output tokens cost more than input tokens');
});

test('constructor arguments are clamped to sane values', () => {
  const zero = new AgentBudget({ maxSteps: 0, costCapUsd: 0 });
  assert.ok(zero.maxSteps >= 1);
  assert.ok(zero.costCapUsd >= 0.01);

  const garbage = new AgentBudget({ maxSteps: 'lots', costCapUsd: NaN });
  assert.equal(garbage.maxSteps, 25);
  assert.equal(garbage.costCapUsd, 0.5);
});

test('snapshot exposes what the live meter needs', () => {
  const budget = new AgentBudget({ maxSteps: 8, costCapUsd: 0.25 });
  budget.countStep();
  budget.recordUsage({ input_tokens: 1000, output_tokens: 100 });

  const snap = budget.snapshot();
  assert.deepEqual(Object.keys(snap).sort(), [
    'aborted', 'costCapUsd', 'costUsd', 'inputTokens', 'maxSteps',
    'outputTokens', 'requests', 'steps', 'totalTokens'
  ]);
  assert.equal(snap.steps, 1);
  assert.equal(snap.maxSteps, 8);
  assert.equal(snap.aborted, false);
  assert.equal(snap.requests, 1, 'one API call was recorded');
  assert.equal(snap.totalTokens, 1100, 'the meter leads with tokens, which is what the free tier counts');
  assert.ok(snap.costUsd > 0 && snap.costUsd < 0.25);
});
