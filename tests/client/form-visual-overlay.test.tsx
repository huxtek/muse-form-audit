import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { FormVisualOverlay } from '@/components/FormVisualOverlay';
import type { AnalyzedForm } from '@/lib/scan-types';

/**
 * This component turns captured geometry into highlights drawn over a
 * screenshot, so a mistake here points at the wrong control and looks
 * authoritative while doing it. Nothing else in the stack can catch that.
 *
 * jsdom never loads images, so every test that needs highlights fires the
 * image's load event explicitly -- the component deliberately withholds
 * highlights until the screenshot is decoded, otherwise they flash in the
 * wrong place for a frame.
 */

const CAPTURE = { width: 1000, height: 500 };

const visualField = (name: string, rect: { x: number; y: number; width: number; height: number }) => ({
  name,
  id: '',
  type: 'text',
  tagName: 'input',
  value: '',
  rect,
  renderable: true
});

const buildForm = (overrides: Partial<AnalyzedForm> = {}): AnalyzedForm => ({
  formId: 'form-0',
  visual: {
    visualIndex: 0,
    width: CAPTURE.width,
    height: CAPTURE.height,
    hasScreenshot: true,
    fields: [
      visualField('custname', { x: 100, y: 50, width: 200, height: 25 }),
      visualField('custtel', { x: 100, y: 150, width: 200, height: 25 })
    ]
  },
  accessibility: {
    score: 69,
    fieldIssues: [{ field: 'custname', severity: 'high', issue: 'No id attribute' }]
  },
  ...overrides
});

/**
 * jsdom never decodes images, so natural dimensions have to be stubbed before
 * the load event. Defaults to the captured size, which is the happy path.
 */
const loadImage = (natural: { width: number; height: number } = CAPTURE) => {
  const img = screen.getByAltText(/screenshot of form/i);
  Object.defineProperty(img, 'naturalWidth', { value: natural.width, configurable: true });
  Object.defineProperty(img, 'naturalHeight', { value: natural.height, configurable: true });
  fireEvent.load(img);
};

const highlights = () => screen.queryAllByRole('button', { name: /finding/i });

describe('FormVisualOverlay screenshot', () => {
  it('requests the screenshot for the right job and form index', () => {
    render(<FormVisualOverlay form={buildForm()} jobId="job-abc" />);

    const img = screen.getByAltText(/screenshot of form/i);
    expect(img.getAttribute('src')).toContain('/api/screenshot/job-abc/0');
  });

  it('reserves the captured aspect ratio before the image decodes', () => {
    render(<FormVisualOverlay form={buildForm()} jobId="job-abc" />);

    // Stops the highlights landing in the wrong place for a frame.
    expect(screen.getByAltText(/screenshot of form/i)).toHaveStyle({
      aspectRatio: '1000 / 500'
    });
  });

  it('withholds highlights until the image has loaded', () => {
    render(<FormVisualOverlay form={buildForm()} jobId="job-abc" />);

    expect(highlights()).toHaveLength(0);

    loadImage();

    expect(highlights()).toHaveLength(1);
  });

  it('explains itself when the image fails to load', () => {
    render(<FormVisualOverlay form={buildForm()} jobId="job-abc" />);

    fireEvent.error(screen.getByAltText(/screenshot of form/i));

    expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument();
    expect(highlights()).toHaveLength(0);
  });

  it('shows an explanation and no image when nothing was captured', () => {
    const form = buildForm({
      visual: {
        visualIndex: 0,
        width: 0,
        height: 0,
        hasScreenshot: false,
        fields: [],
        unavailableReason: 'form is hidden or has no size'
      }
    });

    render(<FormVisualOverlay form={form} jobId="job-abc" />);

    expect(screen.getByText(/no screenshot for this form/i)).toBeInTheDocument();
    expect(screen.getByText(/form is hidden or has no size/i)).toBeInTheDocument();
    expect(screen.queryByAltText(/screenshot of form/i)).not.toBeInTheDocument();
  });

  it('shows an explanation when the form carries no geometry at all', () => {
    render(<FormVisualOverlay form={buildForm({ visual: undefined })} jobId="job-abc" />);

    expect(screen.getByText(/no screenshot for this form/i)).toBeInTheDocument();
  });
});

describe('FormVisualOverlay highlight geometry', () => {
  it('positions a highlight as a percentage of the captured size', () => {
    render(<FormVisualOverlay form={buildForm()} jobId="job-abc" />);
    loadImage();

    // Percentages, not pixels, so the boxes stay aligned when the image is
    // rendered smaller than it was captured.
    expect(highlights()[0]).toHaveStyle({
      left: '10%', // 100 / 1000
      top: '10%', // 50 / 500
      width: '20%', // 200 / 1000
      height: '5%' // 25 / 500
    });
  });

  it('measures against the decoded image, not the reported size', () => {
    render(<FormVisualOverlay form={buildForm()} jobId="job-abc" />);

    // The server said 1000x500; the real image is half that. Positions must
    // follow the image on screen, otherwise a clamped or changed capture
    // silently shifts every highlight.
    loadImage({ width: 500, height: 250 });

    expect(highlights()[0]).toHaveStyle({
      left: '20%', // 100 / 500
      top: '20%', // 50 / 250
      width: '40%', // 200 / 500
      height: '10%' // 25 / 250
    });
  });

  it('falls back to the reported size when the image reports none', () => {
    render(<FormVisualOverlay form={buildForm()} jobId="job-abc" />);

    loadImage({ width: 0, height: 0 });

    expect(highlights()[0]).toHaveStyle({ left: '10%', top: '10%' });
  });

  it('only highlights controls that actually have findings', () => {
    render(<FormVisualOverlay form={buildForm()} jobId="job-abc" />);
    loadImage();

    // custtel has no finding, so it gets no box.
    expect(highlights()).toHaveLength(1);
    expect(highlights()[0]).toHaveAccessibleName(/custname/);
  });

  it('matches a finding to a control case-insensitively', () => {
    const form = buildForm({
      accessibility: {
        fieldIssues: [{ field: 'CUSTNAME', severity: 'low', issue: 'Case differs' }]
      }
    });

    render(<FormVisualOverlay form={form} jobId="job-abc" />);
    loadImage();

    expect(highlights()).toHaveLength(1);
  });

  it('matches on id when the control has no name', () => {
    const form = buildForm({
      visual: {
        visualIndex: 0,
        ...CAPTURE,
        hasScreenshot: true,
        fields: [
          {
            ...visualField('', { x: 0, y: 0, width: 10, height: 10 }),
            id: 'email-field'
          }
        ]
      },
      accessibility: {
        fieldIssues: [{ field: 'email-field', severity: 'medium', issue: 'No label' }]
      }
    });

    render(<FormVisualOverlay form={form} jobId="job-abc" />);
    loadImage();

    expect(highlights()).toHaveLength(1);
  });

  it('draws one box for a radio group that shares a name', () => {
    const form = buildForm({
      visual: {
        visualIndex: 0,
        ...CAPTURE,
        hasScreenshot: true,
        fields: [
          visualField('size', { x: 10, y: 10, width: 13, height: 13 }),
          visualField('size', { x: 10, y: 40, width: 13, height: 13 }),
          visualField('size', { x: 10, y: 70, width: 13, height: 13 })
        ]
      },
      accessibility: {
        fieldIssues: [{ field: 'size', severity: 'low', issue: 'Radios share a name' }]
      }
    });

    render(<FormVisualOverlay form={form} jobId="job-abc" />);
    loadImage();

    // One finding must not paint three boxes.
    expect(highlights()).toHaveLength(1);
    expect(highlights()[0]).toHaveStyle({ top: '2%' });
  });

  it('counts the findings on each control', () => {
    const form = buildForm({
      accessibility: {
        fieldIssues: [
          { field: 'custname', severity: 'low', issue: 'One' },
          { field: 'custname', severity: 'high', issue: 'Two' }
        ]
      }
    });

    render(<FormVisualOverlay form={form} jobId="job-abc" />);
    loadImage();

    expect(highlights()).toHaveLength(1);
    expect(highlights()[0]).toHaveAccessibleName(/2 findings on custname/);
  });
});

describe('FormVisualOverlay severity', () => {
  const withSeverities = (severities: Array<'high' | 'medium' | 'low'>) =>
    buildForm({
      accessibility: {
        fieldIssues: severities.map((severity, index) => ({
          field: 'custname',
          severity,
          issue: `Issue ${index}`
        }))
      }
    });

  it('colours a control by its worst finding', () => {
    render(<FormVisualOverlay form={withSeverities(['low', 'high', 'medium'])} jobId="job-abc" />);
    loadImage();

    // The destructive treatment belongs to `high`, which must win.
    const box = highlights()[0].querySelector('div');
    expect(box?.className).toContain('border-destructive');
  });

  it('uses the medium treatment when there is no high finding', () => {
    render(<FormVisualOverlay form={withSeverities(['low', 'medium'])} jobId="job-abc" />);
    loadImage();

    const box = highlights()[0].querySelector('div');
    expect(box?.className).toContain('border-amber-500');
  });
});

describe('FormVisualOverlay tooltips', () => {
  it('reveals the finding on hover and hides it again', () => {
    render(<FormVisualOverlay form={buildForm()} jobId="job-abc" />);
    loadImage();

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    fireEvent.mouseEnter(highlights()[0]);

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent('custname');
    expect(tooltip).toHaveTextContent('No id attribute');

    fireEvent.mouseLeave(highlights()[0]);

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('reveals the finding on keyboard focus, so it is not mouse-only', () => {
    render(<FormVisualOverlay form={buildForm()} jobId="job-abc" />);
    loadImage();

    fireEvent.focus(highlights()[0]);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    fireEvent.blur(highlights()[0]);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('lists every finding for a control in one tooltip', () => {
    const form = buildForm({
      accessibility: {
        fieldIssues: [
          { field: 'custname', severity: 'high', issue: 'Missing id' },
          { field: 'custname', severity: 'low', issue: 'Missing autocomplete' }
        ]
      }
    });

    render(<FormVisualOverlay form={form} jobId="job-abc" />);
    loadImage();
    fireEvent.mouseEnter(highlights()[0]);

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent('Missing id');
    expect(tooltip).toHaveTextContent('Missing autocomplete');
  });

  it('keeps each highlight focusable', () => {
    render(<FormVisualOverlay form={buildForm()} jobId="job-abc" />);
    loadImage();

    expect(highlights()[0]).toHaveAttribute('tabIndex', '0');
  });
});

describe('FormVisualOverlay legend and footnotes', () => {
  it('reports findings that could not be placed on the image', () => {
    const form = buildForm({
      accessibility: {
        fieldIssues: [
          { field: 'custname', severity: 'high', issue: 'Placed' },
          { field: 'ghostField', severity: 'high', issue: 'Not in the capture' }
        ]
      }
    });

    render(<FormVisualOverlay form={form} jobId="job-abc" />);
    loadImage();

    // Silently dropping a finding would hide a real problem from the user.
    expect(screen.getByText(/could not be placed on the image/i)).toBeInTheDocument();
    expect(screen.getByText(/ghostField/)).toBeInTheDocument();
    expect(highlights()).toHaveLength(1);
  });

  it('says so when a form has no field-level findings', () => {
    render(
      <FormVisualOverlay
        form={buildForm({ accessibility: { score: 95, fieldIssues: [] } })}
        jobId="job-abc"
      />
    );

    expect(screen.getByText(/no field-level issues/i)).toBeInTheDocument();
  });

  it('shows severity totals by default', () => {
    render(<FormVisualOverlay form={buildForm()} jobId="job-abc" />);

    expect(screen.getByText(/1 high/)).toBeInTheDocument();
  });

  it('suppresses severity totals when the page already shows them', () => {
    render(<FormVisualOverlay form={buildForm()} jobId="job-abc" showSeverityCounts={false} />);

    expect(screen.queryByText(/1 high/)).not.toBeInTheDocument();
  });

  it('marks the bundled Dev Mode wireframe as a sample', () => {
    const form = buildForm();
    form.visual!.isSample = true;

    render(<FormVisualOverlay form={form} jobId="job-abc" />);

    expect(screen.getByText(/sample image/i)).toBeInTheDocument();
  });

  it('mentions cropping when the capture hit its size limit', () => {
    const form = buildForm();
    form.visual!.truncated = true;

    render(<FormVisualOverlay form={form} jobId="job-abc" />);

    expect(screen.getByText(/cropped/i)).toBeInTheDocument();
  });
});

describe('FormVisualOverlay tooltip overflow', () => {
  /** Five findings on one control, deliberately not in severity order. */
  const crowdedForm = () =>
    buildForm({
      accessibility: {
        fieldIssues: [
          { field: 'custname', severity: 'medium', issue: 'Medium one' },
          { field: 'custname', severity: 'low', issue: 'Low one' },
          { field: 'custname', severity: 'high', issue: 'The high one' },
          { field: 'custname', severity: 'low', issue: 'Low two' },
          { field: 'custname', severity: 'medium', issue: 'Medium two' }
        ]
      }
    });

  const openTooltip = () => {
    const highlight = screen.getAllByRole('button', { name: /finding.*custname/i })[0];
    fireEvent.mouseEnter(highlight);
  };

  it('shows at most three findings in the tooltip', () => {
    // A control with six findings would make the tooltip taller than the
    // capture it floats over, which is the clipping this had to be fixed for.
    render(<FormVisualOverlay form={crowdedForm()} jobId="job-1" />);
    loadImage();
    openTooltip();

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.querySelectorAll('li')).toHaveLength(3);
  });

  it('shows the worst findings, not the first three given', () => {
    // The box is painted for the worst severity, so hiding the high finding
    // behind "+2 more" would contradict the colour the user is looking at.
    render(<FormVisualOverlay form={crowdedForm()} jobId="job-1" />);
    loadImage();
    openTooltip();

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent('The high one');
    // Both lows are the ones that drop off.
    expect(tooltip).not.toHaveTextContent('Low one');
    expect(tooltip).not.toHaveTextContent('Low two');
  });

  it('keeps the model ordering within a severity', () => {
    render(<FormVisualOverlay form={crowdedForm()} jobId="job-1" />);
    loadImage();
    openTooltip();

    const shown = [...screen.getByRole('tooltip').querySelectorAll('li')].map(
      (li) => li.textContent
    );

    expect(shown[0]).toContain('The high one');
    expect(shown[1]).toContain('Medium one');
    expect(shown[2]).toContain('Medium two');
  });

  it('says how many are left and where to read them', () => {
    render(<FormVisualOverlay form={crowdedForm()} jobId="job-1" />);
    loadImage();
    openTooltip();

    expect(screen.getByRole('tooltip')).toHaveTextContent(
      '+2 more in the findings list below'
    );
  });

  it('adds no overflow line when everything fits', () => {
    const form = buildForm({
      accessibility: {
        fieldIssues: [
          { field: 'custname', severity: 'high', issue: 'One' },
          { field: 'custname', severity: 'low', issue: 'Two' }
        ]
      }
    });

    render(<FormVisualOverlay form={form} jobId="job-1" />);
    loadImage();
    openTooltip();

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.querySelectorAll('li')).toHaveLength(2);
    expect(tooltip).not.toHaveTextContent(/more in the findings list/i);
  });

  it('counts every finding on the badge, not one per control', () => {
    // The badge used to read 1 on every control because the model packed
    // each control's problems into a single entry.
    render(<FormVisualOverlay form={crowdedForm()} jobId="job-1" />);
    loadImage();

    const highlight = screen.getAllByRole('button', { name: /finding.*custname/i })[0];
    expect(highlight).toHaveTextContent('5');
  });
});

/**
 * A form that is not rendered is not a capture failure.
 *
 * amazon.com's `ap_navbar_form` is its sign-in form, hidden with
 * `display:none` until the account menu opens, and `ue_backdetect` is a
 * utility form with `visibility:hidden` that is never meant to be seen. Both
 * are real forms worth scoring and neither can be photographed. "No
 * screenshot for this form / Capture skipped" read as a fault on our side.
 */
const hiddenForm = (concealment?: { reason: string; at: string }): AnalyzedForm =>
  buildForm({
    formId: 'ap_navbar_form',
    visual: {
      visualIndex: 0,
      width: 0,
      height: 0,
      hasScreenshot: false,
      fields: [],
      notRendered: true,
      ...(concealment ? { concealment } : {}),
      unavailableReason: concealment
        ? `not rendered on the page as loaded (${concealment.reason} on ${concealment.at})`
        : 'not rendered on the page as loaded'
    }
  });

describe('FormVisualOverlay on a form that is not rendered', () => {
  it('says the form is not shown rather than blaming the capture', () => {
    render(<FormVisualOverlay form={hiddenForm()} jobId="job-abc" />);

    expect(screen.getByText(/this form is not shown on the page/i)).toBeInTheDocument();
    expect(screen.queryByText(/no screenshot for this form/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/capture skipped/i)).not.toBeInTheDocument();
  });

  it('names the mechanism that hides it', () => {
    render(
      <FormVisualOverlay
        form={hiddenForm({ reason: 'display:none', at: 'an ancestor <div>' })}
        jobId="job-abc"
      />
    );

    expect(screen.getByText(/display:none on an ancestor <div>/i)).toBeInTheDocument();
  });

  it('says the form is still scored, so a low score is read in context', () => {
    render(<FormVisualOverlay form={hiddenForm()} jobId="job-abc" />);

    expect(screen.getByText(/still scored/i)).toBeInTheDocument();
  });

  it('shows no image and no highlights', () => {
    render(<FormVisualOverlay form={hiddenForm()} jobId="job-abc" />);

    expect(screen.queryByAltText(/screenshot of form/i)).not.toBeInTheDocument();
    expect(highlights()).toHaveLength(0);
  });

  it('still points at the written findings', () => {
    render(<FormVisualOverlay form={hiddenForm()} jobId="job-abc" />);

    expect(screen.getByText(/details tab/i)).toBeInTheDocument();
  });
});
