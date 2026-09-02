/**
 * A small, dependency-free, per-resource job queue.
 *
 * Design:
 * - Each resource key owns a FIFO queue, so work for one device is serialized.
 * - Different resource keys drain independently and may run at the same time.
 * - A job is kept in the history after it reaches a terminal state.  Only old
 *   terminal jobs are evicted, so active work is never discarded by trimming.
 * - Task failures are converted into a `failed` job state; they never escape
 *   from the background drain loop as unhandled promise rejections.
 */

/** @typedef {'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'} JobState */

/**
 * A serializable view of an error produced by a queued task.
 * @typedef {{ name: string, message: string, stack?: string }} JobError
 */

/**
 * A public job snapshot. Timestamps use ISO-8601 strings so they can be sent
 * directly over an API or WebSocket.
 *
 * @typedef {Object} JobSnapshot
 * @property {string} id
 * @property {string} resourceKey
 * @property {JobState} state
 * @property {*} metadata
 * @property {string} createdAt
 * @property {string|null} startedAt
 * @property {string|null} finishedAt
 * @property {string|null} cancelledAt
 * @property {*} result
 * @property {JobError|null} error
 */

/**
 * Event sent to the optional `onEvent` callback.
 * @typedef {Object} JobQueueEvent
 * @property {'queued' | 'started' | 'succeeded' | 'failed' | 'cancelled' | 'idle' | 'queue-error'} type
 * @property {string} at
 * @property {JobSnapshot|null} job
 * @property {string} [resourceKey]
 * @property {JobError} [error]
 */

/**
 * The supported lifecycle states. Exported to avoid consumers hard-coding
 * string literals in API validation and UI code.
 */
export const JOB_STATES = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
});

const TERMINAL_STATES = new Set([
  JOB_STATES.SUCCEEDED,
  JOB_STATES.FAILED,
  JOB_STATES.CANCELLED
]);

const scheduleMicrotask = typeof queueMicrotask === 'function'
  ? queueMicrotask
  : (callback) => Promise.resolve().then(callback);

/**
 * Queue asynchronous work while serializing jobs per resource key.
 *
 * A task receives a read-only execution context, but it is intentionally not
 * given a cancellation signal: `cancel()` only cancels jobs that have not yet
 * started, preventing an unsafe half-cancelled device operation.
 */
export class JobQueue {
  /**
   * @param {Object} [options]
   * @param {number} [options.maxHistory=100] Maximum terminal jobs retained.
   * @param {(event: JobQueueEvent) => void|Promise<void>} [options.onEvent]
   * Callback invoked after lifecycle changes. Callback errors are ignored.
   * @param {string} [options.idPrefix='job'] Prefix used for generated IDs.
   */
  constructor({ maxHistory = 100, onEvent = null, idPrefix = 'job' } = {}) {
    if (!Number.isInteger(maxHistory) || maxHistory < 0) {
      throw new TypeError('maxHistory must be a non-negative integer');
    }

    if (onEvent !== null && typeof onEvent !== 'function') {
      throw new TypeError('onEvent must be a function or null');
    }

    this.maxHistory = maxHistory;
    this.onEvent = onEvent;
    this.idPrefix = String(idPrefix || 'job');

    /** @type {Map<string, Array<InternalJob>>} */
    this._pendingByResource = new Map();
    /** @type {Map<string, InternalJob>} */
    this._jobs = new Map();
    /** @type {Set<string>} */
    this._runningResources = new Set();
    /** @type {Set<string>} */
    this._scheduledResources = new Set();
    /** @type {string[]} Terminal job IDs in the order they finished. */
    this._terminalJobIds = [];
    this._sequence = 0;
  }

  /**
   * Add a task to the FIFO queue for a resource.
   *
   * @param {string} resourceKey Stable device/resource identifier.
   * @param {(context: {id: string, resourceKey: string, metadata: *}) => *|Promise<*>} task
   * Function to execute when it reaches the head of its resource queue.
   * @param {*} [metadata={}] Optional API-safe context associated with the job.
   * @returns {JobSnapshot} The newly queued job, including its generated ID.
   */
  enqueue(resourceKey, task, metadata = {}) {
    const normalizedResourceKey = this._validateResourceKey(resourceKey);
    if (typeof task !== 'function') {
      throw new TypeError('task must be a function');
    }

    const job = {
      id: this._createId(),
      resourceKey: normalizedResourceKey,
      task,
      metadata: cloneValue(metadata),
      state: JOB_STATES.QUEUED,
      createdAt: now(),
      startedAt: null,
      finishedAt: null,
      cancelledAt: null,
      result: undefined,
      error: null
    };

    this._jobs.set(job.id, job);
    const pending = this._pendingByResource.get(normalizedResourceKey) || [];
    pending.push(job);
    this._pendingByResource.set(normalizedResourceKey, pending);

    this._emit('queued', job);
    this._scheduleDrain(normalizedResourceKey);
    return this._snapshot(job);
  }

  /**
   * Return a job by ID, or `null` after it has been evicted from history.
   *
   * @param {string} jobId
   * @returns {JobSnapshot|null}
   */
  get(jobId) {
    const job = this._jobs.get(String(jobId));
    return job ? this._snapshot(job) : null;
  }

  /**
   * List known jobs in creation order, optionally filtered by resource/state.
   * Passing a string is shorthand for `{ resourceKey: string }`.
   *
   * @param {string|{resourceKey?: string, states?: JobState|JobState[], limit?: number}} [options]
   * @returns {JobSnapshot[]}
   */
  list(options = {}) {
    const filters = typeof options === 'string' ? { resourceKey: options } : (options || {});
    const stateFilter = filters.states === undefined
      ? null
      : new Set(Array.isArray(filters.states) ? filters.states : [filters.states]);
    const resourceKey = filters.resourceKey === undefined ? null : String(filters.resourceKey);
    const limit = filters.limit === undefined ? Infinity : Number(filters.limit);

    if (limit !== Infinity && (!Number.isInteger(limit) || limit < 0)) {
      throw new TypeError('limit must be a non-negative integer');
    }

    if (limit === 0) return [];

    const jobs = [];
    for (const job of this._jobs.values()) {
      if (resourceKey !== null && job.resourceKey !== resourceKey) continue;
      if (stateFilter && !stateFilter.has(job.state)) continue;
      jobs.push(this._snapshot(job));
      if (jobs.length >= limit) break;
    }
    return jobs;
  }

  /**
   * Cancel a job only while it is still waiting. Running device operations are
   * deliberately left alone because abruptly stopping them can be unsafe.
   *
   * @param {string} jobId
   * @returns {boolean} `true` when a queued job was cancelled.
   */
  cancel(jobId) {
    const job = this._jobs.get(String(jobId));
    if (!job || job.state !== JOB_STATES.QUEUED) return false;

    const pending = this._pendingByResource.get(job.resourceKey);
    if (pending) {
      const index = pending.indexOf(job);
      if (index !== -1) pending.splice(index, 1);
      if (pending.length === 0) this._pendingByResource.delete(job.resourceKey);
    }

    job.state = JOB_STATES.CANCELLED;
    job.cancelledAt = now();
    job.finishedAt = job.cancelledAt;
    this._emit('cancelled', job);
    this._recordTerminal(job);
    this._trimHistory();
    return true;
  }

  /**
   * @param {string} resourceKey
   * @private
   */
  _scheduleDrain(resourceKey) {
    if (this._runningResources.has(resourceKey) || this._scheduledResources.has(resourceKey)) {
      return;
    }

    this._scheduledResources.add(resourceKey);
    scheduleMicrotask(() => {
      this._scheduledResources.delete(resourceKey);
      // The catch is intentional: even an unexpected queue bug must not turn
      // into an unhandled rejection in the host server process.
      this._drain(resourceKey).catch((error) => {
        this._emit('queue-error', null, {
          resourceKey,
          error: serializeError(error)
        });
      });
    });
  }

  /**
   * @param {string} resourceKey
   * @returns {Promise<void>}
   * @private
   */
  async _drain(resourceKey) {
    if (this._runningResources.has(resourceKey)) return;
    this._runningResources.add(resourceKey);

    try {
      const pending = this._pendingByResource.get(resourceKey);
      while (pending && pending.length > 0) {
        const job = pending.shift();
        if (!job || job.state !== JOB_STATES.QUEUED) continue;

        job.state = JOB_STATES.RUNNING;
        job.startedAt = now();
        this._emit('started', job);

        try {
          // Promise.resolve().then() catches synchronous throws as well as
          // rejected async task results in the same lifecycle path.
          job.result = await Promise.resolve().then(() => job.task(Object.freeze({
            id: job.id,
            resourceKey: job.resourceKey,
            metadata: cloneValue(job.metadata)
          })));
          job.state = JOB_STATES.SUCCEEDED;
          job.finishedAt = now();
          this._emit('succeeded', job);
        } catch (error) {
          job.state = JOB_STATES.FAILED;
          job.error = serializeError(error);
          job.finishedAt = now();
          this._emit('failed', job);
        }

        this._recordTerminal(job);
        this._trimHistory();
      }

      // Do not delete a replacement array created while this task was running
      // (for example, after the last queued job was cancelled and new work was
      // added for the same resource).
      if (pending && pending.length === 0 && this._pendingByResource.get(resourceKey) === pending) {
        this._pendingByResource.delete(resourceKey);
      }
    } finally {
      this._runningResources.delete(resourceKey);

      // An event handler may have queued additional work as the last job
      // completed. Schedule again after releasing this resource lock.
      if ((this._pendingByResource.get(resourceKey) || []).length > 0) {
        this._scheduleDrain(resourceKey);
      } else {
        this._emit('idle', null, { resourceKey });
      }
    }
  }

  /** @param {InternalJob} job @returns {JobSnapshot} @private */
  _snapshot(job) {
    return {
      id: job.id,
      resourceKey: job.resourceKey,
      state: job.state,
      metadata: cloneValue(job.metadata),
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      cancelledAt: job.cancelledAt,
      result: cloneValue(job.result),
      error: job.error ? { ...job.error } : null
    };
  }

  /** @param {string} type @param {InternalJob|null} job @param {Object} [extra] @private */
  _emit(type, job, extra = {}) {
    if (!this.onEvent) return;

    try {
      const event = Object.freeze({
        type,
        at: now(),
        job: job ? this._snapshot(job) : null,
        ...extra
      });
      const callbackResult = this.onEvent(event);
      // An async observer must not create an unhandled rejection either.
      if (callbackResult && typeof callbackResult.catch === 'function') {
        callbackResult.catch(() => {});
      }
    } catch {
      // Observers are telemetry only; they must not break command execution.
    }
  }

  /** @private */
  _trimHistory() {
    while (this._terminalJobIds.length > this.maxHistory) {
      const oldestJobId = this._terminalJobIds.shift();
      const oldestJob = this._jobs.get(oldestJobId);
      if (oldestJob && TERMINAL_STATES.has(oldestJob.state)) {
        this._jobs.delete(oldestJobId);
      }
    }
  }

  /** @param {InternalJob} job @private */
  _recordTerminal(job) {
    this._terminalJobIds.push(job.id);
  }

  /** @param {string} resourceKey @returns {string} @private */
  _validateResourceKey(resourceKey) {
    if (typeof resourceKey !== 'string' || resourceKey.trim().length === 0) {
      throw new TypeError('resourceKey must be a non-empty string');
    }
    return resourceKey.trim();
  }

  /** @returns {string} @private */
  _createId() {
    this._sequence += 1;
    return `${this.idPrefix}_${Date.now().toString(36)}_${this._sequence.toString(36)}`;
  }
}

/**
 * @typedef {Object} InternalJob
 * @property {string} id
 * @property {string} resourceKey
 * @property {Function} task
 * @property {*} metadata
 * @property {JobState} state
 * @property {string} createdAt
 * @property {string|null} startedAt
 * @property {string|null} finishedAt
 * @property {string|null} cancelledAt
 * @property {*} result
 * @property {JobError|null} error
 */

/** @returns {string} */
function now() {
  return new Date().toISOString();
}

/**
 * Convert unknown thrown values to an API-safe error object.
 * @param {*} error
 * @returns {JobError}
 */
function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name || 'Error',
      message: error.message || 'Task failed',
      ...(error.stack ? { stack: error.stack } : {})
    };
  }
  return {
    name: 'Error',
    message: typeof error === 'string' ? error : safeString(error)
  };
}

/**
 * Make returned jobs and task contexts independent from mutable caller input.
 * Values that cannot be cloned (for example functions) are preserved by
 * reference rather than making a harmless status lookup fail.
 *
 * @param {*} value
 * @returns {*}
 */
function cloneValue(value) {
  if (value === undefined || value === null || typeof value !== 'object') return value;

  try {
    if (typeof structuredClone === 'function') return structuredClone(value);
  } catch {
    // Fall through to a conservative recursive clone.
  }

  if (Array.isArray(value)) return value.map(cloneValue);
  if (value instanceof Date) return new Date(value.getTime());

  const copy = {};
  for (const [key, entry] of Object.entries(value)) copy[key] = cloneValue(entry);
  return copy;
}

/** @param {*} value @returns {string} */
function safeString(value) {
  try {
    return JSON.stringify(value) || String(value);
  } catch {
    return String(value);
  }
}
