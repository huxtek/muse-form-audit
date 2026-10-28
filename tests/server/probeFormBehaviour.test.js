import { describe, expect, it, vi } from 'vitest';

import {
  attachBehaviourToForms,
  probeFormBehaviour,
  summariseBehaviour
} from '../../server/lib/analysis/probeFormBehaviour.js';
import { buildAnalysisPrompt } from '../../server/lib/analysis/modelFormAnalyzer.js';

/**
 * The analyser scores a validation category out of 10 while only ever seeing
 * the form at rest, so it used to treat an empty error container as a missing
 * one. These tests pin the two halves of the fix: the facts the probe
 * gathers, and the wording that tells the model what it is looking at.
 *
 * The browser half runs in page context and cannot be exercised here -- jsdom
 * has no layout and no constraint validation worth the name -- so the
 * judgement lives in pure functions and the page call is only checked for the
 * contract it must honour.
 */

const behaviourFixture = (overrides = {}) => ({
  formIndex: 0,
  signature: { id: 'contact', name: '', action: '/send' },
  affordances: {
    noValidate: false,
    method: 'post',
    hasAction: true,
    liveRegions: [
      { id: 'email-error', role: 'alert', ariaLive: 'polite', emptyAtRest: true, text: '' }
    ],
    fields: [
      {
        field: 'email',
        constraints: { required: true, type: 'email', autocomplete: 'email' },
        describedBy: [{ id: 'email-hint', present: true, empty: false, text: 'We never share it' }],
        ariaInvalidAtRest: ''
      }
    ],
    ...overrides.affordances
  },
  constraintCheck: {
    ran: true,
    error: null,
    formValid: false,
    fields: [
      {
        field: 'email',
        willValidate: true,
        valid: false,
        failures: ['valueMissing'],
        message: 'Please fill out this field.'
      }
    ],
    messagingChanged: false,
    ariaInvalidAfter: [],
    ...overrides.constraintCheck
  }
});

describe('summariseBehaviour', () => {
  it('reports declared constraints with their values', () => {
    const summary = summariseBehaviour(behaviourFixture());

    expect(summary).toContain('email: required, type=email, autocomplete=email');
  });

  it('says an empty alert region is waiting, not missing', () => {
    // This is the whole point: the model used to read an empty container as a
    // defect and mark validation down for it.
    const summary = summariseBehaviour(behaviourFixture());

    expect(summary).toContain('#email-error');
    expect(summary).toContain('empty while the form is untouched');
  });

  it('reports what the browser would say about an empty required field', () => {
    const summary = summariseBehaviour(behaviourFixture());

    expect(summary).toContain('form reports INVALID');
    expect(summary).toContain('email fails valueMissing');
    expect(summary).toContain('Please fill out this field.');
  });

  it('states plainly that nothing rendering is not proof of nothing existing', () => {
    const summary = summariseBehaviour(behaviourFixture());

    expect(summary).toMatch(/does NOT mean there is no error handling/i);
    expect(summary).toMatch(/cannot be observed without submitting it, which was not done/i);
  });

  it('credits a form that did render a message on the failed check', () => {
    const summary = summariseBehaviour(
      behaviourFixture({ constraintCheck: { messagingChanged: true } })
    );

    expect(summary).toMatch(/error output is wired up/i);
    expect(summary).not.toMatch(/does NOT mean/i);
  });

  it('flags novalidate as constraints that will not be enforced', () => {
    const summary = summariseBehaviour(
      behaviourFixture({ affordances: { ...behaviourFixture().affordances, noValidate: true } })
    );

    expect(summary).toMatch(/novalidate.*will NOT enforce/s);
  });

  it('names fields the browser will not validate at all', () => {
    const summary = summariseBehaviour(
      behaviourFixture({
        constraintCheck: {
          fields: [
            { field: 'nickname', willValidate: false, valid: true, failures: [], message: '' }
          ]
        }
      })
    );

    expect(summary).toContain('not subject to validation at all: nickname');
  });

  it('says nothing at all when there is nothing to report', () => {
    // An unprobed form's prompt must look exactly as it did before, so a
    // blank section is never added.
    expect(summariseBehaviour(null)).toBe('');
    expect(
      summariseBehaviour({
        affordances: { liveRegions: [], fields: [] },
        constraintCheck: { ran: false }
      })
    ).toBe('');
  });

  it('survives a half-shaped result rather than throwing mid-scan', () => {
    expect(() => summariseBehaviour({})).not.toThrow();
    expect(() => summariseBehaviour({ affordances: {}, constraintCheck: {} })).not.toThrow();
  });
});

describe('buildAnalysisPrompt with observations', () => {
  it('includes the observations and marks them as from the live page', () => {
    const prompt = buildAnalysisPrompt({
      formHtml: '<form><input name="email" required></form>',
      formId: 'contact',
      behaviour: behaviourFixture()
    });

    expect(prompt).toContain('OBSERVED ON THE LIVE PAGE');
    expect(prompt).toContain('was NOT submitted');
    expect(prompt).toContain('email fails valueMissing');
  });

  it('leaves the prompt untouched when there are no observations', () => {
    const without = buildAnalysisPrompt({ formHtml: '<form></form>', formId: 'contact' });

    expect(without).not.toContain('OBSERVED ON THE LIVE PAGE');
  });
});

describe('probeFormBehaviour', () => {
  const silent = { log: () => {}, warn: () => {} };

  it('returns what the page reported', async () => {
    const page = { evaluate: vi.fn().mockResolvedValue([behaviourFixture()]) };

    const result = await probeFormBehaviour(page, { logger: silent });

    expect(result).toHaveLength(1);
    expect(result[0].constraintCheck.formValid).toBe(false);
  });

  it('passes the caps into the page context', async () => {
    const page = { evaluate: vi.fn().mockResolvedValue([]) };

    await probeFormBehaviour(page, {
      limits: { maxForms: 3, maxFields: 7, maxRegions: 4, maxTextLength: 50 },
      logger: silent
    });

    const [, selector, caps] = page.evaluate.mock.calls[0];
    expect(selector).toContain('input');
    expect(caps).toEqual({ maxForms: 3, maxFields: 7, maxRegions: 4, maxTextLength: 50 });
  });

  it('returns nothing rather than throwing when the page call fails', async () => {
    // A probe failure must never cost us the scan.
    const page = { evaluate: vi.fn().mockRejectedValue(new Error('context destroyed')) };

    await expect(probeFormBehaviour(page, { logger: silent })).resolves.toEqual([]);
  });

  it('tolerates a page returning something that is not a list', async () => {
    const page = { evaluate: vi.fn().mockResolvedValue({ nope: true }) };

    await expect(probeFormBehaviour(page, { logger: silent })).resolves.toEqual([]);
  });
});

describe('attachBehaviourToForms', () => {
  it('pairs observations with forms by document order', () => {
    const forms = [{ formId: 'form-0' }, { formId: 'form-1' }];
    const probed = [{ formIndex: 0, affordances: {} }, { formIndex: 1, affordances: {} }];

    const paired = attachBehaviourToForms(forms, probed);

    expect(paired[0].behaviour.formIndex).toBe(0);
    expect(paired[1].behaviour.formIndex).toBe(1);
  });

  it('leaves forms the probe did not reach alone', () => {
    const forms = [{ formId: 'form-0' }, { formId: 'form-1' }];

    const paired = attachBehaviourToForms(forms, [{ formIndex: 0 }]);

    expect(paired[0]).toHaveProperty('behaviour');
    expect(paired[1]).not.toHaveProperty('behaviour');
  });

  it('returns the forms unchanged when there is nothing to attach', () => {
    const forms = [{ formId: 'form-0' }];

    expect(attachBehaviourToForms(forms, [])).toBe(forms);
    expect(attachBehaviourToForms(forms, null)).toBe(forms);
  });
});
