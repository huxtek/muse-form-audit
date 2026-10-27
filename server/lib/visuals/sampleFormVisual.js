/**
 * The Dev Mode sample form visual.
 *
 * Mock mode is the zero-config path: no API key, no browser, no network. The
 * visual overlay still needs a picture and some boxes, so a small wireframe
 * ships with the repo and these rectangles match its pixels exactly.
 *
 * Regenerate both together with .agents/tasks/make-sample-form-png.mjs if the
 * image changes, or the overlay will point at the wrong places.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const SAMPLE_FORM_IMAGE = readFileSync(
  path.join(__dirname, '..', '..', 'mock-data', 'sample-form.png')
);

export const SAMPLE_FORM_WIDTH = 680;
export const SAMPLE_FORM_HEIGHT = 420;

const field = (name, type, tagName, x, y, width, height) => ({
  name,
  id: '',
  type,
  tagName,
  value: '',
  rect: { x, y, width, height },
  renderable: true
});

export const SAMPLE_FORM_FIELDS = [
  field('fullName', 'text', 'input', 210, 56, 360, 34),
  field('emailAddress', 'email', 'input', 210, 112, 360, 34),
  field('phoneNumber', 'tel', 'input', 210, 168, 240, 34),
  field('subject', 'select', 'select', 210, 224, 280, 34),
  field('message', 'textarea', 'textarea', 210, 280, 440, 62),
  field('submitRequest', 'submit', 'button', 210, 356, 150, 38)
];

/**
 * Sample per-field findings, written so every severity appears and every entry
 * maps to a real box above. Keeps the mock overlay representative of a real
 * model response rather than uniformly coloured.
 */
export const SAMPLE_FIELD_ISSUES = [
  {
    field: 'fullName',
    severity: 'high',
    issue: 'No id and no autocomplete token, so an agent cannot target this control or infer that it wants a person name.'
  },
  {
    field: 'emailAddress',
    severity: 'medium',
    issue: 'Correct type="email" but no required flag, so an agent cannot tell the field is mandatory before submitting.'
  },
  {
    field: 'phoneNumber',
    severity: 'medium',
    issue: 'No pattern or inputmode, so the expected telephone format is unguessable.'
  },
  {
    field: 'subject',
    severity: 'low',
    issue: 'Options carry display text only; an agent has no stable value to select by.'
  },
  {
    field: 'message',
    severity: 'low',
    issue: 'No maxlength or describedby hint, so an agent cannot judge how much detail is wanted.'
  },
  {
    field: 'submitRequest',
    severity: 'high',
    issue: 'Button has no type="submit", so an agent cannot be certain this control submits the form.'
  }
];

/** Visual metadata for one mock form, matching the bundled image. */
export function sampleFormVisual(visualIndex) {
  return {
    formIndex: visualIndex,
    visualIndex,
    signature: { id: '', name: '', action: '/contact', fieldCount: SAMPLE_FORM_FIELDS.length },
    visible: true,
    width: SAMPLE_FORM_WIDTH,
    height: SAMPLE_FORM_HEIGHT,
    truncated: false,
    fields: SAMPLE_FORM_FIELDS,
    hasScreenshot: true,
    isSample: true
  };
}
