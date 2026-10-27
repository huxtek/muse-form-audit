import { describe, expect, it, vi } from 'vitest';

import {
  AI_ACCESSIBILITY_FLAGS,
  ANALYSIS_SOURCES,
  CATEGORY_KEYS,
  CATEGORY_MAX_SCORES,
  normalizeFormAnalysis,
  parseModelAnalysis
} from '../../server/lib/analysis/formAnalysisSchema.js';
import {
  analyzeFormWithModel,
  buildAnalysisContent,
  buildAnalysisPrompt,
  MAX_IMAGE_BYTES
} from '../../server/lib/analysis/modelFormAnalyzer.js';

/**
 * The model now produces the scores, so its output is untrusted input that the
 * UI, the PDF generator and the scan summary all read. These tests pin the
 * normalisation: out-of-range scores, missing categories, wrong types, prose
 * wrappers, and model failures must all degrade to something coherent rather
 * than render as NaN or abort a scan.
 */

describe('category weights', () => {
  it('sums to 100 so the recomputed percentage is meaningful', () => {
    const total = Object.values(CATEGORY_MAX_SCORES).reduce((a, b) => a + b, 0);

    expect(total).toBe(100);
    expect(CATEGORY_KEYS).toHaveLength(8);
  });
});

describe('normalizeFormAnalysis', () => {
  it('clamps a score above the category maximum', () => {
    const result = normalizeFormAnalysis({
      categories: { structural: { score: 999 } }
    });

    expect(result.categories.structural.score).toBe(CATEGORY_MAX_SCORES.structural);
  });

  it('clamps a negative score to zero', () => {
    const result = normalizeFormAnalysis({ categories: { labeling: { score: -40 } } });

    expect(result.categories.labeling.score).toBe(0);
  });

  it('recomputes the overall score from categories and ignores the model total', () => {
    const result = normalizeFormAnalysis({
      // A deliberately wrong total: the model is trusted to judge, not to add.
      score: 100,
      categories: {
        structural: { score: 15 },
        identification: { score: 20 },
        labeling: { score: 15 },
        inputHints: { score: 0 },
        dataTypes: { score: 0 },
        validation: { score: 0 },
        submission: { score: 0 },
        accessibility: { score: 0 }
      }
    });

    expect(result.score).toBe(50);
  });

  it('fills in every missing category at zero', () => {
    const result = normalizeFormAnalysis({ categories: { structural: { score: 15 } } });

    for (const key of CATEGORY_KEYS) {
      expect(result.categories[key]).toMatchObject({ maxScore: CATEGORY_MAX_SCORES[key] });
    }
    expect(result.categories.validation.score).toBe(0);
    expect(result.score).toBe(15);
  });

  it('drops categories the model invented', () => {
    const result = normalizeFormAnalysis({
      categories: { structural: { score: 10 }, telepathy: { score: 99 } }
    });

    expect(result.categories).not.toHaveProperty('telepathy');
  });

  it('accepts a bare number for a category', () => {
    const result = normalizeFormAnalysis({ categories: { submission: 8 } });

    expect(result.categories.submission.score).toBe(8);
  });

  it('coerces a non-numeric score to zero rather than NaN', () => {
    const result = normalizeFormAnalysis({ categories: { dataTypes: { score: 'great' } } });

    expect(result.categories.dataTypes.score).toBe(0);
    expect(Number.isNaN(result.score)).toBe(false);
  });

  it('turns object-shaped issues into strings', () => {
    const result = normalizeFormAnalysis({
      issues: [{ issue: 'Missing labels' }, { text: 'No ids' }, 'Plain string']
    });

    expect(result.issues).toEqual(['Missing labels', 'No ids', 'Plain string']);
  });

  it('dedupes and drops empty list entries', () => {
    const result = normalizeFormAnalysis({
      recommendations: ['Add ids', 'Add ids', '', '   ', null, 'Add labels']
    });

    expect(result.recommendations).toEqual(['Add ids', 'Add labels']);
  });

  it('defaults every accessibility flag to false and ignores non-boolean truthiness', () => {
    const result = normalizeFormAnalysis({ aiAccessibility: { hasLabels: 'yes', hasCaptcha: true } });

    expect(result.aiAccessibility.hasLabels).toBe(false);
    expect(result.aiAccessibility.hasCaptcha).toBe(true);
    expect(Object.keys(result.aiAccessibility).sort()).toEqual([...AI_ACCESSIBILITY_FLAGS].sort());
  });

  it('survives null, a string, and an array without throwing', () => {
    for (const input of [null, undefined, 'nope', [1, 2, 3]]) {
      const result = normalizeFormAnalysis(input);
      expect(result.score).toBe(0);
      expect(result.issues).toEqual([]);
    }
  });

  it('records the analysis source', () => {
    expect(normalizeFormAnalysis({}, { source: ANALYSIS_SOURCES.HEURISTIC }).analysisSource).toBe(
      'heuristic'
    );
    expect(normalizeFormAnalysis({}).analysisSource).toBe('model');
  });
});

describe('parseModelAnalysis', () => {
  const body = { categories: { structural: { score: 15 } }, issues: ['x'] };

  it('parses a bare JSON object', () => {
    expect(parseModelAnalysis(JSON.stringify(body)).categories.structural.score).toBe(15);
  });

  it('parses JSON inside a fenced code block', () => {
    const text = '```json\n' + JSON.stringify(body) + '\n```';

    expect(parseModelAnalysis(text).categories.structural.score).toBe(15);
  });

  it('parses JSON embedded in prose', () => {
    const text = `Here is the analysis you asked for:\n${JSON.stringify(body)}\nHope that helps.`;

    expect(parseModelAnalysis(text).categories.structural.score).toBe(15);
  });

  it('throws on empty or unparseable output so the caller can fall back', () => {
    expect(() => parseModelAnalysis('')).toThrow();
    expect(() => parseModelAnalysis('   ')).toThrow();
    expect(() => parseModelAnalysis('no json at all')).toThrow();
    expect(() => parseModelAnalysis(undefined)).toThrow();
  });

  it('throws when the model returns an array rather than an object', () => {
    expect(() => parseModelAnalysis('[1,2,3]')).toThrow();
  });
});

describe('buildAnalysisPrompt', () => {
  it('includes the form id, url and extracted field names', () => {
    const prompt = buildAnalysisPrompt({
      formHtml: '<form><input name="email"></form>',
      formId: 'form-0',
      url: 'https://example.com/contact',
      fields: [{ name: 'email', type: 'email', required: true }]
    });

    expect(prompt).toContain('form-0');
    expect(prompt).toContain('https://example.com/contact');
    expect(prompt).toContain('name=email');
    expect(prompt).toContain('required');
    expect(prompt).toContain('<form><input name="email"></form>');
  });

  it('truncates oversized HTML and says so, so the model does not guess', () => {
    const prompt = buildAnalysisPrompt({
      formHtml: 'x'.repeat(500),
      htmlCharLimit: 100
    });

    expect(prompt).toContain('truncated at 100 characters');
    expect(prompt).not.toContain('x'.repeat(200));
  });
});

describe('analyzeFormWithModel fallback behaviour', () => {
  const heuristicAnalysis = {
    score: 43,
    categories: { structural: { score: 12, maxScore: 15, issues: [] } },
    issues: ['Heuristic issue'],
    recommendations: ['Heuristic rec']
  };
  const silent = { log: () => {}, warn: () => {} };

  it('uses the model result when the call succeeds', async () => {
    const provider = {
      label: 'Muse',
      isConfigured: () => true,
      createCompletion: vi.fn().mockResolvedValue({
        choices: [{ message: { content: JSON.stringify({ categories: { labeling: { score: 15 } } }) } }],
        usage: { total_tokens: 100 }
      })
    };

    const result = await analyzeFormWithModel({
      provider,
      formHtml: '<form></form>',
      heuristicAnalysis,
      logger: silent
    });

    expect(result.analysisSource).toBe('model');
    expect(result.categories.labeling.score).toBe(15);
    expect(provider.createCompletion).toHaveBeenCalledOnce();
    // JSON mode is requested so the response is parseable.
    expect(provider.createCompletion.mock.calls[0][0].responseFormat).toBe('json_object');
  });

  it('falls back to the heuristic when the provider throws', async () => {
    const provider = {
      label: 'Muse',
      isConfigured: () => true,
      createCompletion: vi.fn().mockRejectedValue(new Error('429 rate limited'))
    };

    const result = await analyzeFormWithModel({
      provider,
      formHtml: '<form></form>',
      heuristicAnalysis,
      logger: silent
    });

    // A model outage must never fail the scan.
    expect(result.analysisSource).toBe('heuristic');
    expect(result.score).toBe(43);
    expect(result.issues).toContain('Heuristic issue');
  });

  it('falls back when the model returns unparseable output', async () => {
    const provider = {
      label: 'Muse',
      isConfigured: () => true,
      createCompletion: vi.fn().mockResolvedValue({
        choices: [{ message: { content: 'I am afraid I cannot do that.' } }]
      })
    };

    const result = await analyzeFormWithModel({
      provider,
      formHtml: '<form></form>',
      heuristicAnalysis,
      logger: silent
    });

    expect(result.analysisSource).toBe('heuristic');
    expect(result.score).toBe(43);
  });

  it('falls back without calling the provider when it is unconfigured', async () => {
    const provider = {
      label: 'OpenAI',
      isConfigured: () => false,
      createCompletion: vi.fn()
    };

    const result = await analyzeFormWithModel({
      provider,
      formHtml: '<form></form>',
      heuristicAnalysis,
      logger: silent
    });

    expect(provider.createCompletion).not.toHaveBeenCalled();
    expect(result.analysisSource).toBe('heuristic');
  });

  it('falls back without calling the provider when there is no form HTML', async () => {
    const provider = {
      label: 'Muse',
      isConfigured: () => true,
      createCompletion: vi.fn()
    };

    const result = await analyzeFormWithModel({
      provider,
      formHtml: '   ',
      heuristicAnalysis,
      logger: silent
    });

    expect(provider.createCompletion).not.toHaveBeenCalled();
    expect(result.analysisSource).toBe('heuristic');
  });
});

describe('heuristic provider selection', () => {
  const heuristicAnalysis = {
    score: 43,
    categories: { structural: { score: 12, maxScore: 15, issues: [] } },
    issues: ['Heuristic issue'],
    recommendations: ['Heuristic rec']
  };
  const silent = { log: () => {}, warn: () => {} };

  it('returns the deterministic result without any network call', async () => {
    // Picking the heuristic analyser is a choice, not a failure: it must not
    // attempt a request even though it reports itself as configured.
    const createCompletion = vi.fn();
    const provider = {
      name: 'heuristic',
      label: 'Heuristic',
      usesModel: false,
      isConfigured: () => true,
      createCompletion
    };

    const result = await analyzeFormWithModel({
      provider,
      formHtml: '<form><input name="email"></form>',
      heuristicAnalysis,
      logger: silent
    });

    expect(createCompletion).not.toHaveBeenCalled();
    expect(result.analysisSource).toBe('heuristic');
    expect(result.score).toBe(43);
    expect(result.issues).toContain('Heuristic issue');
  });
});
describe('formFindings normalisation', () => {
  it('keeps well-formed entries and defaults an unknown severity', () => {
    const result = normalizeFormAnalysis({
      formFindings: [
        { severity: 'high', issue: 'Visual order disagrees with DOM order' },
        { severity: 'catastrophic', issue: 'Fields are grouped only by proximity' }
      ]
    });

    expect(result.formFindings[0]).toEqual({
      severity: 'high',
      issue: 'Visual order disagrees with DOM order'
    });
    expect(result.formFindings[1].severity).toBe('medium');
  });

  it('accepts a bare string, since a model may not wrap it', () => {
    expect(normalizeFormAnalysis({ formFindings: ['Heading does not describe the form'] })).toMatchObject({
      formFindings: [{ severity: 'medium', issue: 'Heading does not describe the form' }]
    });
  });

  it('keeps an entry with no field, unlike fieldIssues', () => {
    // This is the whole point of the separate bucket: a finding that names no
    // control must survive instead of being dropped or attached arbitrarily.
    const raw = { severity: 'low', issue: 'Submit sits above the last input' };

    expect(normalizeFormAnalysis({ formFindings: [raw] }).formFindings).toHaveLength(1);
    expect(normalizeFormAnalysis({ fieldIssues: [raw] }).fieldIssues).toEqual([]);
  });

  it('drops entries with no message', () => {
    const result = normalizeFormAnalysis({
      formFindings: [{ severity: 'high' }, { issue: '   ' }, 'x', null, 42]
    });

    expect(result.formFindings).toEqual([{ severity: 'medium', issue: 'x' }]);
  });

  it('defaults to an empty list when absent or the wrong type', () => {
    expect(normalizeFormAnalysis({}).formFindings).toEqual([]);
    expect(normalizeFormAnalysis({ formFindings: 'nope' }).formFindings).toEqual([]);
  });
});

describe('buildAnalysisContent', () => {
  const imageOf = (content) =>
    content.find((part) => part.type === 'image_url')?.image_url?.url;

  it('returns the bare prompt when there is no screenshot', () => {
    // An HTML-only call must look exactly as it did before vision existed, so
    // no provider has to learn a new shape to keep working.
    expect(buildAnalysisContent({ prompt: 'score this' })).toBe('score this');
    expect(buildAnalysisContent({ prompt: 'score this', screenshot: Buffer.alloc(0) })).toBe(
      'score this'
    );
  });

  it('attaches the screenshot as a data url beside the prompt', () => {
    const content = buildAnalysisContent({
      prompt: 'score this',
      screenshot: Buffer.from('fake-png-bytes')
    });

    expect(content[0]).toEqual({ type: 'text', text: 'score this' });
    expect(imageOf(content)).toBe(
      `data:image/png;base64,${Buffer.from('fake-png-bytes').toString('base64')}`
    );
  });

  it('honours the capture content type', () => {
    const content = buildAnalysisContent({
      prompt: 'p',
      screenshot: Buffer.from('x'),
      contentType: 'image/jpeg'
    });

    expect(imageOf(content)).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('skips an image over the byte cap rather than sending it', () => {
    // A huge capture should cost us the visual judgement, not the whole call.
    const content = buildAnalysisContent({
      prompt: 'score this',
      screenshot: Buffer.alloc(MAX_IMAGE_BYTES + 1)
    });

    expect(content).toBe('score this');
  });
});

describe('vision pass', () => {
  const silent = { log: () => {}, warn: () => {} };
  const heuristicAnalysis = { score: 43, issues: [], recommendations: [] };

  const modelProvider = (completion) => ({
    label: 'Muse',
    isConfigured: () => true,
    createCompletion: vi.fn().mockResolvedValue(completion)
  });

  const okCompletion = {
    choices: [{ message: { content: JSON.stringify({ categories: { labeling: { score: 15 } } }) } }]
  };

  const contentOf = (provider) => provider.createCompletion.mock.calls[0][0].messages[1].content;

  it('sends the screenshot in the same call as the HTML', async () => {
    // One combined call, so the model can cross-reference the picture against
    // the markup instead of judging each in isolation.
    const provider = modelProvider(okCompletion);

    const result = await analyzeFormWithModel({
      provider,
      formHtml: '<form><input name="email"></form>',
      screenshot: Buffer.from('png'),
      vision: true,
      heuristicAnalysis,
      logger: silent
    });

    expect(provider.createCompletion).toHaveBeenCalledOnce();
    expect(contentOf(provider)).toEqual([
      expect.objectContaining({ type: 'text' }),
      expect.objectContaining({ type: 'image_url' })
    ]);
    expect(result.visionUsed).toBe(true);
  });

  it('sends HTML alone when vision is disabled', async () => {
    const provider = modelProvider(okCompletion);

    const result = await analyzeFormWithModel({
      provider,
      formHtml: '<form></form>',
      screenshot: Buffer.from('png'),
      vision: false,
      heuristicAnalysis,
      logger: silent
    });

    expect(typeof contentOf(provider)).toBe('string');
    expect(result.visionUsed).toBe(false);
  });

  it('sends HTML alone when no screenshot was captured', async () => {
    const provider = modelProvider(okCompletion);

    const result = await analyzeFormWithModel({
      provider,
      formHtml: '<form></form>',
      vision: true,
      heuristicAnalysis,
      logger: silent
    });

    expect(typeof contentOf(provider)).toBe('string');
    expect(result.visionUsed).toBe(false);
  });

  it('falls back when the output budget runs out before any JSON', async () => {
    // An image pushes reasoning tokens up, so a budget that was fine for HTML
    // alone can truncate. That must degrade, not surface as empty analysis.
    const provider = modelProvider({ choices: [{ message: { content: null }, finish_reason: 'length' }] });

    const result = await analyzeFormWithModel({
      provider,
      formHtml: '<form></form>',
      screenshot: Buffer.from('png'),
      vision: true,
      heuristicAnalysis,
      logger: silent
    });

    expect(result.analysisSource).toBe('heuristic');
    expect(result.score).toBe(43);
  });
});
