/**
 * Keeps the in-memory job store from growing without bound.
 *
 * Jobs live in a plain Map in process memory and, until this existed, were
 * never removed: only an explicit DELETE /api/job/:jobId dropped one. The
 * screenshot store already caps itself at a byte budget with oldest-first
 * eviction, and its own comment noted that "scan jobs themselves are never
 * evicted today". On a laptop that is harmless. On a public instance it is a
 * slow leak that ends in the process being killed, taking every in-flight
 * scan with it.
 *
 * Two independent limits, because they fail differently:
 *
 * - A TTL, so a quiet instance does not hold yesterday's reports for ever.
 *   It applies only to jobs that have finished, since a full crawl can
 *   legitimately run longer than any TTL worth setting and must not be
 *   deleted from under itself.
 * - A hard count, so a busy instance cannot outrun the TTL. This one can
 *   reach past finished jobs if it has to: at that point an abandoned job is
 *   less valuable than staying alive.
 */

const TERMINAL_STATUSES = new Set(['completed', 'completed_with_errors', 'failed']);

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const getRetentionConfig = () => ({
  /** How long a finished job is kept. */
  ttlMs: toInt(process.env.JOB_TTL_MS, 30 * 60 * 1000),
  /** Hard ceiling on stored jobs, whatever their age. */
  maxJobs: toInt(process.env.MAX_JOBS, 100),
  /** How often the sweep runs. */
  sweepIntervalMs: toInt(process.env.JOB_SWEEP_INTERVAL_MS, 60 * 1000)
});

export const isTerminal = (job) => TERMINAL_STATUSES.has(job?.status);

/**
 * Age in milliseconds, from `finishedAt` when the job recorded one and
 * `createdAt` otherwise. Unparseable or missing timestamps are treated as
 * age zero rather than infinity, so a malformed record is never deleted on
 * the strength of a date nobody can read.
 */
export const jobAge = (job, now) => {
  const stamp = Date.parse(job?.finishedAt ?? job?.createdAt ?? '');

  return Number.isFinite(stamp) ? Math.max(0, now - stamp) : 0;
};

/**
 * Decides which job ids to drop. Pure: takes the store and returns ids, so
 * the policy can be tested without a server, a clock or a timer.
 */
export const selectEvictableJobs = (jobs, options = {}) => {
  const { now = Date.now(), ttlMs, maxJobs } = { ...getRetentionConfig(), ...options };
  const entries = [...jobs.entries()];
  const doomed = new Set();

  for (const [id, job] of entries) {
    if (isTerminal(job) && jobAge(job, now) > ttlMs) {
      doomed.add(id);
    }
  }

  const remaining = entries.filter(([id]) => !doomed.has(id));
  let excess = remaining.length - maxJobs;

  if (excess > 0) {
    // Oldest first, and finished before unfinished: a report someone may
    // still be reading is worth more than one that was abandoned.
    const byPriority = [...remaining].sort(([, a], [, b]) => {
      const terminalDelta = Number(isTerminal(b)) - Number(isTerminal(a));

      return terminalDelta !== 0 ? terminalDelta : jobAge(b, now) - jobAge(a, now);
    });

    for (const [id] of byPriority) {
      if (excess <= 0) {
        break;
      }

      doomed.add(id);
      excess -= 1;
    }
  }

  return [...doomed];
};

/**
 * Applies the policy. `onEvict` is called per id so the caller can release
 * whatever else is keyed by that job -- the screenshot bytes, above all,
 * which are far larger than the job record itself.
 */
export const sweepJobs = (jobs, options = {}) => {
  const { onEvict } = options;
  const evicted = selectEvictableJobs(jobs, options);

  for (const id of evicted) {
    jobs.delete(id);

    if (typeof onEvict === 'function') {
      onEvict(id);
    }
  }

  return evicted;
};
