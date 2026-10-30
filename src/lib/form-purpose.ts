/**
 * Saying what a form is for, from what was measured.
 *
 * Needed because a form can be listed in a report without being visible
 * anywhere on the page. united.com returns its co-browse support widget --
 * a PIN field and a "Start CoBrowse" button behind `display:none` -- and
 * "Form 2" with no picture tells a reader nothing about what it is.
 *
 * Everything here is derived: the characteristics the extractor detected, or
 * the control names the page itself declares. Nothing is inferred about
 * intent. A form whose controls say `cobrowse.pin` lets the reader draw
 * their own conclusion; a guess printed as fact would not.
 */
import type { AnalyzedForm } from '@/lib/scan-types';

/** Named controls listed before the phrase turns into a count. */
const MAX_NAMED_CONTROLS = 3;

/** True when the form is in the markup but generates no box on the page. */
export const isFormNotRendered = (form: AnalyzedForm): boolean =>
  form.visual?.notRendered === true;

/**
 * A short kind, when the extractor's characteristics support one.
 *
 * Returns null rather than a vague label: "form" adds nothing, and the
 * caller can fall back to the control names, which are more specific than
 * any category would be.
 */
export const formKind = (form: AnalyzedForm): string | null => {
  const characteristics = form.characteristics ?? {};

  if (characteristics.isLoginForm) return 'sign-in form';
  if (characteristics.isSearchForm) return 'search form';
  if (characteristics.isContactForm) return 'contact form';

  return null;
};

/** The control names a reader can recognise, page-declared only. */
const namedControls = (form: AnalyzedForm): string[] =>
  (form.fields ?? [])
    .map((field) => field.name || field.id || '')
    .filter((name) => Boolean(name) && !/^field-\d+$/.test(name));

/**
 * A noun phrase describing the form, for use after "This is".
 *
 * Examples: "a sign-in form", "a form with 2 controls (cobrowse.pin,
 * submitPin)", "a form with no controls".
 */
export const describeFormPurpose = (form: AnalyzedForm): string => {
  const kind = formKind(form);
  const total = (form.fields ?? []).length;
  const named = namedControls(form);

  if (kind && named.length > 0) {
    return `a ${kind} (${named.slice(0, MAX_NAMED_CONTROLS).join(', ')})`;
  }

  if (kind) {
    return `a ${kind}`;
  }

  if (named.length > 0) {
    const shown = named.slice(0, MAX_NAMED_CONTROLS).join(', ');
    const rest = named.length > MAX_NAMED_CONTROLS ? ', and others' : '';

    return `a form with ${total} control${total === 1 ? '' : 's'} (${shown}${rest})`;
  }

  if (total > 0) {
    return `a form with ${total} unnamed control${total === 1 ? '' : 's'}`;
  }

  return 'a form with no controls';
};

/**
 * The label on a form's tab in the picker.
 *
 * Kept to "Form N" plus a hint, because a tab row has to stay scannable: the
 * full description belongs in the panel the tab opens.
 */
export const formTabHint = (form: AnalyzedForm): string | null => {
  if (isFormNotRendered(form)) {
    return 'hidden';
  }

  return formKind(form);
};
