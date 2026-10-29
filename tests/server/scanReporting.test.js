import { describe, expect, it, vi } from 'vitest';

import { AIAgent } from '../../server/agent.js';

/**
 * What the single-page scan tells the UI about itself while it is working.
 *
 * The wait on a refused model was silent, so a scan retrying for a minute
 * looked hung -- which during a demo is worse than a weaker report.
 */
const agent = (onUpdate = () => {}) =>
  new AIAgent('job-test', 'https://example.com', false, 'premium', onUpdate);

describe('progress wording while the model is unavailable', () => {
  it('says what is happening and how long it will keep trying', async () => {
    expect(agent().describeModelWait({ elapsedMs: 14_000, budgetMs: 60_000 })).toBe(
      'Model is briefly unavailable - retrying for up to 46s...'
    );
  });

  it('never counts down past zero', async () => {
    // The last attempt can overrun the budget slightly, and a negative
    // number reads as a bug.
    expect(agent().describeModelWait({ elapsedMs: 61_000, budgetMs: 60_000 })).toMatch(/up to 0s/);
  });

  it('does not name an attempt number', async () => {
    // "attempt 14" sounds like something is badly wrong, when fourteen
    // attempts two seconds apart is the normal shape of a patch clearing.
    expect(agent().describeModelWait({ elapsedMs: 28_000, budgetMs: 60_000 })).not.toMatch(
      /attempt/i
    );
  });
});

describe('progress updates that change only the wording', () => {
  it('keeps the percentage out of the update, so the bar does not jump back', async () => {
    // The job store merges updates with Object.assign. An update carrying
    // `progress: 0` would reset the bar; one carrying no progress at all
    // leaves it where the last real step put it.
    const onUpdate = vi.fn();

    agent(onUpdate).updateProgress({ currentStep: 'Model is briefly unavailable' });

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0][0]).not.toHaveProperty('progress');
    expect(onUpdate.mock.calls[0][0].currentStep).toBe('Model is briefly unavailable');
  });

  it('omits the percentage from the log line rather than printing 0%', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      agent().updateProgress({ currentStep: 'Still trying' });

      expect(log.mock.calls.flat().join('\n')).not.toMatch(/0%/);
    } finally {
      log.mockRestore();
    }
  });

  it('still prints the percentage when the update carries one', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      agent().updateProgress({ progress: 50, currentStep: 'Analyzing forms' });

      expect(log.mock.calls.flat().join('\n')).toMatch(/50% - Analyzing forms/);
    } finally {
      log.mockRestore();
    }
  });
});
