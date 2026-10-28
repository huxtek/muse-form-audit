/**
 * What a form's markup cannot tell us, observed from the live page.
 *
 * The analyser scores a `validation` category out of 10 while only ever
 * seeing the form at rest -- and validation, by definition, exists after
 * interaction. Asked to grade something it cannot observe, a model does what
 * anyone would: it treats absence of evidence as evidence of absence, and
 * reports an empty error container as a missing one.
 *
 * Two things are collected here to close that gap.
 *
 * AFFORDANCES are what is visible at rest but easy to overlook: live regions
 * and alert containers that are empty until something goes wrong, the
 * describedby wiring that will carry the message, and the declared
 * constraints. An empty alert region is evidence that error handling EXISTS.
 *
 * CONSTRAINT CHECK asks the browser what it would say. `checkValidity()` runs
 * native constraint validation and fires `invalid` events WITHOUT submitting
 * the form and without any network request, so it is safe to run on a
 * stranger's page. Anything that listens for `invalid` gets a chance to
 * render, and the DOM is diffed afterwards to catch it.
 *
 * Deliberately NOT done here: submitting the form. Submitting a stranger's
 * form can send email, create accounts, fire one-time passcodes or start a
 * payment, and markup cannot tell a harmless form from a destructive one.
 * That belongs behind an explicit opt-in for sites the operator owns.
 *
 * Nothing here types into fields either: a value change is a mutation, and
 * blur handlers that validate on change would be acting on data we invented.
 */

/** Caps, so one enormous form cannot dominate the prompt. */
export const PROBE_LIMITS = {
  maxForms: Number(process.env.PROBE_MAX_FORMS || 15),
  maxFields: Number(process.env.PROBE_MAX_FIELDS || 25),
  maxRegions: Number(process.env.PROBE_MAX_REGIONS || 12),
  maxTextLength: 160
};

/** Set PROBE_FORM_BEHAVIOUR=false to skip the probe entirely. */
export const PROBE_ENABLED = process.env.PROBE_FORM_BEHAVIOUR !== 'false';

const FIELD_SELECTOR = 'input, select, textarea';

/**
 * Reads affordances and runs the safe constraint check, one page round trip.
 *
 * Returns one entry per form in document order, so it lines up with the
 * extractor and the visual capture. Never throws: a probe failure must not
 * cost us the scan.
 */
export async function probeFormBehaviour(page, { limits = PROBE_LIMITS, logger = console } = {}) {
  try {
    const result = await page.evaluate(
      (fieldSelector, caps) => {
        const trim = (value) => String(value ?? '').trim().slice(0, caps.maxTextLength);

        /** A control's identifier, matching how findings name controls. */
        const nameOf = (el) => el.getAttribute('name') || el.getAttribute('id') || '';

        /** Text content of the elements an aria-describedby points at. */
        const describedBy = (el) => {
          const ids = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);

          return ids.map((id) => {
            const target = document.getElementById(id);

            return {
              id,
              present: Boolean(target),
              empty: !trim(target?.textContent),
              text: trim(target?.textContent)
            };
          });
        };

        /** Everything that could announce an error, even if silent now. */
        const liveRegions = (form) => {
          const selector = '[role="alert"], [role="status"], [aria-live], output';
          const inside = [...form.querySelectorAll(selector)];
          // A form's error summary often sits just outside it.
          const near = form.parentElement
            ? [...form.parentElement.querySelectorAll(selector)]
            : [];

          return [...new Set([...inside, ...near])].slice(0, caps.maxRegions).map((el) => ({
            id: el.getAttribute('id') || '',
            role: el.getAttribute('role') || el.tagName.toLowerCase(),
            ariaLive: el.getAttribute('aria-live') || '',
            emptyAtRest: !trim(el.textContent),
            text: trim(el.textContent)
          }));
        };

        const constraintsOf = (el) => {
          const declared = {
            required: el.hasAttribute('required'),
            type: el.getAttribute('type') || el.tagName.toLowerCase(),
            pattern: el.getAttribute('pattern') || '',
            min: el.getAttribute('min') || '',
            max: el.getAttribute('max') || '',
            minLength: el.getAttribute('minlength') || '',
            maxLength: el.getAttribute('maxlength') || '',
            inputMode: el.getAttribute('inputmode') || '',
            autocomplete: el.getAttribute('autocomplete') || ''
          };

          // Only the interesting ones, to keep the prompt small.
          return Object.fromEntries(
            Object.entries(declared).filter(([, value]) => value !== '' && value !== false)
          );
        };

        /** Which constraint a field fails, by name rather than as a bitmask. */
        const failuresOf = (el) => {
          const state = el.validity;
          if (!state || state.valid) {
            return [];
          }

          return [
            'valueMissing',
            'typeMismatch',
            'patternMismatch',
            'tooLong',
            'tooShort',
            'rangeUnderflow',
            'rangeOverflow',
            'stepMismatch',
            'badInput'
          ].filter((key) => state[key]);
        };

        /** A snapshot of all announceable text, for diffing. */
        const announceableText = (form) =>
          liveRegions(form)
            .map((region) => `${region.id}:${region.text}`)
            .join('|');

        const forms = [...document.querySelectorAll('form')].slice(0, caps.maxForms);

        return forms.map((form, formIndex) => {
          const fields = [...form.querySelectorAll(fieldSelector)].slice(0, caps.maxFields);

          const affordances = {
            noValidate: form.hasAttribute('novalidate') || form.noValidate === true,
            method: (form.getAttribute('method') || '').toLowerCase(),
            hasAction: Boolean(form.getAttribute('action')),
            liveRegions: liveRegions(form),
            fields: fields.map((el) => ({
              field: nameOf(el),
              constraints: constraintsOf(el),
              describedBy: describedBy(el),
              ariaInvalidAtRest: el.getAttribute('aria-invalid') || ''
            }))
          };

          const before = announceableText(form);

          // The safe part: native constraint validation, no submission.
          let formValid = null;
          let checkFailed = null;

          try {
            formValid = form.checkValidity();
          } catch (error) {
            checkFailed = String(error?.message ?? error);
          }

          const fieldStates = fields.map((el) => ({
            field: nameOf(el),
            willValidate: el.willValidate === true,
            valid: el.validity?.valid !== false,
            failures: failuresOf(el),
            message: trim(el.validationMessage)
          }));

          const after = announceableText(form);

          return {
            formIndex,
            signature: {
              id: form.getAttribute('id') || '',
              name: form.getAttribute('name') || '',
              action: form.getAttribute('action') || ''
            },
            affordances,
            constraintCheck: {
              ran: checkFailed === null,
              error: checkFailed,
              formValid,
              fields: fieldStates,
              // Something listening for `invalid` rendered a message.
              messagingChanged: before !== after,
              ariaInvalidAfter: fields
                .filter((el) => el.getAttribute('aria-invalid') === 'true')
                .map((el) => nameOf(el))
            }
          };
        });
      },
      FIELD_SELECTOR,
      {
        maxForms: limits.maxForms,
        maxFields: limits.maxFields,
        maxRegions: limits.maxRegions,
        maxTextLength: limits.maxTextLength
      }
    );

    const probed = Array.isArray(result) ? result : [];
    logger.log?.(
      `   🧪 [PROBE] Checked constraints on ${probed.length} form${probed.length === 1 ? '' : 's'} (not submitted)`
    );

    return probed;
  } catch (error) {
    logger.warn?.(`⚠️  [PROBE] Behaviour probe skipped: ${error.message}`);

    return [];
  }
}

/**
 * Renders a probe result as the prompt section the model reads.
 *
 * Pure, so the wording is testable without a browser. Returns an empty string
 * when there is nothing worth saying, so an unprobed form's prompt looks
 * exactly as it did before.
 */
export function summariseBehaviour(behaviour) {
  if (!behaviour) {
    return '';
  }

  const lines = [];
  const { affordances = {}, constraintCheck = {} } = behaviour;

  const declared = (affordances.fields ?? []).filter(
    (field) => Object.keys(field.constraints ?? {}).length > 0
  );

  if (declared.length) {
    lines.push(
      'Constraints declared in the markup:',
      ...declared.map((field) => {
        const parts = Object.entries(field.constraints).map(([key, value]) =>
          value === true ? key : `${key}=${value}`
        );

        return `  - ${field.field || '(unnamed)'}: ${parts.join(', ')}`;
      })
    );
  }

  if (affordances.noValidate) {
    lines.push(
      'The form sets novalidate, so the browser will NOT enforce those constraints on submit.'
    );
  }

  const regions = affordances.liveRegions ?? [];
  if (regions.length) {
    lines.push(
      'Regions that can announce an error:',
      ...regions.map((region) => {
        const bits = [
          region.id ? `#${region.id}` : '(no id)',
          `role=${region.role}`,
          region.ariaLive ? `aria-live=${region.ariaLive}` : null,
          region.emptyAtRest ? 'empty while the form is untouched' : `currently: "${region.text}"`
        ].filter(Boolean);

        return `  - ${bits.join(', ')}`;
      })
    );
  }

  const described = (affordances.fields ?? []).filter((field) => field.describedBy?.length);
  if (described.length) {
    lines.push(
      'Fields wired to describing text:',
      ...described.map((field) => {
        const targets = field.describedBy
          .map((target) => `#${target.id}${target.empty ? ' (empty until needed)' : ''}`)
          .join(', ');

        return `  - ${field.field || '(unnamed)'} -> ${targets}`;
      })
    );
  }

  if (constraintCheck.ran) {
    const failing = (constraintCheck.fields ?? []).filter((field) => field.failures?.length);

    lines.push(
      `Constraint check on the empty form (checkValidity, nothing submitted): form reports ${
        constraintCheck.formValid ? 'VALID' : 'INVALID'
      }.`
    );

    if (failing.length) {
      lines.push(
        ...failing.map(
          (field) =>
            `  - ${field.field || '(unnamed)'} fails ${field.failures.join(', ')}` +
            (field.message ? ` -- browser would say: "${field.message}"` : '')
        )
      );
    }

    const unvalidated = (constraintCheck.fields ?? []).filter((field) => !field.willValidate);
    if (unvalidated.length) {
      lines.push(
        `  - not subject to validation at all: ${unvalidated
          .map((field) => field.field || '(unnamed)')
          .join(', ')}`
      );
    }

    lines.push(
      constraintCheck.messagingChanged
        ? 'Something rendered a message in response to the failed check, so error output is wired up.'
        : 'Nothing rendered a message in response to the failed check. This does NOT mean there is no error handling: a form that only validates on submit cannot be observed without submitting it, which was not done.'
    );

    if (constraintCheck.ariaInvalidAfter?.length) {
      lines.push(
        `Marked aria-invalid after the check: ${constraintCheck.ariaInvalidAfter.join(', ')}`
      );
    }
  }

  if (!lines.length) {
    return '';
  }

  return [
    'OBSERVED ON THE LIVE PAGE (the form was NOT submitted -- see the rules about unverified findings):',
    ...lines
  ].join('\n');
}

/** Pairs probe results with forms by document order, tolerating a short list. */
export function attachBehaviourToForms(forms, probed) {
  if (!Array.isArray(forms) || !Array.isArray(probed) || probed.length === 0) {
    return forms;
  }

  return forms.map((form, index) => {
    const behaviour = probed[index];

    return behaviour ? { ...form, behaviour } : form;
  });
}
