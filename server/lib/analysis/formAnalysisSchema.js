/**
 * Canonical shape of a per-form analysis, plus normalisation of model output
 * into it.
 *
 * The model is asked to score forms directly, so its output is untrusted
 * input: scores can be out of range, categories can be missing or invented,
 * the arithmetic can be wrong, and the whole thing can arrive wrapped in prose
 * or a code fence. Everything here is defensive on purpose -- the UI, the PDF
 * generator and the scan summary all read this shape, so a malformed response
 * must degrade to something coherent rather than render as NaN or crash a scan.
 *
 * The overall score is always RECOMPUTED from the category scores. The model is
 * trusted to judge, not to add up.
 */

/** Category keys and their weights. These sum to 100. */
export const CATEGORY_MAX_SCORES = {
  structural: 15,
  identification: 20,
  labeling: 15,
  inputHints: 10,
  dataTypes: 15,
  validation: 10,
  submission: 10,
  accessibility: 5
};

export const CATEGORY_KEYS = Object.keys(CATEGORY_MAX_SCORES);

export const AI_ACCESSIBILITY_FLAGS = [
  'hasLabels',
  'hasAriaLabels',
  'hasNameAttributes',
  'hasValidation',
  'hasCaptcha',
  'hasFileUpload',
  'hasProperStructure',
  'hasAutocomplete',
  'hasDataTypes'
];

/** Where an analysis came from, surfaced in the UI and the report. */
export const ANALYSIS_SOURCES = {
  MODEL: 'model',
  HEURISTIC: 'heuristic'
};

/** Severity vocabulary for per-field findings, worst first. */
export const SEVERITIES = ['high', 'medium', 'low'];
const DEFAULT_SEVERITY = 'medium';
const MAX_FIELD_ISSUES = 60;

const MAX_LIST_ITEMS = 25;
const MAX_ITEM_LENGTH = 500;

const clampScore = (value, maxScore) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  return Math.min(maxScore, Math.max(0, Math.round(numeric)));
};

/** Coerces anything into a deduped list of non-empty trimmed strings. */
const toStringList = (value) => {
  const raw = Array.isArray(value) ? value : value == null ? [] : [value];
  const seen = new Set();
  const out = [];

  for (const item of raw) {
    if (item == null) {
      continue;
    }

    // Models sometimes return objects like { issue: "..." } instead of strings.
    const text =
      typeof item === 'string'
        ? item
        : typeof item === 'object'
          ? String(item.text ?? item.issue ?? item.recommendation ?? item.message ?? JSON.stringify(item))
          : String(item);

    const trimmed = text.trim().slice(0, MAX_ITEM_LENGTH);
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }

    if (out.length >= MAX_LIST_ITEMS) {
      break;
    }
  }

  return out;
};

/**
 * Per-field findings, which drive the visual overlay. Each entry must name a
 * control; anything unattributed is dropped, because a highlight with nothing
 * to point at is worse than no highlight.
 */
const toFieldIssues = (value) => {
  const raw = Array.isArray(value) ? value : [];
  const out = [];

  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const field = String(item.field ?? item.name ?? item.id ?? '').trim();
    const message = String(item.issue ?? item.message ?? item.text ?? '').trim();

    if (!field || !message) {
      continue;
    }

    const severityRaw = String(item.severity ?? '').trim().toLowerCase();

    out.push({
      field: field.slice(0, 120),
      severity: SEVERITIES.includes(severityRaw) ? severityRaw : DEFAULT_SEVERITY,
      issue: message.slice(0, MAX_ITEM_LENGTH)
    });

    if (out.length >= MAX_FIELD_ISSUES) {
      break;
    }
  }

  return out;
};

/**
 * Normalises a raw analysis object into the canonical shape. Safe to call on
 * model output, heuristic output, or garbage.
 */
export function normalizeFormAnalysis(raw, { source = ANALYSIS_SOURCES.MODEL } = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const rawCategories =
    input.categories && typeof input.categories === 'object' ? input.categories : {};

  const categories = {};
  let totalScore = 0;
  let totalMaxScore = 0;

  for (const key of CATEGORY_KEYS) {
    const maxScore = CATEGORY_MAX_SCORES[key];
    const entry = rawCategories[key] && typeof rawCategories[key] === 'object' ? rawCategories[key] : {};
    // Accept a bare number too: some responses give `structural: 12`.
    const rawScore = typeof rawCategories[key] === 'number' ? rawCategories[key] : entry.score;
    const score = clampScore(rawScore, maxScore);

    categories[key] = {
      score,
      maxScore,
      issues: toStringList(entry.issues)
    };

    totalScore += score;
    totalMaxScore += maxScore;
  }

  // Recomputed, never taken from the model.
  const score = totalMaxScore > 0 ? Math.round((totalScore / totalMaxScore) * 100) : 0;

  const aiAccessibility = {};
  const rawFlags =
    input.aiAccessibility && typeof input.aiAccessibility === 'object' ? input.aiAccessibility : {};
  for (const flag of AI_ACCESSIBILITY_FLAGS) {
    aiAccessibility[flag] = rawFlags[flag] === true;
  }

  return {
    score,
    maxScore: 100,
    issues: toStringList(input.issues),
    recommendations: toStringList(input.recommendations),
    categories,
    aiAccessibility,
    fieldAnalysis: Array.isArray(input.fieldAnalysis) ? input.fieldAnalysis : [],
    fieldIssues: toFieldIssues(input.fieldIssues),
    analysisSource: source,
    ...(typeof input.narrative === 'string' && input.narrative.trim()
      ? { narrative: input.narrative.trim() }
      : {})
  };
}

/**
 * Pulls a JSON object out of a model response and normalises it.
 *
 * Tolerates a bare object, a ```json fence, and prose with an object embedded,
 * because JSON mode is requested but not guaranteed across providers. Throws if
 * no object can be recovered, so the caller can fall back to the heuristic.
 */
export function parseModelAnalysis(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Model returned an empty analysis');
  }

  const candidates = [];
  const trimmed = text.trim();
  candidates.push(trimmed);

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    candidates.push(fenced[1].trim());
  }

  // Widest balanced-looking span, for prose with an object buried in it.
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) {
    candidates.push(trimmed.slice(first, last + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return normalizeFormAnalysis(parsed, { source: ANALYSIS_SOURCES.MODEL });
      }
    } catch {
      /* try the next candidate */
    }
  }

  throw new Error('Model analysis was not parseable JSON');
}
