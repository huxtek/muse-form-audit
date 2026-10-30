// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import FormAnalysisDisplay from '@/components/FormAnalysisDisplay';
import type { AnalyzedForm } from '@/lib/scan-types';

/**
 * A form can be real, scored, and not on the page.
 *
 * amazon.com returns three: the site search, `ue_backdetect` (a utility form
 * hidden with `visibility:hidden`), and `ap_navbar_form`, its sign-in form,
 * hidden with `display:none` until the account menu opens. The hidden two
 * scored 28 and 41 and sat in the report beside the search form's 81 with
 * nothing to say they are not visible -- so two low scores dragged down the
 * picture for forms nobody can see.
 *
 * They stay in the report, because an agent has to understand a sign-in form
 * whether or not a person can see it. They are labelled instead.
 */
const form = (overrides: Partial<AnalyzedForm> = {}): AnalyzedForm => ({
  formId: 'nav-search-bar-form',
  accessibility: { score: 81, fieldIssues: [] },
  ...overrides
});

const hidden = (): AnalyzedForm =>
  form({
    formId: 'ap_navbar_form',
    accessibility: { score: 28, fieldIssues: [] },
    visual: {
      visualIndex: 1,
      width: 0,
      height: 0,
      hasScreenshot: false,
      fields: [],
      notRendered: true,
      concealment: { reason: 'display:none', at: 'the form' },
      unavailableReason: 'not rendered on the page as loaded (display:none on the form)'
    }
  });

const cardFor = (formId: string) =>
  screen.getByText(`ID: ${formId}`).closest('div.overflow-hidden') as HTMLElement;

describe('a form that is not shown on the page', () => {
  it('is labelled, so its score is read in context', () => {
    render(<FormAnalysisDisplay forms={[hidden()]} />);

    expect(screen.getByText('Not shown on page')).toBeInTheDocument();
  });

  it('is still listed with its score rather than dropped', () => {
    // Excluding it would hide a sign-in form from a report about whether
    // agents can use the site's forms.
    render(<FormAnalysisDisplay forms={[hidden()]} />);

    expect(screen.getByText('ID: ap_navbar_form')).toBeInTheDocument();
    // All of them: the card shows the score in its header badge and again in
    // the breakdown below, and the overall score repeats the figure too.
    expect(within(cardFor('ap_navbar_form')).getAllByText('28/100').length).toBeGreaterThan(0);
  });

  it('labels only the forms that are not rendered', () => {
    render(<FormAnalysisDisplay forms={[form(), hidden()]} />);

    expect(within(cardFor('ap_navbar_form')).getByText('Not shown on page')).toBeInTheDocument();
    expect(
      within(cardFor('nav-search-bar-form')).queryByText('Not shown on page')
    ).not.toBeInTheDocument();
  });

  it('leaves a photographed form unlabelled', () => {
    const visible = form({
      visual: { visualIndex: 0, width: 800, height: 120, hasScreenshot: true, fields: [] }
    });

    render(<FormAnalysisDisplay forms={[visible]} />);

    expect(screen.queryByText('Not shown on page')).not.toBeInTheDocument();
  });

  it('leaves a form with no geometry at all unlabelled', () => {
    // Absent geometry means the capture never ran, which says nothing about
    // whether the form is on the page.
    render(<FormAnalysisDisplay forms={[form({ visual: undefined })]} />);

    expect(screen.queryByText('Not shown on page')).not.toBeInTheDocument();
  });
});
