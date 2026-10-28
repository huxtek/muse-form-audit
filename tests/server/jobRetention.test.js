import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getRetentionConfig,
  isTerminal,
  jobAge,
  selectEvictableJobs,
  sweepJobs
} from '../../server/lib/jobRetention.js';

/**
 * The job store was a Map nothing ever removed from, which on a public
 * instance is a leak that ends with the process killed and every in-flight
 * scan lost. These pin the policy that replaced that.
 */
const NOW = Date.parse('2026-01-01T12:00:00.000Z');

const minutesAgo = (minutes) => new Date(NOW - minutes * 60_000).toISOString();

const job = (overrides = {}) => ({
  status: 'completed',
  createdAt: minutesAgo(1),
  ...overrides
});

const storeOf = (entries) => new Map(Object.entries(entries));

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('getRetentionConfig', () => {
  it('has defaults that do not need configuring', () => {
    expect(getRetentionConfig()).toEqual({
      ttlMs: 30 * 60 * 1000,
      maxJobs: 100,
      sweepIntervalMs: 60 * 1000
    });
  });

  it('is overridable by environment', () => {
    process.env.JOB_TTL_MS = '5000';
    process.env.MAX_JOBS = '7';

    expect(getRetentionConfig()).toMatchObject({ ttlMs: 5000, maxJobs: 7 });
  });

  it('ignores values that would disable the limit', () => {
    // A zero or a negative here would mean "evict everything immediately" or
    // "keep for ever", both of which are worse than the default.
    process.env.JOB_TTL_MS = '0';
    process.env.MAX_JOBS = '-5';

    expect(getRetentionConfig()).toMatchObject({
      ttlMs: 30 * 60 * 1000,
      maxJobs: 100
    });
  });
});

describe('jobAge', () => {
  it('prefers finishedAt over createdAt', () => {
    expect(
      jobAge({ createdAt: minutesAgo(90), finishedAt: minutesAgo(5) }, NOW)
    ).toBe(5 * 60_000);
  });

  it('treats an unreadable timestamp as brand new rather than ancient', () => {
    // Otherwise a malformed record is deleted on the strength of a date
    // nobody can parse.
    expect(jobAge({ createdAt: 'not-a-date' }, NOW)).toBe(0);
    expect(jobAge({}, NOW)).toBe(0);
  });
});

describe('isTerminal', () => {
  it('recognises every finished state', () => {
    expect(isTerminal({ status: 'completed' })).toBe(true);
    expect(isTerminal({ status: 'completed_with_errors' })).toBe(true);
    expect(isTerminal({ status: 'failed' })).toBe(true);
  });

  it('does not treat work in progress as finished', () => {
    expect(isTerminal({ status: 'running' })).toBe(false);
    expect(isTerminal({ status: 'queued' })).toBe(false);
    expect(isTerminal(undefined)).toBe(false);
  });
});

describe('selectEvictableJobs: TTL', () => {
  it('drops a finished job past its TTL', () => {
    const jobs = storeOf({ old: job({ createdAt: minutesAgo(45) }) });

    expect(selectEvictableJobs(jobs, { now: NOW })).toEqual(['old']);
  });

  it('keeps a finished job inside its TTL', () => {
    const jobs = storeOf({ fresh: job({ createdAt: minutesAgo(5) }) });

    expect(selectEvictableJobs(jobs, { now: NOW })).toEqual([]);
  });

  it('never drops a running scan on age alone', () => {
    // A full crawl can legitimately outlive any TTL worth setting, and
    // deleting it from under itself would strand the client polling for it.
    const jobs = storeOf({
      crawling: job({ status: 'running', createdAt: minutesAgo(240) }),
      queued: job({ status: 'queued', createdAt: minutesAgo(240) })
    });

    expect(selectEvictableJobs(jobs, { now: NOW })).toEqual([]);
  });
});

describe('selectEvictableJobs: hard cap', () => {
  it('trims to the ceiling when the TTL cannot keep up', () => {
    const jobs = storeOf({
      a: job({ createdAt: minutesAgo(4) }),
      b: job({ createdAt: minutesAgo(3) }),
      c: job({ createdAt: minutesAgo(2) }),
      d: job({ createdAt: minutesAgo(1) })
    });

    // Oldest go first.
    expect(selectEvictableJobs(jobs, { now: NOW, maxJobs: 2 }).sort()).toEqual(['a', 'b']);
  });

  it('spends finished jobs before touching one still running', () => {
    const jobs = storeOf({
      done: job({ createdAt: minutesAgo(2) }),
      running: job({ status: 'running', createdAt: minutesAgo(10) })
    });

    // The running one is older, but a report someone may still be reading
    // beats one that was abandoned -- and an in-flight scan beats both.
    expect(selectEvictableJobs(jobs, { now: NOW, maxJobs: 1 })).toEqual(['done']);
  });

  it('will evict a running job rather than exceed the ceiling', () => {
    const jobs = storeOf({
      r1: job({ status: 'running', createdAt: minutesAgo(9) }),
      r2: job({ status: 'running', createdAt: minutesAgo(3) })
    });

    // At the ceiling, staying alive outranks any single scan.
    expect(selectEvictableJobs(jobs, { now: NOW, maxJobs: 1 })).toEqual(['r1']);
  });

  it('counts TTL evictions towards the ceiling before trimming further', () => {
    const jobs = storeOf({
      expired: job({ createdAt: minutesAgo(45) }),
      keep: job({ createdAt: minutesAgo(1) })
    });

    // The expired one already frees the slot, so `keep` survives.
    expect(selectEvictableJobs(jobs, { now: NOW, maxJobs: 1 })).toEqual(['expired']);
  });

  it('leaves a store inside both limits alone', () => {
    const jobs = storeOf({ a: job(), b: job() });

    expect(selectEvictableJobs(jobs, { now: NOW, maxJobs: 10 })).toEqual([]);
  });
});

describe('sweepJobs', () => {
  it('removes the jobs it selected', () => {
    const jobs = storeOf({
      old: job({ createdAt: minutesAgo(45) }),
      fresh: job({ createdAt: minutesAgo(1) })
    });

    sweepJobs(jobs, { now: NOW });

    expect([...jobs.keys()]).toEqual(['fresh']);
  });

  it('reports each eviction so the caller can free what it keyed', () => {
    // The screenshot bytes are far larger than the job record, and live in a
    // separate store keyed by job id. Missing this callback would turn one
    // leak into a smaller, subtler one.
    const onEvict = vi.fn();
    const jobs = storeOf({ old: job({ createdAt: minutesAgo(45) }) });

    sweepJobs(jobs, { now: NOW, onEvict });

    expect(onEvict).toHaveBeenCalledWith('old');
  });

  it('is a no-op on an empty store', () => {
    const jobs = new Map();

    expect(sweepJobs(jobs, { now: NOW })).toEqual([]);
  });

  it('survives a caller that passes no callback', () => {
    const jobs = storeOf({ old: job({ createdAt: minutesAgo(45) }) });

    expect(() => sweepJobs(jobs, { now: NOW })).not.toThrow();
  });
});
