/**
 * Captures a per-form screenshot plus field geometry from the live page.
 *
 * Form extraction elsewhere runs on the serialized HTML through cheerio, which
 * has no layout engine and therefore no coordinates. The overlay needs real
 * pixels, so this runs while the puppeteer page is still open and pairs each
 * form with a cropped PNG and the bounding box of every control inside it.
 *
 * Coordinates are returned RELATIVE TO THE FORM CROP, so the client can scale
 * them by a single factor (rendered width / captured width) without knowing
 * anything about page scroll or viewport.
 *
 * Index alignment: both this and the cheerio extractor enumerate `form`
 * elements in document order from the same DOM, so `formIndex` lines up. A
 * `signature` is included so the consumer can sanity-check the pairing rather
 * than trusting the index blindly.
 */

/** Controls worth outlining. */
const FIELD_SELECTOR = 'input, select, textarea, button';

/** Caps so one pathological page cannot exhaust memory. */
export const VISUAL_LIMITS = {
  maxForms: Number(process.env.VISUAL_MAX_FORMS || 15),
  maxFormHeight: Number(process.env.VISUAL_MAX_FORM_HEIGHT || 4000),
  maxFormWidth: Number(process.env.VISUAL_MAX_FORM_WIDTH || 2000),
  minFormSize: 8
};

/**
 * Reads form and field geometry from the page. Pure DOM work, no screenshots.
 * Exported for testing against a fake page object.
 */
export async function readFormGeometry(page, limits = VISUAL_LIMITS) {
  return page.evaluate(
    (fieldSelector, maxForms, minSize) => {
      const forms = Array.from(document.querySelectorAll('form')).slice(0, maxForms);

      return forms.map((form, formIndex) => {
        const formRect = form.getBoundingClientRect();
        // getBoundingClientRect is viewport-relative; make it page-absolute.
        const pageX = formRect.left + window.scrollX;
        const pageY = formRect.top + window.scrollY;

        const visible = formRect.width >= minSize && formRect.height >= minSize;

        const fields = Array.from(form.querySelectorAll(fieldSelector))
          .map((el) => {
            const rect = el.getBoundingClientRect();
            const name = el.getAttribute('name') || '';
            const id = el.getAttribute('id') || '';

            return {
              name,
              id,
              type: (el.getAttribute('type') || el.tagName).toLowerCase(),
              tagName: el.tagName.toLowerCase(),
              value: el.getAttribute('value') || '',
              // Relative to the form crop.
              rect: {
                x: Math.round(rect.left + window.scrollX - pageX),
                y: Math.round(rect.top + window.scrollY - pageY),
                width: Math.round(rect.width),
                height: Math.round(rect.height)
              },
              // A zero-size control is hidden or collapsed: no box to draw.
              renderable: rect.width >= 1 && rect.height >= 1
            };
          })
          // Keep only controls we can actually point at.
          .filter((field) => field.renderable);

        return {
          formIndex,
          signature: {
            id: form.getAttribute('id') || '',
            name: form.getAttribute('name') || '',
            action: form.getAttribute('action') || '',
            fieldCount: form.querySelectorAll(fieldSelector).length
          },
          visible,
          rect: {
            x: Math.round(pageX),
            y: Math.round(pageY),
            width: Math.round(formRect.width),
            height: Math.round(formRect.height)
          },
          fields
        };
      });
    },
    FIELD_SELECTOR,
    limits.maxForms,
    limits.minFormSize
  );
}

/**
 * Captures geometry plus a cropped PNG per form.
 *
 * Returns one entry per form, always: a form that could not be photographed
 * still reports its fields and an explicit reason, so the client can show the
 * text findings rather than an empty frame.
 */
export async function captureFormVisuals(page, { limits = VISUAL_LIMITS, logger = console } = {}) {
  let geometry;
  try {
    geometry = await readFormGeometry(page, limits);
  } catch (error) {
    logger.warn?.(`⚠️  [VISUALS] Geometry read failed: ${error.message}`);

    return [];
  }

  const visuals = [];

  for (const form of geometry) {
    const base = {
      formIndex: form.formIndex,
      signature: form.signature,
      fields: form.fields,
      width: form.rect.width,
      height: form.rect.height
    };

    if (!form.visible) {
      visuals.push({ ...base, screenshot: null, unavailableReason: 'form is hidden or has no size' });
      continue;
    }

    // Clamp the crop: a very tall form would otherwise produce a huge PNG.
    const width = Math.min(form.rect.width, limits.maxFormWidth);
    const height = Math.min(form.rect.height, limits.maxFormHeight);
    const truncated = height < form.rect.height || width < form.rect.width;

    try {
      const buffer = await page.screenshot({
        type: 'png',
        clip: {
          x: Math.max(0, form.rect.x),
          y: Math.max(0, form.rect.y),
          width,
          height
        },
        captureBeyondViewport: true
      });

      visuals.push({
        ...base,
        // The capture is what the client scales against, which may be the
        // clamped size rather than the form's full size.
        width,
        height,
        truncated,
        screenshot: Buffer.from(buffer),
        contentType: 'image/png',
        byteLength: buffer.length
      });
    } catch (error) {
      logger.warn?.(
        `⚠️  [VISUALS] Screenshot failed for form ${form.formIndex}: ${error.message}`
      );
      visuals.push({ ...base, screenshot: null, unavailableReason: error.message });
    }
  }

  const captured = visuals.filter((v) => v.screenshot).length;
  logger.log?.(
    `📸 [VISUALS] Captured ${captured}/${visuals.length} form screenshots` +
      (captured ? ` (${Math.round(visuals.reduce((n, v) => n + (v.byteLength || 0), 0) / 1024)} kB)` : '')
  );

  return visuals;
}

/**
 * Strips the image bytes off a visual, leaving the JSON-safe geometry that
 * ships inside the scan results. The bytes go to the screenshot store.
 */
export function toVisualMetadata(visual) {
  if (!visual) {
    return null;
  }

  const { screenshot, contentType, byteLength, ...rest } = visual;

  return { ...rest, hasScreenshot: Boolean(screenshot) };
}

/**
 * Pairs extracted forms with their captured visuals by document order, moving
 * the image bytes into the screenshot store as it goes.
 *
 * Index alignment is sound because both enumerate `form` elements in document
 * order from the same DOM. It is still verified, but by NAME OVERLAP rather
 * than field count: the two selectors legitimately differ (the extractor takes
 * `button[type="submit"]`, the capture takes every `button`, so an untyped
 * submit button counts once on one side only). A misplaced highlight is worse
 * than none, so geometry is dropped when the names look unrelated.
 */
/** Identifying tokens for a control, lowercased. */
const identifiers = (field) =>
  [field?.name, field?.id].filter((value) => typeof value === 'string' && value.trim()).map((v) => v.toLowerCase());

/**
 * True when the captured geometry plausibly belongs to the extracted form.
 *
 * Accepts when at least one identifier is shared. When neither side has any
 * identifier at all there is nothing to compare, so it accepts on document
 * order alone -- the overlay then simply has no names to attribute issues to.
 */
export function formsLookRelated(extractedForm, visual) {
  const extracted = new Set((extractedForm?.fields ?? []).flatMap(identifiers));
  const captured = new Set((visual?.fields ?? []).flatMap(identifiers));

  if (extracted.size === 0 || captured.size === 0) {
    return true;
  }

  for (const token of captured) {
    if (extracted.has(token)) {
      return true;
    }
  }

  return false;
}

export function attachVisualsToForms({
  forms = [],
  visuals = [],
  jobId,
  putScreenshot,
  // Screenshots are keyed per job, so a crawl spanning several pages offsets
  // local form indexes into a global sequence to keep keys unique.
  indexOffset = 0,
  logger = console
}) {
  return forms.map((form, index) => {
    const visual = visuals[index];
    const visualIndex = indexOffset + index;

    if (!visual) {
      return form;
    }

    if (!formsLookRelated(form, visual)) {
      logger.warn?.(
        `⚠️  [VISUALS] Form ${index} geometry does not match the extracted form - skipping overlay`
      );

      return form;
    }

    if (visual.screenshot && jobId && putScreenshot) {
      putScreenshot(jobId, visualIndex, {
        buffer: visual.screenshot,
        contentType: visual.contentType
      });
    }

    return { ...form, visual: { ...toVisualMetadata(visual), visualIndex } };
  });
}
