/**
 * Model-driven form analysis.
 *
 * The model does the actual scoring and recommendations here, rather than
 * writing prose around numbers produced by heuristics. The deterministic
 * analyser is still run first and passed in as a fallback, so a model outage,
 * a rate limit, or an unparseable response degrades to the previous behaviour
 * instead of failing the scan.
 */
import {
  ANALYSIS_SOURCES,
  CATEGORY_MAX_SCORES,
  normalizeFormAnalysis,
  parseModelAnalysis
} from './formAnalysisSchema.js';

/** Form HTML can be enormous; cap what we send per form. */
export const DEFAULT_HTML_CHAR_LIMIT = Number(process.env.MODEL_HTML_CHAR_LIMIT || 24000);

const SYSTEM_PROMPT = `You are an expert at assessing how well autonomous AI agents can understand and complete HTML forms.

You will be given the HTML of a single form. Score it across eight categories and return STRICT JSON only -- no prose, no markdown, no code fence.

Scoring rubric (score each category from 0 to its maximum):
- structural (0-15): is it a real <form> with sane nesting, fieldsets/legends where useful, and a predictable DOM an agent can walk?
- identification (0-20): can every control be targeted unambiguously? name and id attributes present, stable, and unique. Duplicate or missing name attributes are a serious penalty.
- labeling (0-15): does every control have a programmatically associated label (<label for>, aria-label, aria-labelledby)? Placeholder text alone is not a label.
- inputHints (0-10): autocomplete tokens, inputmode, helpful placeholder or describedby text that tells an agent what value is expected.
- dataTypes (0-15): correct input types (email, tel, number, date), required flags, pattern/min/max constraints that let an agent produce valid values.
- validation (0-10): discoverable validation and error messaging an agent can read after a failed submit.
- submission (0-10): a clear, reachable submit control and an unambiguous submission path.
- accessibility (0-5): roles, aria state, and readability that help an agent and a screen reader equally.

Rules:
- Judge ONLY what the HTML shows. Do not assume behaviour you cannot see.
- Be specific and concrete. Quote attribute names and field names from the HTML.
- "issues" are problems that block or mislead an AI agent, worst first.
- "recommendations" are concrete fixes, each naming the field or attribute to change.
- Do not pad the lists. Fewer, sharper items are better than many vague ones.

Return exactly this JSON structure:
{
  "categories": {
    "structural":     { "score": 0, "issues": ["..."] },
    "identification": { "score": 0, "issues": ["..."] },
    "labeling":       { "score": 0, "issues": ["..."] },
    "inputHints":     { "score": 0, "issues": ["..."] },
    "dataTypes":      { "score": 0, "issues": ["..."] },
    "validation":     { "score": 0, "issues": ["..."] },
    "submission":     { "score": 0, "issues": ["..."] },
    "accessibility":  { "score": 0, "issues": ["..."] }
  },
  "issues": ["top-level issues, worst first"],
  "recommendations": ["concrete fixes"],
  "aiAccessibility": {
    "hasLabels": false, "hasAriaLabels": false, "hasNameAttributes": false,
    "hasValidation": false, "hasCaptcha": false, "hasFileUpload": false,
    "hasProperStructure": false, "hasAutocomplete": false, "hasDataTypes": false
  },
  "narrative": "two or three sentences on what an AI agent would struggle with on this form"
}`;

/** Builds the user turn. Exported so the prompt is testable without a call. */
export function buildAnalysisPrompt({ formHtml, formId, url, fields = [], htmlCharLimit = DEFAULT_HTML_CHAR_LIMIT }) {
  const html = String(formHtml ?? '');
  const truncated = html.length > htmlCharLimit;
  const body = truncated ? html.slice(0, htmlCharLimit) : html;

  const fieldSummary = fields
    .slice(0, 60)
    .map((field) => {
      const parts = [
        field.name ? `name=${field.name}` : null,
        field.id ? `id=${field.id}` : null,
        field.type ? `type=${field.type}` : null,
        field.required ? 'required' : null
      ].filter(Boolean);

      return `- ${parts.join(' ') || '(no identifying attributes)'}`;
    })
    .join('\n');

  return [
    `Form id: ${formId || '(none)'}`,
    `Page URL: ${url || '(unknown)'}`,
    fieldSummary ? `\nFields the extractor found:\n${fieldSummary}` : '',
    truncated
      ? `\nNOTE: the HTML below was truncated at ${htmlCharLimit} characters. Score only what you can see.`
      : '',
    `\nForm HTML:\n${body}`
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Asks the model to score one form. Returns a normalised analysis annotated
 * with `analysisSource`, falling back to `heuristicAnalysis` on any failure.
 */
export async function analyzeFormWithModel({
  provider,
  formHtml,
  formId,
  url,
  fields,
  heuristicAnalysis,
  maxTokens = Number(process.env.MODEL_ANALYSIS_MAX_TOKENS || 4000),
  htmlCharLimit = DEFAULT_HTML_CHAR_LIMIT,
  logger = console
}) {
  const fallback = () => {
    const normalized = normalizeFormAnalysis(heuristicAnalysis ?? {}, {
      source: ANALYSIS_SOURCES.HEURISTIC
    });

    // Keep the heuristic's own overall score rather than the recomputed one if
    // it supplied one, so falling back reproduces previous behaviour exactly.
    if (Number.isFinite(Number(heuristicAnalysis?.score))) {
      normalized.score = Math.min(100, Math.max(0, Math.round(Number(heuristicAnalysis.score))));
    }

    return normalized;
  };

  // The heuristic analyser is a deliberate choice, not a failure: return the
  // deterministic result without touching the network.
  if (provider?.usesModel === false) {
    logger.log?.(`   📐 Heuristic analysis (rule-based, no model call)`);

    return fallback();
  }

  if (!provider?.isConfigured?.()) {
    logger.log?.(`   ⚠️  ${provider?.label ?? 'Model'} not configured - using heuristic analysis`);

    return fallback();
  }

  if (!String(formHtml ?? '').trim()) {
    logger.log?.('   ⚠️  No form HTML to analyze - using heuristic analysis');

    return fallback();
  }

  try {
    const completion = await provider.createCompletion({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: buildAnalysisPrompt({ formHtml, formId, url, fields, htmlCharLimit })
        }
      ],
      maxTokens,
      responseFormat: 'json_object'
    });

    const text = completion?.choices?.[0]?.message?.content;
    const analysis = parseModelAnalysis(text);

    const used = completion?.usage?.total_tokens;
    logger.log?.(
      `   🤖 ${provider.label} scored ${formId || 'form'}: ${analysis.score}/100` +
        (used ? ` (${used} tokens)` : '')
    );

    return analysis;
  } catch (error) {
    // A model problem must never fail the scan.
    logger.warn?.(`   ⚠️  Model analysis failed (${error.message}) - using heuristic analysis`);

    return fallback();
  }
}

/** Exposed for prompt/documentation use. */
export { CATEGORY_MAX_SCORES };
