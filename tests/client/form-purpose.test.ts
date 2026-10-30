import { describe, expect, it } from 'vitest';

import { describeFormPurpose, formKind, formTabHint, isFormNotRendered } from '@/lib/form-purpose';
import type { AnalyzedForm } from '@/lib/scan-types';

/**
 * "Form 2", no picture, no explanation.
 *
 * That is what united.com's second form looked like in the report: its
 * co-browse support widget, a PIN field and a "Start CoBrowse" button behind
 * `display:none` on an ancestor `<section>`. A reader had no way to tell
 * what it was or why it had no screenshot.
 *
 * Everything here is derived from what was measured. A guess about intent
 * printed as fact would be worse than a plain list of the controls.
 */
const form = (overrides: Partial<AnalyzedForm> = {}): AnalyzedForm => ({
  formId: 'form-1',
  ...overrides
});

describe('what kind of form it is', () => {
  it('uses the characteristic the extractor detected', async () => {
    expect(formKind(form({ characteristics: { isLoginForm: true } }))).toBe('sign-in form');
    expect(formKind(form({ characteristics: { isSearchForm: true } }))).toBe('search form');
    expect(formKind(form({ characteristics: { isContactForm: true } }))).toBe('contact form');
  });

  it('says nothing rather than something vague', async () => {
    // "A form" as a description of a form is noise, and the control names
    // below are more specific than any category.
    expect(formKind(form())).toBeNull();
    expect(formKind(form({ characteristics: {} }))).toBeNull();
  });
});

describe('describing a form for a reader', () => {
  it('names the controls when there is no detected kind', async () => {
    // united.com's co-browse widget. "cobrowse.pin" is the useful part.
    const described = describeFormPurpose(
      form({
        fields: [
          { id: '22437b90', name: 'cobrowse.pin', type: 'text' },
          { id: 'field-1', name: '', type: 'submit' }
        ]
      })
    );

    expect(described).toBe('a form with 2 controls (cobrowse.pin)');
  });

  it('combines a kind with its controls', async () => {
    const described = describeFormPurpose(
      form({
        characteristics: { isLoginForm: true },
        fields: [
          { id: 'e', name: 'email', type: 'email' },
          { id: 'p', name: 'password', type: 'password' }
        ]
      })
    );

    expect(described).toBe('a sign-in form (email, password)');
  });

  it('stops naming controls before the phrase runs away', async () => {
    const described = describeFormPurpose(
      form({
        fields: ['a', 'b', 'c', 'd', 'e'].map((name) => ({ id: name, name, type: 'text' }))
      })
    );

    expect(described).toBe('a form with 5 controls (a, b, c, and others)');
  });

  it('ignores the placeholder names the extractor invents', async () => {
    // `field-0` is what the extractor assigns when the page gave no id; it
    // is not a name a reader can recognise.
    const described = describeFormPurpose(
      form({
        fields: [
          { id: 'field-0', name: '', type: 'text' },
          { id: 'field-1', name: '', type: 'submit' }
        ]
      })
    );

    expect(described).toBe('a form with 2 unnamed controls');
  });

  it('handles a form with nothing in it', async () => {
    expect(describeFormPurpose(form())).toBe('a form with no controls');
    expect(describeFormPurpose(form({ fields: [] }))).toBe('a form with no controls');
  });

  it('uses the singular for one control', async () => {
    expect(describeFormPurpose(form({ fields: [{ id: 'pin', name: '', type: 'text' }] }))).toBe(
      'a form with 1 control (pin)'
    );
    expect(describeFormPurpose(form({ fields: [{ id: 'field-0', name: '', type: 'text' }] }))).toBe(
      'a form with 1 unnamed control'
    );
  });
});

describe('the hint on a form tab', () => {
  it('marks a form that is not rendered', async () => {
    const hidden = form({
      visual: { visualIndex: 1, width: 0, height: 0, hasScreenshot: false, fields: [], notRendered: true }
    });

    expect(isFormNotRendered(hidden)).toBe(true);
    expect(formTabHint(hidden)).toBe('hidden');
  });

  it('prefers "hidden" over the kind, since that is the surprising part', async () => {
    const hidden = form({
      characteristics: { isLoginForm: true },
      visual: { visualIndex: 1, width: 0, height: 0, hasScreenshot: false, fields: [], notRendered: true }
    });

    expect(formTabHint(hidden)).toBe('hidden');
  });

  it('falls back to the kind for a visible form', async () => {
    const visible = form({
      characteristics: { isSearchForm: true },
      visual: { visualIndex: 0, width: 100, height: 40, hasScreenshot: true, fields: [] }
    });

    expect(formTabHint(visible)).toBe('search form');
  });

  it('says nothing for an ordinary visible form', async () => {
    expect(formTabHint(form())).toBeNull();
  });
});
