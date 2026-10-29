import { SEVERITY_ORDER } from '@/defines/severities';
import type { AnalyzedForm, IssueSeverity } from '@/lib/scan-types';

/**
 * Turns a scan's forms into the two things the report is actually about:
 * where the score came from, and what to fix.
 *
 * Pure on purpose. The report previously derived its headline metrics inside
 * a 400-line component, which is how four of them ended up fabricated --
 * `avgDiscoveryRate: score - 10` and friends, presented as measured success
 * rates for things nothing measured. Arithmetic that decides what a number
 * means belongs somewhere it can be read and tested on its own.
 */

/** Display names for the eight scored categories. */
const CATEGORY_LABELS: Record<string, string> = {
  accessibility: 'Accessibility',
  dataTypes: 'Data types',
  identification: 'Identification',
  inputHints: 'Input hints',
  labeling: 'Labeling',
  structural: 'Structural',
  submission: 'Submission',
  validation: 'Validation'
};

/** One scored category, totalled across every form in the scan. */
export interface CategoryTotal {
  key: string;
  label: string;
  score: number;
  maxScore: number;
  /** Points available but not earned. What the sort is on. */
  lost: number;
  /** Specific complaints the scorer attached to this category. */
  issues: string[];
}

/** A single thing to fix, with enough context to find it. */
export interface Finding {
  severity: IssueSeverity;
  issue: string;
  /** The control it concerns, absent for findings about the whole form. */
  field?: string;
  formIndex: number;
  formLabel: string;
}

export interface SeverityCounts {
  high: number;
  medium: number;
  low: number;
  total: number;
}

const humanize = (key: string): string =>
  CATEGORY_LABELS[key] ??
  key.replace(/([A-Z])/g, ' $1').replace(/^./, (character) => character.toUpperCase());

/**
 * Totals each category across every form, worst gap first.
 *
 * Summing is the right aggregation rather than a convenience: the categories
 * are points out of a fixed 100 per form, so summing scores over summing
 * maxima gives exactly the average of the per-form scores. Three forms at
 * 57, 34 and 78 total 169 of 300, which is the 56 the score strip shows.
 *
 * Sorted by points lost because that answers the only question worth asking
 * of a breakdown: where did the score go.
 */
export const aggregateCategories = (forms: AnalyzedForm[] = []): CategoryTotal[] => {
  const totals = new Map<string, CategoryTotal>();

  for (const form of forms) {
    for (const [key, data] of Object.entries(form.accessibility?.categories ?? {})) {
      const score = data?.score ?? 0;
      const maxScore = data?.maxScore ?? 0;
      const existing = totals.get(key);

      if (existing) {
        existing.score += score;
        existing.maxScore += maxScore;
        existing.lost = existing.maxScore - existing.score;
        existing.issues.push(...(data?.issues ?? []));
      } else {
        totals.set(key, {
          key,
          label: humanize(key),
          score,
          maxScore,
          lost: maxScore - score,
          issues: [...(data?.issues ?? [])]
        });
      }
    }
  }

  return [...totals.values()].sort(
    // Ties broken by name so the order is stable between renders rather than
    // depending on which form happened to be scored first.
    (a, b) => b.lost - a.lost || a.label.localeCompare(b.label)
  );
};

/**
 * Every finding in the scan, flattened across forms, worst first.
 *
 * Built from `fieldIssues` and `formFindings` rather than the `issues` and
 * `recommendations` string arrays. Those two are a parallel, lower-fidelity
 * set: nothing keys an issue to the recommendation that fixes it, and the
 * counts do not even match -- one sample form carries 4 issues against 8
 * recommendations, and some of those pack several problems into one
 * comma-spliced string. Pairing them would mean inventing a correspondence
 * that is not in the data.
 *
 * What is in the data is better anyway. A field issue already names the
 * control, the severity and the remedy in one sentence: "No autocomplete
 * tel, so a browser or agent cannot fill it from a saved profile". The
 * per-category `issues` carry the rest, and they stay attached to the
 * category they cost points in.
 *
 * Flat rather than grouped by form, because one broken form among three
 * healthy ones should be obvious without expanding anything. The form label
 * travels on each row so nothing is lost by flattening.
 */
export const collectFindings = (forms: AnalyzedForm[] = []): Finding[] => {
  const findings: Finding[] = [];

  for (const [formIndex, form] of forms.entries()) {
    const formLabel = `Form ${formIndex + 1}`;

    for (const issue of form.accessibility?.fieldIssues ?? []) {
      findings.push({
        severity: issue.severity,
        issue: issue.issue,
        field: issue.field,
        formIndex,
        formLabel
      });
    }

    for (const finding of form.accessibility?.formFindings ?? []) {
      findings.push({
        severity: finding.severity,
        issue: finding.issue,
        formIndex,
        formLabel
      });
    }
  }

  return findings.sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      a.formIndex - b.formIndex
  );
};

export const countSeverities = (findings: Finding[] = []): SeverityCounts => {
  const counts: SeverityCounts = { high: 0, medium: 0, low: 0, total: findings.length };

  for (const finding of findings) {
    counts[finding.severity] += 1;
  }

  return counts;
};

/**
 * The headline score: the average across forms, which is also the share of
 * category points earned. Null when nothing carried a score, so the caller
 * can leave the figure out rather than print a misleading zero.
 */
export const averageScore = (forms: AnalyzedForm[] = []): number | null => {
  const scores = forms
    .map((form) => form.accessibility?.score)
    .filter((score): score is number => typeof score === 'number');

  return scores.length
    ? Math.round(scores.reduce((total, score) => total + score, 0) / scores.length)
    : null;
};

/** What produced the scores in a report. */
export interface AnalyserSummary {
  /** 'mixed' when some forms were scored by a model and others were not. */
  source: 'model' | 'heuristic' | 'mixed' | 'unknown';
  /** Distinct models that answered, in the order first seen. */
  models: string[];
  /** Short label for a badge: "Muse Wonder", "Rule-based", "Mixed". */
  label: string;
  /** True when any form fell back to rules, which is worth flagging. */
  usedFallback: boolean;
}

/** Turns a model id into something a reader recognises. */
const MODEL_LABELS: Record<string, string> = {
  'muse-wonder-1.0': 'Muse Wonder',
  'muse-spark-1.1': 'Muse Spark 1.1',
  'muse-spark-1.2': 'Muse Spark 1.2',
  'muse-spark-1.3': 'Muse Spark'
};

export const labelModel = (model: string): string => MODEL_LABELS[model] ?? model;

/**
 * Says what scored the report, so a reader never has to guess.
 *
 * This exists because a failed model call produces a report that looks
 * entirely successful: the rule-based fallback returns a plausible score and
 * eight populated categories, and the only tells were indirect -- an
 * annotated screenshot with no boxes, and a findings list reading "Nothing
 * to fix" for a form with real problems. Two people looked at the same live
 * report and disagreed about which analyser had produced it.
 *
 * The model that answered is not always the one that was asked for, either:
 * the server falls back to a stand-in when its preferred model is
 * unavailable, so the report has to name what actually ran.
 */
export const describeAnalyser = (forms: AnalyzedForm[] = []): AnalyserSummary => {
  const sources = forms
    .map((form) => form.accessibility?.analysisSource)
    .filter((source): source is 'model' | 'heuristic' => Boolean(source));

  const models: string[] = [];
  for (const form of forms) {
    const model = form.accessibility?.analysisModel;

    if (model && !models.includes(model)) {
      models.push(model);
    }
  }

  const hasModel = sources.includes('model');
  const hasHeuristic = sources.includes('heuristic');

  let source: AnalyserSummary['source'] = 'unknown';
  if (hasModel && hasHeuristic) {
    source = 'mixed';
  } else if (hasModel) {
    source = 'model';
  } else if (hasHeuristic) {
    source = 'heuristic';
  }

  const label = (() => {
    if (source === 'heuristic') {
      return 'Rule-based';
    }

    if (source === 'mixed') {
      return 'Mixed';
    }

    if (source === 'model') {
      // One model named outright; several summarised, since a badge cannot
      // carry a list.
      return models.length === 1 ? labelModel(models[0]) : 'AI';
    }

    return '';
  })();

  return { source, models, label, usedFallback: hasHeuristic };
};
