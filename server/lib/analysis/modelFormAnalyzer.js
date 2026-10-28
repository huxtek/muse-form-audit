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
import { summariseBehaviour } from './probeFormBehaviour.js';

/** Form HTML can be enormous; cap what we send per form. */
export const DEFAULT_HTML_CHAR_LIMIT = Number(process.env.MODEL_HTML_CHAR_LIMIT || 24000);

/**
 * Send the form's screenshot alongside its HTML. Adds roughly 250 prompt
 * tokens per form and lets the model judge what markup cannot show. Set
 * MODEL_VISION=false to analyse from HTML alone.
 */
export const VISION_ENABLED = process.env.MODEL_VISION !== 'false';

/** Skip absurdly large images rather than blowing the request up. */
export const MAX_IMAGE_BYTES = Number(process.env.MODEL_MAX_IMAGE_BYTES || 4 * 1024 * 1024);

const SYSTEM_PROMPT = `You are an expert at assessing how well autonomous AI agents can understand and complete HTML forms.

You will be given the HTML of a single form, and usually a SCREENSHOT of that same form as rendered in a browser. Use both. Score it across eight categories and return STRICT JSON only -- no prose, no markdown, no code fence.

When a screenshot is provided, also judge what only a picture can show: whether a label actually sits next to the control it describes, whether related controls are grouped visibly, whether anything is too small or too low-contrast to identify, and whether the visual order matches the DOM order. Where the picture and the markup disagree, say so -- a label that looks attached but is not associated in the markup is exactly the trap that defeats an agent.

Scoring rubric (score each category from 0 to its maximum):
- structural (0-15): is it a real <form> with sane nesting, fieldsets/legends where useful, and a predictable DOM an agent can walk?
- identification (0-20): can every control be targeted unambiguously? name and id attributes present, stable, and unique. Duplicate or missing name attributes are a serious penalty.
- labeling (0-15): does every control have a programmatically associated label (<label for>, aria-label, aria-labelledby)? Placeholder text alone is not a label.
- inputHints (0-10): autocomplete tokens, inputmode, helpful placeholder or describedby text that tells an agent what value is expected.
- dataTypes (0-15): correct input types (email, tel, number, date), required flags, pattern/min/max constraints that let an agent produce valid values.
- validation (0-10): discoverable validation and error messaging an agent can read after a failed submit. Score this from the observed-behaviour section where one is given: declared constraints, what the browser reports when they are checked, and whether a region exists to announce a failure. Do not score it down merely because no error text is visible on an untouched form.
- submission (0-10): a clear, reachable submit control and an unambiguous submission path.
- accessibility (0-5): roles, aria state, and readability that help an agent and a screen reader equally.

What you are looking at:
- The HTML and the screenshot show the form AT REST: untouched, with nothing filled in and nothing submitted. Validation and error messaging, by definition, mostly exist after interaction, so they are largely NOT in front of you.
- When an "OBSERVED ON THE LIVE PAGE" section is present, judge validation and error handling from THAT, not from the absence of visible error text in the markup.
- An empty alert container or live region is evidence that error handling EXISTS and is waiting for something to announce. Never report an empty one as missing or as a defect in itself.
- The same goes for describing text that is empty until needed: wiring that is present but unused is wiring that is present.
- If you cannot tell from what you were given whether something works, say so instead of asserting it is absent. Begin such an item with "unverified: " and do not let it drive the score down as if it were a confirmed fault. A form that was never submitted cannot be shown to lack submit-time validation.

Rules:
- Judge ONLY what the HTML, the screenshot and the observed-behaviour section show. Do not assume behaviour you cannot see.
- Be specific and concrete. Quote attribute names and field names from the HTML.
- "issues" are problems that block or mislead an AI agent, worst first.
- "recommendations" are concrete fixes, each naming the field or attribute to change.
- Do not pad the lists. Fewer, sharper items are better than many vague ones.
- "formFindings" is for problems that belong to the form as a whole and name no single control -- grouping, visual versus DOM order, an unclear heading. Do not put a control-specific problem here; it belongs in fieldIssues. Leave the array empty if there is nothing to say.
- "fieldIssues" attributes problems to individual controls so they can be highlighted on a screenshot of the form. This is important: for every control with a problem, add an entry whose "field" is EXACTLY the control's name attribute, or its id if it has no name. Copy the value character for character from the HTML -- do not paraphrase, pluralise, or describe it. If several controls share a name (radio or checkbox groups), one entry for that name is enough. Omit controls that have no problem. Severity must be "high", "medium" or "low".
- ONE PROBLEM PER ENTRY. If a control has three problems, write three separate entries for it, each with its own severity. Do NOT chain several problems into one string with commas or semicolons: "no name, no id, and no label; an agent cannot target it" is three findings crammed into one and must be split. Each entry is shown as its own bullet, so one entry holding three problems renders as a paragraph and cannot be given a severity that fits all of it.
- Keep each entry to ONE SENTENCE: the problem and what it costs an agent. The problem alone ("no name attribute") leaves the reader to infer why it matters; three problems together cannot be read at a glance.

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
  "fieldIssues": [
    { "field": "exact-name-or-id", "severity": "high", "issue": "one problem with this control, and what it costs an agent" },
    { "field": "exact-name-or-id", "severity": "low", "issue": "a SECOND, separate problem with the SAME control goes in its own entry like this" }
  ],
  "formFindings": [
    { "severity": "medium", "issue": "a problem with the form as a whole that belongs to no single control, e.g. visual order disagreeing with DOM order" }
  ],
  "aiAccessibility": {
    "hasLabels": false, "hasAriaLabels": false, "hasNameAttributes": false,
    "hasValidation": false, "hasCaptcha": false, "hasFileUpload": false,
    "hasProperStructure": false, "hasAutocomplete": false, "hasDataTypes": false
  },
  "narrative": "two or three sentences on what an AI agent would struggle with on this form"
}`;

/** Builds the user turn. Exported so the prompt is testable without a call. */
export function buildAnalysisPrompt({
  formHtml,
  formId,
  url,
  fields = [],
  behaviour = null,
  htmlCharLimit = DEFAULT_HTML_CHAR_LIMIT
}) {
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

  const observed = summariseBehaviour(behaviour);

  return [
    `Form id: ${formId || '(none)'}`,
    `Page URL: ${url || '(unknown)'}`,
    fieldSummary ? `\nFields the extractor found:\n${fieldSummary}` : '',
    observed ? `\n${observed}` : '',
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
/**
 * Builds the user turn, attaching the screenshot when one is available.
 *
 * Returns a Chat Completions content array when there is an image, or a plain
 * string when there is not, so an HTML-only call looks exactly as it did
 * before vision existed.
 */
export function buildAnalysisContent({ prompt, screenshot, contentType = 'image/png' }) {
  if (!screenshot?.length || screenshot.length > MAX_IMAGE_BYTES) {
    return prompt;
  }

  return [
    { type: 'text', text: prompt },
    {
      type: 'image_url',
      image_url: { url: `data:${contentType};base64,${screenshot.toString('base64')}` }
    }
  ];
}

export async function analyzeFormWithModel({
  provider,
  formHtml,
  formId,
  url,
  fields,
  heuristicAnalysis,
  /** Live-page observations, so validation is judged on evidence. */
  behaviour = null,
  /** PNG bytes of the form crop, when one was captured. */
  screenshot = null,
  screenshotContentType = 'image/png',
  vision = VISION_ENABLED,
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
    const prompt = buildAnalysisPrompt({ formHtml, formId, url, fields, behaviour, htmlCharLimit });
    const useImage = vision && Boolean(screenshot?.length);
    const content = useImage
      ? buildAnalysisContent({ prompt, screenshot, contentType: screenshotContentType })
      : prompt;

    const completion = await provider.createCompletion({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content }
      ],
      maxTokens,
      responseFormat: 'json_object'
    });

    const text = completion?.choices?.[0]?.message?.content;

    // An image pushes reasoning tokens up, so a budget that was fine for
    // HTML alone can truncate before any JSON is written.
    if (!text && completion?.choices?.[0]?.finish_reason === 'length') {
      throw new Error('model ran out of output tokens before returning an analysis');
    }

    const analysis = parseModelAnalysis(text);
    analysis.visionUsed = useImage;

    const used = completion?.usage?.total_tokens;
    logger.log?.(
      `   🤖 ${provider.label} scored ${formId || 'form'}: ${analysis.score}/100` +
        (useImage ? ' [with screenshot]' : '') +
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
