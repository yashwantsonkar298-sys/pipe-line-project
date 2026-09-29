/**
 * Step / cost budget and kill-switch for one agent run.
 *
 * The loop calls `checkBeforeStep()` at the top of every round; it returns a
 * stop reason (or null) instead of throwing, so the loop can always finish
 * cleanly and emit a `agent_done` event with a reason the UI can show.
 */

// USD per million tokens for the default model in ai/client.js. On the AI
// Studio free tier the real cost is zero — this only powers the on-screen meter
// and the runaway-loop cap, so an approximate paid-tier rate is the useful
// thing to show. Keep it in step with the model, or the cap means something
// else than it says.
//
// On free tier the *binding* limit is requests per minute, not dollars; that is
// enforced separately by the provider throttle (`aiRequestsPerMinute`).
const PRICE_PER_MTOK = Object.freeze({ input: 0.3, output: 2.5 });

export const STOP_REASONS = Object.freeze({
  STEP_CAP: 'step_cap',
  COST_CAP: 'cost_cap',
  ABORTED: 'aborted'
});

export function estimateCostUsd({ inputTokens = 0, outputTokens = 0 } = {}) {
  const input = Math.max(0, Number(inputTokens) || 0);
  const output = Math.max(0, Number(outputTokens) || 0);
  return (input * PRICE_PER_MTOK.input + output * PRICE_PER_MTOK.output) / 1_000_000;
}

export class AgentBudget {
  constructor({ maxSteps = 25, costCapUsd = 0.5 } = {}) {
    this.maxSteps = Math.max(1, Math.round(Number(maxSteps) || 25));
    this.costCapUsd = Math.max(0.01, Number(costCapUsd) || 0.5);
    this.steps = 0;
    this.requests = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.aborted = false;
    this.abortReason = null;
  }

  abort(reason = 'user') {
    this.aborted = true;
    this.abortReason = reason;
  }

  /**
   * Record token usage from one `messages.create` response.
   *
   * The provider adapter normalizes vendor field names into
   * `input_tokens` / `output_tokens` / `cache_read_input_tokens` before this
   * sees them (Gemini's thinking tokens are folded into the output count, since
   * they are generated and billed like output).
   */
  recordUsage(usage) {
    if (!usage) return;
    this.requests += 1;
    this.inputTokens += Number(usage.input_tokens) || 0;
    this.inputTokens += Number(usage.cache_read_input_tokens) || 0;
    this.outputTokens += Number(usage.output_tokens) || 0;
  }

  countStep() {
    this.steps += 1;
    return this.steps;
  }

  get costUsd() {
    return estimateCostUsd({ inputTokens: this.inputTokens, outputTokens: this.outputTokens });
  }

  /**
   * @returns {null|{reason: string, message: string}} null = keep going.
   */
  checkBeforeStep() {
    if (this.aborted) {
      return { reason: STOP_REASONS.ABORTED, message: 'Stopped by the user.' };
    }
    if (this.steps >= this.maxSteps) {
      return {
        reason: STOP_REASONS.STEP_CAP,
        message: `Reached the ${this.maxSteps}-step limit without finishing.`
      };
    }
    if (this.costUsd >= this.costCapUsd) {
      return {
        reason: STOP_REASONS.COST_CAP,
        message: `Reached the $${this.costCapUsd.toFixed(2)} cost cap for this run.`
      };
    }
    return null;
  }

  /** Compact snapshot for the live meter in the UI. */
  snapshot() {
    return {
      steps: this.steps,
      maxSteps: this.maxSteps,
      requests: this.requests,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.inputTokens + this.outputTokens,
      costUsd: Number(this.costUsd.toFixed(4)),
      costCapUsd: this.costCapUsd,
      aborted: this.aborted
    };
  }
}
