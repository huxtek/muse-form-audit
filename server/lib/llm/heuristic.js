/**
 * Heuristic "provider": the deterministic, rule-based analyser.
 *
 * It is registered alongside the real model providers so the UI can offer it
 * as a first-class choice -- the demo compares a rule-based audit against an
 * AI audit of the same form. It is NOT a model, so it advertises
 * `usesModel: false` and the analysis layer short-circuits to the
 * deterministic result instead of making a request.
 *
 * Because it needs no API key it always counts as configured, which is what
 * lets the app run a real scan with only a Browserless token.
 */
export function createHeuristicProvider() {
  return {
    name: 'heuristic',
    label: 'Heuristic',
    model: 'rule-based',
    usesModel: false,
    isConfigured: () => true,
    requiredEnvVar: null,

    async createCompletion() {
      // Defensive: nothing should reach this. `analyzeFormWithModel` checks
      // `usesModel` first, and the agent's conversation loop is not used by
      // either scan path.
      throw new Error(
        'The heuristic analyser does not call a model. This is a bug: check usesModel handling.'
      );
    }
  };
}
