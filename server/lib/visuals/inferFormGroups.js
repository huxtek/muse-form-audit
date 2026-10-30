/**
 * Finds form-like groups of fields that are not inside a `<form>` element,
 * and wraps each one in a real form so the rest of the pipeline sees it.
 *
 * Measured need: instagram.com/accounts/emailsignup/ renders two text inputs
 * and a password input with no `<form>` tag anywhere on the page. The
 * extractor queries `$('form')`, so the scan reported "0 forms found" for a
 * signup page -- and an earlier version of this codebase already counted
 * those orphan fields, logged the number, and threw them away.
 *
 * Wrapping the live DOM rather than reporting a parallel list of candidates
 * is deliberate. `page.content()` is serialised before the geometry pass, and
 * the geometry pass enumerates `document.querySelectorAll('form')`; both run
 * after this. So a real inserted form is seen by the HTML extractor, by the
 * screenshot geometry, and by the pairing between them, with no change to any
 * of them. The alternative -- a separate candidate list -- would need the same
 * clustering implemented twice, once in the browser for geometry and once in
 * node for markup, and the two would drift.
 *
 * `display: contents` on the wrapper is what makes it safe: the element
 * generates no box, so nothing reflows and the fields keep their positions. It
 * does mean the wrapper has no box of its own to measure, which
 * `resolveFormBox` already handles -- it falls back to the boxes of the
 * controls inside, and records `measuredFrom` so a reader can tell.
 */

/**
 * On by default, with an escape hatch.
 *
 * Inference is a judgement about markup the author did not write, so there
 * has to be a way to turn it off and get the strict `<form>`-only reading
 * back without editing code.
 */
export const FORM_INFERENCE_ENABLED = process.env.INFER_FORM_GROUPS !== 'false';

/** Caps, so a pathological page cannot turn into hundreds of forms. */
export const INFERENCE_LIMITS = {
  /** Most inferred forms to create on one page. */
  maxGroups: 8,
  /**
   * Loop guard on the walk up the tree, not a tuning knob.
   *
   * It was 8, which quietly broke the thing this module exists for: on the
   * Instagram signup page the fields are more than eight levels below the
   * container they share, so every field gave up and became its own
   * single-field form -- five forms of one field each instead of a signup
   * group and a search box. Correctness comes from `maxFieldsPerGroup`
   * rejecting containers that are too broad, not from refusing to look up.
   */
  maxAncestorDepth: 30,
  /**
   * Most fields a container may hold and still be considered one form.
   * Above this it is page furniture, not a form.
   */
  maxFieldsPerGroup: 40,
  /** Fields below this size are decorative or off-screen. */
  minFieldSize: 4
};

/**
 * Attribute marking a wrapper this module created.
 *
 * Read downstream so a report can say the grouping was inferred rather than
 * declared by the page. A form we invented and a form the author wrote are
 * different claims and should not look identical.
 */
export const INFERRED_FORM_ATTRIBUTE = 'data-huxtek-inferred-form';

/**
 * Runs in the page. Returns what it wrapped, for logging.
 *
 * Written as one self-contained function because it is serialised into the
 * browser by `page.evaluate` and cannot reference anything from this module.
 */
/* c8 ignore start -- executes in the browser, covered by the live-page test */
function wrapOrphanFieldGroups(limits, markerAttribute) {
  const FIELD_SELECTOR = 'input, textarea, select';

  const isUsable = (el) => {
    const type = (el.getAttribute('type') || '').toLowerCase();

    if (type === 'hidden') {
      return false;
    }

    const rect = el.getBoundingClientRect();

    return rect.width >= limits.minFieldSize && rect.height >= limits.minFieldSize;
  };

  // Fields the page never put in a form. `closest` crosses no shadow
  // boundary, which is correct here: shadow content is a separate problem
  // with a separate fix.
  const orphans = Array.from(document.querySelectorAll(FIELD_SELECTOR)).filter(
    (el) => !el.closest('form') && isUsable(el)
  );

  if (orphans.length === 0) {
    return { groups: [], orphansFound: 0 };
  }

  const orphanSet = new Set(orphans);
  const countOrphansIn = (node) =>
    Array.from(node.querySelectorAll(FIELD_SELECTOR)).filter((el) => orphanSet.has(el)).length;

  /*
   * The container for a field is the nearest ancestor it shares with another
   * orphan. That separates things the page treats separately: on the
   * Instagram signup page the two name fields and the password sit in one
   * subtree while the site search input sits in the header, so they come out
   * as different groups rather than one nonsensical form.
   *
   * A field sharing no container with any other is still a form -- a lone
   * search box is something an agent fills in -- so it becomes a group of
   * one rather than being dropped.
   */
  const sharedRootFor = (field) => {
    let node = field.parentElement;
    let depth = 0;

    while (node && node !== document.body && node !== document.documentElement) {
      if (depth >= limits.maxAncestorDepth) {
        return null;
      }

      if (countOrphansIn(node) >= 2) {
        // Too broad to be one form: page furniture that happens to contain
        // several unrelated inputs.
        return node.querySelectorAll(FIELD_SELECTOR).length <= limits.maxFieldsPerGroup
          ? node
          : null;
      }

      node = node.parentElement;
      depth += 1;
    }

    return null;
  };

  const shared = [];
  for (const field of orphans) {
    const root = sharedRootFor(field);

    if (root && !shared.includes(root)) {
      shared.push(root);
    }
  }

  // Keep the tightest grouping: a root containing another chosen root would
  // merge two distinct forms into one.
  const tightest = shared.filter(
    (root) => !shared.some((other) => other !== root && root.contains(other))
  );

  /*
   * A field left over by that filtering is still a form.
   *
   * It happens when a field's only shared ancestor was a broad container
   * that got dropped -- the site search input on a signup page is the usual
   * shape. Without this the field would vanish rather than be reported, and
   * a lone search box is exactly the kind of control an agent is asked to
   * fill in.
   */
  for (const field of orphans) {
    if (tightest.some((root) => root.contains(field))) {
      continue;
    }

    const parent = field.parentElement;
    const solitary =
      parent && parent.querySelectorAll(FIELD_SELECTOR).length === 1 ? parent : field;

    if (!tightest.includes(solitary)) {
      tightest.push(solitary);
    }
  }

  const wrapped = [];

  for (const root of tightest) {
    if (wrapped.length >= limits.maxGroups) {
      break;
    }

    const fieldCount = root.querySelectorAll(FIELD_SELECTOR).length;

    if (fieldCount === 0 || fieldCount > limits.maxFieldsPerGroup) {
      continue;
    }

    // A root already inside something we wrapped would produce nested forms,
    // which is invalid HTML and would confuse the extractor.
    if (root.closest('form')) {
      continue;
    }

    try {
      const form = document.createElement('form');
      form.setAttribute(markerAttribute, '1');
      // No box, so nothing moves and no layout is disturbed.
      form.style.display = 'contents';

      root.parentNode.insertBefore(form, root);
      form.appendChild(root);

      wrapped.push({
        fieldCount,
        tagName: root.tagName.toLowerCase(),
        id: root.getAttribute('id') || '',
        className: (root.getAttribute('class') || '').slice(0, 80)
      });
    } catch {
      // A framework may own this subtree and refuse to be reparented. One
      // group failing must not stop the others.
    }
  }

  return { groups: wrapped, orphansFound: orphans.length };
}
/* c8 ignore stop */

/**
 * Wraps orphan field groups on the page, in place.
 *
 * Call before the HTML is serialised and before geometry is read, so both see
 * the same set of forms. Never throws: a page that cannot be normalised
 * should scan exactly as it did before this existed.
 */
export async function inferFormGroups(
  page,
  { limits = INFERENCE_LIMITS, logger = console } = {}
) {
  try {
    const result = await page.evaluate(wrapOrphanFieldGroups, limits, INFERRED_FORM_ATTRIBUTE);

    if (result.groups.length > 0) {
      const fields = result.groups.reduce((n, g) => n + g.fieldCount, 0);
      logger?.log?.(
        `   🧩 [FORMS] Inferred ${result.groups.length} form group(s) from ` +
          `${result.orphansFound} field(s) outside any <form> (${fields} field(s) grouped)`
      );
    } else if (result.orphansFound > 0) {
      logger?.log?.(
        `   🧩 [FORMS] ${result.orphansFound} field(s) outside any <form>, none groupable`
      );
    }

    return result;
  } catch (error) {
    logger?.warn?.(`   ⚠ [FORMS] Form inference skipped: ${error.message}`);

    return { groups: [], orphansFound: 0 };
  }
}
