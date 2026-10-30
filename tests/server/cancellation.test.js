import { describe, expect, it, vi } from 'vitest';

import { AIAgent } from '../../server/agent.js';
import {
  ScanCancelledError,
  cancellableDelay,
  isCancellation,
  throwIfCancelled
} from '../../server/lib/cancellation.js';
import { analyzeFormWithModel } from '../../server/lib/analysis/modelFormAnalyzer.js';
import { createMuseProvider } from '../../server/lib/llm/muse.js';
import { isTerminal } from '../../server/lib/jobRetention.js';

const silent = { warn: () => {}, log: () => {} };

describe('recognising a cancellation', () => {
  it('tells a cancellation apart from any other error', async () => {
    expect(isCancellation(new ScanCancelledError())).toBe(true);
    expect(isCancellation(new Error('Muse API error 404'))).toBe(false);
    expect(isCancellation(undefined)).toBe(false);
  });

  it('survives being rethrown, which is how it travels', async () => {
    // It passes through four catch blocks between the model call and the
    // scan loop, and a check on `message` or `name` would not survive the
    // provider rewriting messages to redact the API key.
    const original = new ScanCancelledError();
    let caught;

    try {
      try {
        throw original;
      } catch (error) {
        throw error;
      }
    } catch (error) {
      caught = error;
    }

    expect(isCancellation(caught)).toBe(true);
  });

  it('throws only once the signal is aborted', async () => {
    const controller = new AbortController();

    expect(() => throwIfCancelled(controller.signal)).not.toThrow();

    controller.abort();

    expect(() => throwIfCancelled(controller.signal)).toThrow(ScanCancelledError);
  });
});

describe('waiting between retries', () => {
  it('ends early when the scan is cancelled', async () => {
    // Retries are two seconds apart. A cancel pressed during the gap must
    // take effect now, not when the gap happens to end.
    const controller = new AbortController();
    const startedAt = Date.now();
    const waiting = cancellableDelay(5_000, controller.signal);

    controller.abort();

    await expect(waiting).rejects.toThrow(ScanCancelledError);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('rejects immediately when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(cancellableDelay(5_000, controller.signal)).rejects.toThrow(ScanCancelledError);
  });

  it('resolves normally when nothing cancels it', async () => {
    await expect(cancellableDelay(1, new AbortController().signal)).resolves.toBeUndefined();
  });
});

describe('the model provider honours a cancel', () => {
  const provider = (overrides = {}) =>
    createMuseProvider({
      apiKey: 'test-key',
      model: 'muse-wonder-1.0',
      retryDelayMs: 0,
      retryBudgetMs: 10 ** 9,
      maxAttempts: 20,
      fallbackModels: [],
      logger: silent,
      ...overrides
    });

  it('does not spend the retry budget on a cancelled scan', async () => {
    // Before this, a cancelled request looked exactly like a timed-out one
    // and was retried as a transport blip for the rest of the minute.
    const controller = new AbortController();

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        controller.abort();

        return Promise.reject(new Error('The operation was aborted'));
      })
    );

    try {
      await expect(
        provider().createCompletion({
          messages: [{ role: 'user', content: 'hi' }],
          signal: controller.signal
        })
      ).rejects.toThrow(ScanCancelledError);

      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses to start when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    try {
      await expect(
        provider().createCompletion({
          messages: [{ role: 'user', content: 'hi' }],
          signal: controller.signal
        })
      ).rejects.toThrow(ScanCancelledError);

      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('the analyser does not degrade a cancelled scan', () => {
  it('rethrows instead of falling back to rules', async () => {
    // Falling back here would hand back a rule-based report for a scan the
    // user stopped, and the agent would carry on to the next form.
    const provider = {
      label: 'Muse',
      model: 'muse-wonder-1.0',
      usesModel: true,
      isConfigured: () => true,
      createCompletion: async () => {
        throw new ScanCancelledError();
      }
    };

    await expect(
      analyzeFormWithModel({
        provider,
        formHtml: '<form><input name="a"></form>',
        formId: 'form-0',
        url: 'https://example.com',
        fields: [{ name: 'a' }],
        heuristicAnalysis: { score: 40 },
        logger: silent
      })
    ).rejects.toThrow(ScanCancelledError);
  });

  it('still falls back for an ordinary model failure', async () => {
    const provider = {
      label: 'Muse',
      model: 'muse-wonder-1.0',
      usesModel: true,
      isConfigured: () => true,
      createCompletion: async () => {
        throw new Error('Muse API error 404: The requested model was not found.');
      }
    };

    const analysis = await analyzeFormWithModel({
      provider,
      formHtml: '<form><input name="a"></form>',
      formId: 'form-0',
      url: 'https://example.com',
      fields: [{ name: 'a' }],
      heuristicAnalysis: { score: 40 },
      logger: silent
    });

    expect(analysis.analysisSource).toBe('heuristic');
  });
});

/**
 * The guard that matters most, because the first working version of cancel
 * still published a finished report with a score.
 *
 * The cancellation was thrown correctly by the provider and then swallowed by
 * a catch block inside `analyzeIndividualForm` that nobody had accounted for.
 * The scan carried on, scored the form and reported `completed`. Rather than
 * trusting that the list of catch blocks stays complete, the one path every
 * result travels through refuses to carry anything but the cancellation.
 */
describe('a cancelled scan cannot report anything else', () => {
  const agent = (onUpdate) =>
    new AIAgent('job-test', 'https://example.com', false, 'premium', onUpdate);

  it('drops a completion that arrives after the cancel', async () => {
    const onUpdate = vi.fn();
    const instance = agent(onUpdate);

    instance.cancel();
    instance.updateProgress({
      status: 'completed',
      progress: 100,
      currentStep: 'Per-form analysis completed',
      results: { forms: [{ formId: 'form-0' }] }
    });

    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('drops a progress update that arrives after the cancel', async () => {
    const onUpdate = vi.fn();
    const instance = agent(onUpdate);

    instance.cancel();
    instance.updateProgress({ status: 'running', progress: 90, currentStep: 'Analyzing...' });

    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('lets the cancellation itself through', async () => {
    const onUpdate = vi.fn();
    const instance = agent(onUpdate);

    instance.cancel();
    instance.updateProgress({ status: 'cancelled', currentStep: 'Scan cancelled' });

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0][0].status).toBe('cancelled');
  });

  it('reports normally until it is cancelled', async () => {
    const onUpdate = vi.fn();
    const instance = agent(onUpdate);

    instance.updateProgress({ status: 'running', progress: 30, currentStep: 'Working' });

    expect(onUpdate).toHaveBeenCalledTimes(1);
  });
});

/**
 * The retry configuration has to be internally consistent or one of its
 * settings is dead.
 *
 * With a per-attempt deadline at or above the whole budget, a call that
 * times out can never be retried: the first attempt overruns the budget
 * before a second can start. That shipped, and cost a real scan its
 * model-written report after a single 120s attempt against a 60s budget.
 */
describe('the retry budget leaves room for a retry', () => {
  it('fits at least two full-length attempts', async () => {
    const timeout = Number(process.env.MODEL_TIMEOUT_MS ?? 75_000);
    const budget = Number(process.env.MUSE_RETRY_BUDGET_MS ?? 180_000);
    const gap = Number(process.env.MUSE_RETRY_DELAY_MS ?? 2_000);

    expect(timeout + gap + timeout).toBeLessThanOrEqual(budget);
  });

  it('bounds the requests a refusal burst can make', async () => {
    // Refusals return in a few hundred milliseconds, so the time budget
    // barely constrains them and the attempt ceiling is what does.
    const maxAttempts = Number(process.env.MUSE_MAX_ATTEMPTS ?? 30);

    expect(maxAttempts).toBeGreaterThan(1);
    expect(maxAttempts).toBeLessThanOrEqual(40);
  });
});

describe('a cancelled job is housekept like any other finished one', () => {
  it('counts as terminal, so the sweep can release it', async () => {
    // Left out of the terminal set, every cancelled job and its screenshot
    // bytes would be kept until the process died.
    expect(isTerminal({ status: 'cancelled' })).toBe(true);
    expect(isTerminal({ status: 'running' })).toBe(false);
  });
});
