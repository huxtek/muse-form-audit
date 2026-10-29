import { describe, expect, it } from 'vitest';

import {
  aggregateCategories,
  averageScore,
  collectFindings,
  countSeverities,
  describeAnalyser
} from '@/lib/report-data';
import type { AnalyzedForm } from '@/lib/scan-types';

/**
 * The arithmetic that decides what the report's numbers mean. It lives apart
 * from the components because the last version of it was buried in a 400-line
 * dashboard, which is how four headline metrics came to be `score - 10`,
 * `score - 5`, `score` and `score - 15`, drawn as measured success rates.
 */
const form = (overrides: Partial<AnalyzedForm> = {}): AnalyzedForm => ({
  formId: 'form-0',
  ...overrides
});

describe('aggregateCategories', () => {
  it('totals a single form and reports what it lost', () => {
    const [worst, ...rest] = aggregateCategories([
      form({
        accessibility: {
          categories: {
            dataTypes: { score: 2, maxScore: 15 },
            identification: { score: 16, maxScore: 20 }
          }
        }
      })
    ]);

    expect(worst).toMatchObject({ key: 'dataTypes', score: 2, maxScore: 15, lost: 13 });
    expect(rest[0]).toMatchObject({ key: 'identification', lost: 4 });
  });

  it('sums the same category across forms', () => {
    const [structural] = aggregateCategories([
      form({ accessibility: { categories: { structural: { score: 9, maxScore: 15 } } } }),
      form({ accessibility: { categories: { structural: { score: 6, maxScore: 15 } } } }),
      form({ accessibility: { categories: { structural: { score: 14, maxScore: 15 } } } })
    ]);

    expect(structural).toMatchObject({ score: 29, maxScore: 45, lost: 16 });
  });

  it('puts the biggest gap first, not the lowest score', () => {
    // 2/15 is a worse score than 10/20, but 10 points lost beats 13... the
    // ordering has to be on points lost, since that is what moves the total.
    const order = aggregateCategories([
      form({
        accessibility: {
          categories: {
            identification: { score: 4, maxScore: 20 },
            labeling: { score: 13, maxScore: 15 }
          }
        }
      })
    ]).map((category) => category.key);

    expect(order).toEqual(['identification', 'labeling']);
  });

  it('breaks ties by name so the order does not wander', () => {
    const order = aggregateCategories([
      form({
        accessibility: {
          categories: {
            validation: { score: 5, maxScore: 10 },
            structural: { score: 10, maxScore: 15 },
            labeling: { score: 10, maxScore: 15 }
          }
        }
      })
    ]).map((category) => category.label);

    // Structural and Labeling both lost 5.
    expect(order).toEqual(['Labeling', 'Structural', 'Validation']);
  });

  it('sums to the average of the per-form scores', () => {
    // The categories are points out of a fixed 100 per form, so this identity
    // is what makes summing an honest aggregation rather than a convenience.
    const forms = [
      form({
        accessibility: {
          score: 57,
          categories: {
            structural: { score: 9, maxScore: 15 },
            identification: { score: 16, maxScore: 20 },
            labeling: { score: 7, maxScore: 15 },
            inputHints: { score: 5, maxScore: 10 },
            dataTypes: { score: 2, maxScore: 15 },
            validation: { score: 7, maxScore: 10 },
            submission: { score: 7, maxScore: 10 },
            accessibility: { score: 4, maxScore: 5 }
          }
        }
      })
    ];

    const totals = aggregateCategories(forms);
    const score = totals.reduce((sum, category) => sum + category.score, 0);
    const max = totals.reduce((sum, category) => sum + category.maxScore, 0);

    expect(score).toBe(57);
    expect(max).toBe(100);
    expect(Math.round((score / max) * 100)).toBe(averageScore(forms));
  });

  it('gathers the complaints attached to each category', () => {
    const [structural] = aggregateCategories([
      form({
        accessibility: {
          categories: {
            structural: { score: 0, maxScore: 15, issues: ['Missing action attribute'] }
          }
        }
      }),
      form({
        accessibility: {
          categories: {
            structural: { score: 0, maxScore: 15, issues: ['Controls are not wrapped in a form'] }
          }
        }
      })
    ]);

    expect(structural.issues).toEqual([
      'Missing action attribute',
      'Controls are not wrapped in a form'
    ]);
  });

  it('copes with forms that carry no categories', () => {
    expect(aggregateCategories([form()])).toEqual([]);
    expect(aggregateCategories()).toEqual([]);
  });

  it('gives a readable label to a category it has no name for', () => {
    // The scorer could add a ninth category before the type catches up, and
    // an unlabelled key should still read as English rather than camelCase.
    const [unknown] = aggregateCategories([
      form({
        accessibility: {
          categories: { someNewThing: { score: 0, maxScore: 5 } }
        } as never
      })
    ]);

    expect(unknown.label).toBe('Some New Thing');
  });
});

describe('collectFindings', () => {
  const scan = [
    form({
      accessibility: {
        fieldIssues: [
          { field: 'phoneNumber', severity: 'low', issue: 'No autocomplete tel' },
          { field: 'fullName', severity: 'high', issue: 'No id and no autocomplete token' }
        ],
        formFindings: [{ severity: 'medium', issue: 'Visual order fights DOM order' }]
      }
    }),
    form({
      formId: 'form-signin',
      accessibility: {
        fieldIssues: [{ field: 'password', severity: 'high', issue: 'No autocomplete token' }]
      }
    })
  ];

  it('flattens every form into one list, worst first', () => {
    const findings = collectFindings(scan);

    expect(findings.map((finding) => finding.severity)).toEqual([
      'high',
      'high',
      'medium',
      'low'
    ]);
  });

  it('keeps the form a finding came from, so flattening loses nothing', () => {
    const findings = collectFindings(scan);

    expect(findings[0]).toMatchObject({ formLabel: 'Form 1', field: 'fullName' });
    expect(findings[1]).toMatchObject({ formLabel: 'Form 2', field: 'password' });
  });

  it('orders equal severities by form so the list does not shuffle', () => {
    const findings = collectFindings(scan).filter((finding) => finding.severity === 'high');

    expect(findings.map((finding) => finding.formIndex)).toEqual([0, 1]);
  });

  it('carries whole-form findings with no field', () => {
    const wholeForm = collectFindings(scan).find((finding) => finding.severity === 'medium');

    expect(wholeForm?.field).toBeUndefined();
    expect(wholeForm?.issue).toBe('Visual order fights DOM order');
  });

  it('ignores the issues and recommendations string arrays', () => {
    // Nothing keys one to the other, the counts do not match, and some
    // recommendations comma-splice several fixes into one string. Pairing
    // them would be inventing a correspondence the data does not have.
    const findings = collectFindings([
      form({
        accessibility: {
          issues: ['Form missing action URL'],
          recommendations: ['STRUCTURAL: Missing action attribute, Missing method attribute']
        }
      })
    ]);

    expect(findings).toEqual([]);
  });

  it('returns nothing for an empty scan', () => {
    expect(collectFindings([])).toEqual([]);
    expect(collectFindings()).toEqual([]);
  });
});

describe('countSeverities', () => {
  it('counts each severity and the total', () => {
    expect(
      countSeverities([
        { severity: 'high', issue: 'a', formIndex: 0, formLabel: 'Form 1' },
        { severity: 'high', issue: 'b', formIndex: 0, formLabel: 'Form 1' },
        { severity: 'low', issue: 'c', formIndex: 0, formLabel: 'Form 1' }
      ])
    ).toEqual({ high: 2, medium: 0, low: 1, total: 3 });
  });

  it('counts an empty list as zero rather than undefined', () => {
    expect(countSeverities([])).toEqual({ high: 0, medium: 0, low: 0, total: 0 });
  });
});

describe('averageScore', () => {
  it('rounds the mean across forms', () => {
    expect(
      averageScore([
        form({ accessibility: { score: 57 } }),
        form({ accessibility: { score: 34 } }),
        form({ accessibility: { score: 78 } })
      ])
    ).toBe(56);
  });

  it('ignores forms with no score rather than counting them as zero', () => {
    expect(
      averageScore([form({ accessibility: { score: 80 } }), form({ accessibility: {} })])
    ).toBe(80);
  });

  it('is null when nothing was scored, so no figure is printed', () => {
    expect(averageScore([form()])).toBeNull();
    expect(averageScore([])).toBeNull();
  });
});

/**
 * A failed model call produces a report that looks entirely successful: the
 * rule-based fallback returns a plausible score and eight populated
 * categories. The only tells were indirect, and two people looked at the
 * same live report and disagreed about which analyser had produced it. This
 * is what makes it legible.
 */
describe('describeAnalyser', () => {
  const scored = (source?: string, model?: string): AnalyzedForm =>
    form({
      accessibility: {
        score: 70,
        ...(source ? { analysisSource: source as 'model' | 'heuristic' } : {}),
        ...(model ? { analysisModel: model } : {})
      }
    });

  it('names the model that answered', () => {
    expect(describeAnalyser([scored('model', 'muse-wonder-1.0')])).toMatchObject({
      source: 'model',
      label: 'Muse Wonder',
      usedFallback: false
    });
  });

  it('names the stand-in when one answered, not the model that was asked for', () => {
    expect(describeAnalyser([scored('model', 'muse-spark-1.3')])).toMatchObject({
      source: 'model',
      label: 'Muse Spark'
    });
  });

  it('says rule-based when no model scored it', () => {
    // The case that mattered: this used to be indistinguishable on screen
    // from a real AI audit.
    expect(describeAnalyser([scored('heuristic')])).toMatchObject({
      source: 'heuristic',
      label: 'Rule-based',
      usedFallback: true
    });
  });

  it('reports a split scan as mixed, and flags the fallback', () => {
    const summary = describeAnalyser([
      scored('model', 'muse-wonder-1.0'),
      scored('heuristic')
    ]);

    expect(summary.source).toBe('mixed');
    expect(summary.label).toBe('Mixed');
    expect(summary.usedFallback).toBe(true);
  });

  it('collapses several models rather than listing them in a badge', () => {
    const summary = describeAnalyser([
      scored('model', 'muse-wonder-1.0'),
      scored('model', 'muse-spark-1.3')
    ]);

    expect(summary.label).toBe('AI');
    expect(summary.models).toEqual(['muse-wonder-1.0', 'muse-spark-1.3']);
  });

  it('does not invent a label when nothing said what scored it', () => {
    expect(describeAnalyser([form()])).toMatchObject({
      source: 'unknown',
      label: '',
      usedFallback: false
    });
    expect(describeAnalyser([])).toMatchObject({ source: 'unknown', label: '' });
  });

  it('passes through a model id it has no friendly name for', () => {
    expect(describeAnalyser([scored('model', 'muse-future-2.0')]).label).toBe('muse-future-2.0');
  });
});
