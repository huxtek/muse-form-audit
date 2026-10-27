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

/**
 * The sample whole-page map, with three form slots. PNG rather than JPEG:
 * real captures are JPEG because a full page is megabytes losslessly, but this
 * wireframe is 11 kB either way.
 */
export const SAMPLE_PAGE_IMAGE = readFileSync(
  path.join(__dirname, '..', '..', 'mock-data', 'sample-page.png')
);

export const SAMPLE_PAGE_WIDTH = 1000;
export const SAMPLE_PAGE_HEIGHT = 1320;

/**
 * A short, wide sample form -- a login/signup bar.
 *
 * The tall sample always leaves room for a tooltip, so it cannot exercise the
 * cases short captures produce: a tooltip that overhangs the frame, and an
 * enlarged view that has to scale up rather than sit at natural size. Real
 * pages are full of these, so Dev Mode carries one.
 */
export const SAMPLE_WIDE_IMAGE = readFileSync(
  path.join(__dirname, '..', '..', 'mock-data', 'sample-form-wide.png')
);

export const SAMPLE_WIDE_WIDTH = 1280;
export const SAMPLE_WIDE_HEIGHT = 132;

/** Forms per sample page, so a mock crawl spreads across several maps. */
export const SAMPLE_FORMS_PER_PAGE = 3;

/**
 * Slot rectangles, matching the generated image. The last slot runs off the
 * bottom of the page, so its height is clamped -- a region that overflowed the
 * image would draw outside the frame.
 */
export const SAMPLE_PAGE_SLOTS = [240, 700, 1160].map((y) => ({
  x: 160,
  y,
  width: SAMPLE_FORM_WIDTH,
  height: Math.min(SAMPLE_FORM_HEIGHT, SAMPLE_PAGE_HEIGHT - y)
}));

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
 * Controls on the wide sample, laid out in one row. Deliberately a SUBSET of
 * the field names above: the findings that name `subject` and `message` then
 * have no box to draw, which exercises the "not on image" path too.
 */
export const SAMPLE_WIDE_FIELDS = [
  field('fullName', 'text', 'input', 48, 54, 230, 36),
  field('emailAddress', 'email', 'input', 318, 54, 270, 36),
  field('phoneNumber', 'tel', 'input', 628, 54, 200, 36),
  field('submitRequest', 'submit', 'button', 868, 54, 150, 36)
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

/** Which sample page a mock form sits on, and where on it. */
export function samplePagePlacement(visualIndex) {
  const pageIndex = Math.floor(visualIndex / SAMPLE_FORMS_PER_PAGE);
  const slot = visualIndex % SAMPLE_FORMS_PER_PAGE;

  return { pageIndex, pageRect: SAMPLE_PAGE_SLOTS[slot] };
}

/**
 * Which sample shape a mock form uses. Alternating means a single mock crawl
 * shows both a tall form and a short wide one, so the layout can be checked
 * against both without spending any API credit.
 */
export function isWideSample(visualIndex) {
  return visualIndex % 2 === 1;
}

/** The bundled crop for a mock form, and its dimensions. */
export function sampleFormImage(visualIndex) {
  return isWideSample(visualIndex)
    ? { buffer: SAMPLE_WIDE_IMAGE, width: SAMPLE_WIDE_WIDTH, height: SAMPLE_WIDE_HEIGHT }
    : { buffer: SAMPLE_FORM_IMAGE, width: SAMPLE_FORM_WIDTH, height: SAMPLE_FORM_HEIGHT };
}

/** Visual metadata for one mock form, matching the bundled images. */
export function sampleFormVisual(visualIndex) {
  const { pageIndex, pageRect } = samplePagePlacement(visualIndex);
  const wide = isWideSample(visualIndex);
  const fields = wide ? SAMPLE_WIDE_FIELDS : SAMPLE_FORM_FIELDS;
  const { width, height } = sampleFormImage(visualIndex);

  return {
    formIndex: visualIndex,
    visualIndex,
    signature: { id: '', name: '', action: '/contact', fieldCount: fields.length },
    visible: true,
    width,
    height,
    truncated: false,
    fields,
    hasScreenshot: true,
    isSample: true,
    sampleShape: wide ? 'wide' : 'tall',
    pageRect,
    pageMap: {
      pageIndex,
      width: SAMPLE_PAGE_WIDTH,
      height: SAMPLE_PAGE_HEIGHT,
      truncated: false
    }
  };
}
