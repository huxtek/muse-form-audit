import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { PageMapView } from '@/components/PageMapView';
import type { AnalyzedForm } from '@/lib/scan-types';

/**
 * The page map turns each form's page-coordinate rectangle into a clickable
 * region. A mistake puts the region over the wrong part of the page, or makes
 * a form unreachable, and the UI gives no hint that anything is wrong.
 *
 * Regions are measured against the DECODED image, so tests stub natural
 * dimensions before firing load -- jsdom never decodes images.
 */

const PAGE = { width: 1000, height: 2000 };

const formOnPage = (
  index: number,
  pageIndex: number,
  rect: { x: number; y: number; width: number; height: number },
  severity: 'high' | 'medium' | 'low' = 'medium'
): AnalyzedForm => ({
  formId: `form-${index}`,
  visual: {
    visualIndex: index,
    width: rect.width,
    height: rect.height,
    hasScreenshot: true,
    fields: [],
    pageRect: rect,
    pageMap: { pageIndex, width: PAGE.width, height: PAGE.height }
  },
  accessibility: {
    fieldIssues: [{ field: 'a', severity, issue: 'something' }]
  }
});

const loadMap = (natural: { width: number; height: number } = PAGE) => {
  const img = screen.getByAltText(/scanned page/i);
  Object.defineProperty(img, 'naturalWidth', { value: natural.width, configurable: true });
  Object.defineProperty(img, 'naturalHeight', { value: natural.height, configurable: true });
  fireEvent.load(img);
};

const regions = () => screen.queryAllByRole('button', { name: /^Form \d+/ });

describe('PageMapView', () => {
  it('requests the map for the selected form\'s page', () => {
    const forms = [formOnPage(0, 0, { x: 0, y: 0, width: 100, height: 100 })];

    render(<PageMapView forms={forms} jobId="job-1" selectedIndex={0} onSelect={() => {}} />);

    expect(screen.getByAltText(/scanned page/i).getAttribute('src')).toContain(
      '/api/page-map/job-1/0'
    );
  });

  it('renders nothing when no form has a page map', () => {
    const form: AnalyzedForm = {
      formId: 'form-0',
      visual: { visualIndex: 0, width: 10, height: 10, hasScreenshot: true, fields: [] }
    };

    const { container } = render(
      <PageMapView forms={[form]} jobId="job-1" selectedIndex={0} onSelect={() => {}} />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('withholds regions until the map has decoded', () => {
    const forms = [formOnPage(0, 0, { x: 100, y: 200, width: 500, height: 400 })];

    render(<PageMapView forms={forms} jobId="job-1" selectedIndex={0} onSelect={() => {}} />);
    expect(regions()).toHaveLength(0);

    loadMap();
    expect(regions()).toHaveLength(1);
  });

  it('positions a region as a percentage of the decoded map', () => {
    const forms = [formOnPage(0, 0, { x: 100, y: 200, width: 500, height: 400 })];

    render(<PageMapView forms={forms} jobId="job-1" selectedIndex={0} onSelect={() => {}} />);
    loadMap();

    expect(regions()[0]).toHaveStyle({
      left: '10%', // 100 / 1000
      top: '10%', // 200 / 2000
      width: '50%', // 500 / 1000
      height: '20%' // 400 / 2000
    });
  });

  it('measures against the decoded size, not the reported size', () => {
    const forms = [formOnPage(0, 0, { x: 100, y: 200, width: 500, height: 400 })];

    render(<PageMapView forms={forms} jobId="job-1" selectedIndex={0} onSelect={() => {}} />);
    // Half-size image: the regions must follow the pixels on screen.
    loadMap({ width: 500, height: 1000 });

    expect(regions()[0]).toHaveStyle({ left: '20%', top: '20%' });
  });

  it('only outlines forms that live on the page being shown', () => {
    const forms = [
      formOnPage(0, 0, { x: 0, y: 0, width: 100, height: 100 }),
      formOnPage(1, 0, { x: 0, y: 200, width: 100, height: 100 }),
      formOnPage(2, 1, { x: 0, y: 0, width: 100, height: 100 })
    ];

    render(<PageMapView forms={forms} jobId="job-1" selectedIndex={0} onSelect={() => {}} />);
    loadMap();

    // Form 3 is on page 1, so it must not appear on page 0's map.
    expect(regions()).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /^Form 3/ })).not.toBeInTheDocument();
  });

  it('follows the selection to another page', () => {
    const forms = [
      formOnPage(0, 0, { x: 0, y: 0, width: 100, height: 100 }),
      formOnPage(1, 1, { x: 0, y: 0, width: 100, height: 100 })
    ];

    render(<PageMapView forms={forms} jobId="job-1" selectedIndex={1} onSelect={() => {}} />);

    expect(screen.getByAltText(/scanned page/i).getAttribute('src')).toContain(
      '/api/page-map/job-1/1'
    );
    loadMap();
    expect(regions()).toHaveLength(1);
    expect(regions()[0]).toHaveAccessibleName(/^Form 2/);
  });

  it('marks the selected region as pressed', () => {
    const forms = [
      formOnPage(0, 0, { x: 0, y: 0, width: 100, height: 100 }),
      formOnPage(1, 0, { x: 0, y: 200, width: 100, height: 100 })
    ];

    render(<PageMapView forms={forms} jobId="job-1" selectedIndex={1} onSelect={() => {}} />);
    loadMap();

    expect(regions()[0]).toHaveAttribute('aria-pressed', 'false');
    expect(regions()[1]).toHaveAttribute('aria-pressed', 'true');
  });

  it('reports the chosen form index', () => {
    const onSelect = vi.fn();
    const forms = [
      formOnPage(0, 0, { x: 0, y: 0, width: 100, height: 100 }),
      formOnPage(1, 0, { x: 0, y: 200, width: 100, height: 100 })
    ];

    render(<PageMapView forms={forms} jobId="job-1" selectedIndex={0} onSelect={onSelect} />);
    loadMap();
    fireEvent.click(regions()[1]);

    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it('labels a region with its finding count', () => {
    const forms = [formOnPage(0, 0, { x: 0, y: 0, width: 100, height: 100 })];

    render(<PageMapView forms={forms} jobId="job-1" selectedIndex={0} onSelect={() => {}} />);
    loadMap();

    expect(regions()[0]).toHaveAccessibleName('Form 1, 1 finding');
  });

  it('colours a region by its worst finding', () => {
    const forms = [
      {
        ...formOnPage(0, 0, { x: 0, y: 0, width: 100, height: 100 }),
        accessibility: {
          fieldIssues: [
            { field: 'a', severity: 'low' as const, issue: 'x' },
            { field: 'b', severity: 'high' as const, issue: 'y' }
          ]
        }
      }
    ];

    render(<PageMapView forms={forms} jobId="job-1" selectedIndex={0} onSelect={() => {}} />);
    loadMap();

    expect(regions()[0].querySelector('span')?.className).toContain('border-destructive');
  });

  it('skips a form with no page rectangle rather than guessing one', () => {
    const withRect = formOnPage(0, 0, { x: 0, y: 0, width: 100, height: 100 });
    const withoutRect = formOnPage(1, 0, { x: 0, y: 0, width: 100, height: 100 });
    delete withoutRect.visual!.pageRect;

    render(
      <PageMapView forms={[withRect, withoutRect]} jobId="job-1" selectedIndex={0} onSelect={() => {}} />
    );
    loadMap();

    expect(regions()).toHaveLength(1);
  });

  it('explains itself when the map fails to load', () => {
    const forms = [formOnPage(0, 0, { x: 0, y: 0, width: 100, height: 100 })];

    render(<PageMapView forms={forms} jobId="job-1" selectedIndex={0} onSelect={() => {}} />);
    fireEvent.error(screen.getByAltText(/scanned page/i));

    expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument();
    // The crops below are independent, and the copy should say so.
    expect(screen.getByText(/unaffected/i)).toBeInTheDocument();
    expect(regions()).toHaveLength(0);
  });

  it('notes when a long page was cropped for the map', () => {
    const forms = [formOnPage(0, 0, { x: 0, y: 0, width: 100, height: 100 })];
    forms[0].visual!.pageMap!.truncated = true;

    render(<PageMapView forms={forms} jobId="job-1" selectedIndex={0} onSelect={() => {}} />);

    expect(screen.getByText(/map cropped/i)).toBeInTheDocument();
  });
});
