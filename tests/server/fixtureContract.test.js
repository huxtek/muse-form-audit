import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

import {
  AI_ACCESSIBILITY_FLAGS,
  CATEGORY_KEYS,
  normalizeFormAnalysis
} from '../../server/lib/analysis/formAnalysisSchema.js';

/**
 * The demo runs on fixtures, not on the analyser.
 *
 * Everything about rendering is exercised for real -- the overlay, the
 * tooltips, the findings list, the page map, the PDF -- but the capture and
 * analysis pipeline is replaced wholesale. So a change to the DATA contract
 * does not reach the demo on its own, and the fixtures quietly fall behind
 * what a real scan produces. That happened three times while this was being
 * built: formFindings, a third sample form, and findings split one per
 * problem all needed the fixtures edited by hand.
 *
 * These tests make that drift fail loudly instead of silently shipping a
 * demo that shows a shape the analyser no longer produces -- or misses one
 * it now does.
 */

const loadFixture = (name) =>
  JSON.parse(
    readFileSync(path.join(process.cwd(), 'server/mock-data', name), 'utf8')
  );

const FIXTURES = ['single-page-response.json', 'full-crawl-response.json'];

const analysedForms = (fixture) =>
  (fixture.results?.forms ?? []).map((form) => form.accessibility ?? {});

describe.each(FIXTURES)('%s satisfies the analysis schema', (name) => {
  const fixture = loadFixture(name);

  it('has forms to show', () => {
    expect(analysedForms(fixture).length).toBeGreaterThan(0);
  });

  it('carries every category the schema defines', () => {
    // A category added to the schema and not to the fixtures would render as
    // an empty row in the demo while scoring normally on real scans.
    for (const accessibility of analysedForms(fixture)) {
      for (const key of CATEGORY_KEYS) {
        expect(accessibility.categories?.[key], `${name} missing category ${key}`).toBeDefined();
      }
    }
  });

  it('carries every accessibility flag the schema defines', () => {
    for (const accessibility of analysedForms(fixture)) {
      for (const flag of AI_ACCESSIBILITY_FLAGS) {
        expect(
          accessibility.aiAccessibility?.[flag],
          `${name} missing aiAccessibility.${flag}`
        ).toBeDefined();
      }
    }
  });

  it('survives the real normaliser without losing anything', () => {
    // The demo never calls normalizeFormAnalysis, so this is the only place
    // the fixtures meet the code that shapes real output.
    for (const accessibility of analysedForms(fixture)) {
      const normalized = normalizeFormAnalysis(accessibility);

      expect(normalized.fieldIssues).toHaveLength(accessibility.fieldIssues?.length ?? 0);
      expect(normalized.formFindings).toHaveLength(accessibility.formFindings?.length ?? 0);
      expect(normalized.issues).toHaveLength(accessibility.issues?.length ?? 0);
      expect(normalized.recommendations).toHaveLength(
        accessibility.recommendations?.length ?? 0
      );

      // Category scores must pass through untouched: a fixture score outside
      // its category maximum would be clamped, and the demo would then show
      // a different number than the fixture claims.
      for (const key of CATEGORY_KEYS) {
        expect(normalized.categories[key].score, `${name} ${key} was clamped`).toBe(
          accessibility.categories[key].score
        );
      }
    }
  });

  it('states a score the categories actually add up to', () => {
    // Hand-edited fixtures drift here first: findings get added without the
    // headline score moving, and the demo contradicts itself.
    for (const accessibility of analysedForms(fixture)) {
      const recomputed = normalizeFormAnalysis(accessibility).score;

      expect(
        Math.abs(recomputed - accessibility.score),
        `${name} claims ${accessibility.score} but its categories total ${recomputed}`
      ).toBeLessThanOrEqual(1);
    }
  });

  it('names only controls that exist on the sample capture', async () => {
    // A finding naming a control the bundled image does not contain renders
    // as an "not on image" footnote that looks like a bug rather than a
    // deliberate case.
    const { SAMPLE_FORM_FIELDS, SAMPLE_WIDE_FIELDS } = await import(
      '../../server/lib/visuals/sampleFormVisual.js'
    );
    const known = new Set(
      [...SAMPLE_FORM_FIELDS, ...SAMPLE_WIDE_FIELDS].map((field) => field.name)
    );

    for (const accessibility of analysedForms(fixture)) {
      for (const issue of accessibility.fieldIssues ?? []) {
        expect(known.has(issue.field), `${name} names unknown control ${issue.field}`).toBe(true);
      }
    }
  });
});
