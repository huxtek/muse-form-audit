/**
 * Analysis provider registry.
 *
 * The scanner can score forms two ways, and the UI switch chooses between
 * them so a demo can show the difference on the same form:
 *
 *   heuristic -- the deterministic, rule-based analyser. No API key needed.
 *   muse      -- Muse scores the form directly. The default, and permanent.
 *
 * `openai` stays registered so the original Chat Completions path still works
 * for anyone who sets OPENAI_API_KEY, but it is not offered in the UI.
 *
 * Model providers expose:
 *   name, label, model, usesModel, requiredEnvVar, isConfigured(),
 *   createCompletion()
 *
 * `createCompletion` takes and returns Chat Completions shapes, so callers do
 * not branch on provider. Providers with `usesModel: false` never receive a
 * call: the analysis layer short-circuits to the deterministic result.
 */
import { cleanEnvValue } from './envValue.js';
import { createHeuristicProvider } from './heuristic.js';
import { createMuseProvider } from './muse.js';
import { createOpenAiProvider } from './openai.js';

export const MODEL_PROVIDERS = {
  heuristic: createHeuristicProvider,
  muse: createMuseProvider,
  openai: createOpenAiProvider
};

/** Allowlist for anything arriving from a request body. */
export const PROVIDER_NAMES = Object.keys(MODEL_PROVIDERS);

export const DEFAULT_PROVIDER = 'muse';

/** The two the UI switch offers. `openai` is env-only. */
export const UI_PROVIDER_NAMES = ['heuristic', 'muse'];

/**
 * Resolves a provider name to use. Falls back to the configured default rather
 * than throwing, so an unexpected value can never take the server down; the
 * caller validates untrusted input with `isValidProvider` first.
 */
export function resolveProviderName(requested) {
  if (isValidProvider(requested)) {
    return requested;
  }

  // Cleaned, so MODEL_PROVIDER="muse\n" selects Muse rather than silently
  // failing validation and falling through to the default.
  const fromEnv = cleanEnvValue(process.env.MODEL_PROVIDER);
  if (isValidProvider(fromEnv)) {
    return fromEnv;
  }

  return DEFAULT_PROVIDER;
}

export function isValidProvider(name) {
  return typeof name === 'string' && Object.hasOwn(MODEL_PROVIDERS, name);
}

export function createLlmProvider(requested, options = {}) {
  const name = resolveProviderName(requested);

  return MODEL_PROVIDERS[name](options);
}

/** Configuration status for /health, without leaking any key material. */
export function describeProviders() {
  return PROVIDER_NAMES.reduce((acc, name) => {
    const provider = MODEL_PROVIDERS[name]();
    acc[name] = {
      label: provider.label,
      model: provider.model,
      usesModel: provider.usesModel !== false,
      configured: provider.isConfigured(),
      offeredInUi: UI_PROVIDER_NAMES.includes(name)
    };

    return acc;
  }, {});
}
