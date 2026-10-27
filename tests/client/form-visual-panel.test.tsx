import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { FormVisualPanel } from '@/components/FormVisualPanel';
import type { AnalyzedForm } from '@/lib/scan-types';

/**
 * The panel owns the selection shared by the screenshot and the findings list.
 * These tests are about that wiring: the two sides must stay in step in both
 * directions, which neither child can guarantee alone.
 */

const CAPTURE = { width: 1000, height: 500 };

const field = (name: string, y: number) => ({
  name,
  id: '',
  type: 'text',
  tagName: 'input',
  value: '',
  rect: { x: 100, y, width: 200, height: 25 },
  renderable: true
});

const buildForm = (overrides: Partial<AnalyzedForm> = {}): AnalyzedForm => ({
  formId: 'form-0',
  visual: {
    visualIndex: 0,
    width: CAPTURE.width,
    height: CAPTURE.height,
    hasScreenshot: true,
    fields: [field('custname', 50), field('custtel', 150)]
  },
  accessibility: {
    score: 69,
    fieldIssues: [
      { field: 'custname', severity: 'high', issue: 'No id attribute' },
      { field: 'custtel', severity: 'low', issue: 'No pattern' }
    ]
  },
  ...overrides
});

/** jsdom never decodes images; the overlay withholds highlights until load. */
const loadImages = () => {
  for (const img of screen.getAllByAltText(/screenshot of form/i)) {
    Object.defineProperty(img, 'naturalWidth', { value: CAPTURE.width, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: CAPTURE.height, configurable: true });
    fireEvent.load(img);
  }
};

const highlightFor = (name: RegExp) =>
  screen.getAllByRole('button', { name }).find((el) => el.tagName === 'DIV')!;

const listEntryFor = (name: RegExp) =>
  screen.getAllByRole('button', { name }).find((el) => el.tagName === 'BUTTON')!;

const isLit = (highlight: HTMLElement) =>
  Boolean(highlight.querySelector('div')?.className.includes('ring-2'));

describe('FormVisualPanel two-way selection', () => {
  it('lights the matching highlight when a finding is hovered', () => {
    render(<FormVisualPanel form={buildForm()} jobId="job-1" />);
    loadImages();

    const highlight = highlightFor(/finding.*custname/i);
    expect(isLit(highlight)).toBe(false);

    fireEvent.mouseEnter(listEntryFor(/finding.*custname/i));

    expect(isLit(highlightFor(/finding.*custname/i))).toBe(true);
    // The other control must not light up with it.
    expect(isLit(highlightFor(/finding.*custtel/i))).toBe(false);
  });

  it('clears the highlight when the pointer leaves the finding', () => {
    render(<FormVisualPanel form={buildForm()} jobId="job-1" />);
    loadImages();

    const entry = listEntryFor(/finding.*custname/i);
    fireEvent.mouseEnter(entry);
    fireEvent.mouseLeave(entry);

    expect(isLit(highlightFor(/finding.*custname/i))).toBe(false);
  });

  it('pins from the list, and the screenshot reflects it', () => {
    render(<FormVisualPanel form={buildForm()} jobId="job-1" />);
    loadImages();

    fireEvent.click(listEntryFor(/finding.*custname/i));

    expect(highlightFor(/finding.*custname/i)).toHaveAttribute('aria-pressed', 'true');
    expect(listEntryFor(/finding.*custname/i)).toHaveAttribute('aria-pressed', 'true');
    // A pin survives the pointer leaving, which is the whole point.
    fireEvent.mouseLeave(listEntryFor(/finding.*custname/i));
    expect(isLit(highlightFor(/finding.*custname/i))).toBe(true);
  });

  it('pins from the screenshot, and the list reflects it', () => {
    render(<FormVisualPanel form={buildForm()} jobId="job-1" />);
    loadImages();

    fireEvent.click(highlightFor(/finding.*custtel/i));

    expect(listEntryFor(/finding.*custtel/i)).toHaveAttribute('aria-pressed', 'true');
    expect(listEntryFor(/finding.*custname/i)).toHaveAttribute('aria-pressed', 'false');
  });

  it('unpins when the same entry is clicked again', () => {
    render(<FormVisualPanel form={buildForm()} jobId="job-1" />);
    loadImages();

    const entry = () => listEntryFor(/finding.*custname/i);
    fireEvent.click(entry());
    expect(entry()).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(entry());
    expect(entry()).toHaveAttribute('aria-pressed', 'false');
  });

  it('moves the pin rather than accumulating pins', () => {
    render(<FormVisualPanel form={buildForm()} jobId="job-1" />);
    loadImages();

    fireEvent.click(listEntryFor(/finding.*custname/i));
    fireEvent.click(listEntryFor(/finding.*custtel/i));

    expect(listEntryFor(/finding.*custname/i)).toHaveAttribute('aria-pressed', 'false');
    expect(listEntryFor(/finding.*custtel/i)).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows a pinned finding tooltip on the screenshot', () => {
    render(<FormVisualPanel form={buildForm()} jobId="job-1" />);
    loadImages();

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    fireEvent.click(listEntryFor(/finding.*custname/i));

    expect(screen.getByRole('tooltip')).toHaveTextContent('No id attribute');
  });

  it('drops the pin when the caller keys a different form', () => {
    // Field names repeat across forms, so a pin must not survive a form
    // change. The reset is the caller's `key`, not an effect inside the
    // panel -- clearing state from an effect is the cascading-render pattern
    // React's lint rules reject.
    const { rerender } = render(
      <FormVisualPanel key="form-0" form={buildForm()} jobId="job-1" />
    );
    loadImages();

    fireEvent.click(listEntryFor(/finding.*custname/i));
    expect(listEntryFor(/finding.*custname/i)).toHaveAttribute('aria-pressed', 'true');

    const next = buildForm({ formId: 'form-1' });
    next.visual!.visualIndex = 1;
    rerender(<FormVisualPanel key="form-1" form={next} jobId="job-1" />);
    loadImages();

    expect(listEntryFor(/finding.*custname/i)).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('FormVisualPanel findings list', () => {
  it('groups several findings under one control', () => {
    const form = buildForm({
      accessibility: {
        fieldIssues: [
          { field: 'custname', severity: 'high', issue: 'First problem' },
          { field: 'custname', severity: 'low', issue: 'Second problem' }
        ]
      }
    });

    render(<FormVisualPanel form={form} jobId="job-1" />);

    expect(screen.getByText('First problem')).toBeInTheDocument();
    expect(screen.getByText('Second problem')).toBeInTheDocument();
    expect(screen.getByText(/Findings \(2\)/)).toBeInTheDocument();
  });

  it('keeps a finding whose control is missing from the screenshot and marks it', () => {
    const form = buildForm({
      accessibility: {
        fieldIssues: [
          { field: 'custname', severity: 'high', issue: 'Placed' },
          { field: 'ghostField', severity: 'high', issue: 'Not in the capture' }
        ]
      }
    });

    render(<FormVisualPanel form={form} jobId="job-1" />);

    // The model made this finding; it must not vanish because the capture
    // missed the control.
    expect(screen.getByText('Not in the capture')).toBeInTheDocument();
    expect(screen.getByText(/not on image/i)).toBeInTheDocument();
  });

  it('says so when there are no field-level findings', () => {
    render(
      <FormVisualPanel
        form={buildForm({ accessibility: { score: 95, fieldIssues: [] } })}
        jobId="job-1"
      />
    );

    expect(screen.getByText(/no field-level findings/i)).toBeInTheDocument();
  });
});

describe('FormVisualPanel enlarged view', () => {
  it('opens an enlarged screenshot on request', () => {
    render(<FormVisualPanel form={buildForm()} jobId="job-1" />);

    expect(screen.getAllByAltText(/screenshot of form/i)).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: /enlarge screenshot/i }));

    // The inline crop is small; the dialog is how the form text becomes
    // readable.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getAllByAltText(/screenshot of form/i)).toHaveLength(2);
  });

  it('offers no enlarge control when there is no screenshot', () => {
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

    render(<FormVisualPanel form={form} jobId="job-1" />);

    expect(screen.queryByRole('button', { name: /enlarge/i })).not.toBeInTheDocument();
  });
});
