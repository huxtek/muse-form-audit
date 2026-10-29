import { describe, expect, it, vi } from 'vitest';

import { AIAgent } from '../../server/agent.js';

/**
 * What the single-page scan tells the UI about itself: how long it is
 * waiting, and who produced the score.
 *
 * Both have been wrong in ways no unit test caught. The wait on a refused
 * model was silent, so a scan retrying for a minute looked hung -- which
 * during a demo is worse than a weaker report. The attribution was dropped
 * by the mapping in `analyzeIndividualForm`, so the report badge named no
 * model at all on a real scan while every test of the analyser passed.
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

/**
 * `analyzeIndividualForm` rebuilds the accessibility object field by field,
 * so anything the analyser adds has to be listed there or the report never
 * sees it. A real scan of httpbin.org/forms/post came back scored by the
 * model with no model named, because `analysisModel` was missing from that
 * list. These are the fields the report reads.
 */
describe('single-page scan attribution reaches the report', () => {
  const scored = (payload, { model = 'muse-spark-1.3' } = {}) => {
    const instance = agent();

    instance.tools.analyzeFormAccessibility = async () => ({
      score: 40,
      issues: [],
      recommendations: []
    });
    instance.llm = {
      label: 'Muse',
      model: 'muse-wonder-1.0',
      usesModel: true,
      isConfigured: () => true,
      createCompletion: async () => ({
        model,
        choices: [{ message: { content: JSON.stringify(payload) } }],
        usage: { total_tokens: 10 }
      })
    };

    return instance;
  };

  const analysis = {
    score: 70,
    categories: {},
    // `field` names the control. A finding that cannot name one is dropped
    // rather than drawn on an arbitrary box, so this key is load-bearing.
    fieldIssues: [{ field: 'a', severity: 'high', issue: 'no label' }],
    formFindings: [{ severity: 'medium', issue: 'no submit' }]
  };

  const form = {
    formId: 'form-0',
    formHtml: '<form><input name="a"></form>',
    fields: [{ name: 'a' }]
  };

  const quietly = async (run) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      return await run();
    } finally {
      log.mockRestore();
    }
  };

  it('names the model that actually answered, not the one requested', async () => {
    // The provider takes a stand-in when its preferred model refuses. Naming
    // the requested model would credit work it did not do.
    const result = await quietly(() => scored(analysis).analyzeIndividualForm(form));

    expect(result.accessibility.analysisModel).toBe('muse-spark-1.3');
  });

  it('says a model produced the score', async () => {
    const result = await quietly(() => scored(analysis).analyzeIndividualForm(form));

    expect(result.accessibility.analysisSource).toBe('model');
  });

  it('carries the per-control and whole-form findings the report renders', async () => {
    // The report builds its findings list from these two, not from `issues`.
    const result = await quietly(() => scored(analysis).analyzeIndividualForm(form));

    expect(result.accessibility.fieldIssues).toHaveLength(1);
    expect(result.accessibility.formFindings).toHaveLength(1);
  });

  it('omits the model name when the rules produced the score', async () => {
    // A heuristic score has no model behind it, and an empty string in the
    // badge would read as a model whose name failed to load.
    const instance = agent();
    instance.tools.analyzeFormAccessibility = async () => ({ score: 40, issues: [] });
    instance.llm = { usesModel: false, label: 'Heuristic', isConfigured: () => true };

    const result = await quietly(() => instance.analyzeIndividualForm(form));

    expect(result.accessibility.analysisSource).toBe('heuristic');
    expect(result.accessibility).not.toHaveProperty('analysisModel');
  });
});
