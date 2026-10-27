/**
 * The analysis agent can run against either provider so a demo can compare
 * the original OpenAI path with Muse. Muse is the default and permanent
 * provider; OpenAI is retained for the comparison.
 *
 * These ids must match the provider names registered in
 * `server/lib/llm/index.js`.
 */
export const MODEL_PROVIDERS = {
  HEURISTIC: 'heuristic',
  MUSE: 'muse'
} as const;

export type ModelProvider = (typeof MODEL_PROVIDERS)[keyof typeof MODEL_PROVIDERS];

export const DEFAULT_MODEL_PROVIDER: ModelProvider = MODEL_PROVIDERS.MUSE;

/** Display metadata for the model switch. */
export const MODEL_PROVIDER_DETAILS: Record<
  ModelProvider,
  { label: string; blurb: string }
> = {
  [MODEL_PROVIDERS.HEURISTIC]: {
    label: 'Heuristic',
    blurb: 'Rule-based audit: deterministic checks, no AI'
  },
  [MODEL_PROVIDERS.MUSE]: {
    label: 'Muse',
    blurb: 'AI audit: Muse scores the form and writes the recommendations'
  }
};
