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

    // Inline, choosing a region should also take the user to the findings:
    // changing something below the fold reads as nothing having happened.
    expect(onSelect).toHaveBeenCalledWith(1, { reveal: true });
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

describe('PageMapView sizing', () => {
  it('fits the container width rather than capping the height', () => {
    // Capping the height is what rendered a 1280x4393 page about 134px
    // across: too small to read and too small to aim at.
    const forms = [formOnPage(0, 0, { x: 0, y: 0, width: 100, height: 100 })];

    render(<PageMapView forms={forms} jobId="job-1" selectedIndex={0} onSelect={() => {}} />);

    const img = screen.getByAltText(/scanned page/i);
    expect(img.className).toContain('w-full');
    expect(img.className).not.toMatch(/max-h-/);
  });

  it('names the selected form in the header, so selection is visible', () => {
    const forms = [
      formOnPage(0, 0, { x: 0, y: 0, width: 100, height: 100 }),
      formOnPage(1, 0, { x: 0, y: 200, width: 100, height: 100 })
    ];

    render(<PageMapView forms={forms} jobId="job-1" selectedIndex={1} onSelect={() => {}} />);

    expect(screen.getByText(/showing/i)).toHaveTextContent('Form 2');
  });
});

describe('PageMapView expanded view', () => {
  const twoForms = () => [
    formOnPage(0, 0, { x: 0, y: 0, width: 100, height: 100 }),
    formOnPage(1, 0, { x: 0, y: 200, width: 100, height: 100 })
  ];

  const expand = () => fireEvent.click(screen.getByRole('button', { name: /expand page/i }));

  /** Both maps are mounted once expanded, so load every one of them. */
  const loadAllMaps = () => {
    for (const img of screen.getAllByAltText(/scanned page/i)) {
      Object.defineProperty(img, 'naturalWidth', { value: PAGE.width, configurable: true });
      Object.defineProperty(img, 'naturalHeight', { value: PAGE.height, configurable: true });
      fireEvent.load(img);
    }
  };

  it('opens when the image itself is clicked', () => {
    // Clicking a small screenshot is most people's first instinct; doing
    // nothing is what made it feel broken.
    render(
      <PageMapView forms={twoForms()} jobId="job-1" selectedIndex={0} onSelect={() => {}} />
    );
    fireEvent.click(screen.getByAltText(/scanned page/i));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('opens from the explicit button, for anyone who does not guess', () => {
    render(
      <PageMapView forms={twoForms()} jobId="job-1" selectedIndex={0} onSelect={() => {}} />
    );
    expand();

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('closes and reveals the form when a region is chosen', () => {
    const onSelect = vi.fn();
    render(
      <PageMapView forms={twoForms()} jobId="job-1" selectedIndex={0} onSelect={onSelect} />
    );
    expand();
    loadAllMaps();

    // Two maps are mounted once expanded; the dialog's regions come last.
    const inDialog = regions().slice(-2);
    fireEvent.click(inDialog[1]);

    // Selecting in place and leaving the dialog up was tried first, and it
    // put the click's payoff behind the dialog -- which is the very "nothing
    // happened" feeling this view exists to fix.
    expect(onSelect).toHaveBeenCalledWith(1, { reveal: true });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('leaves via an explicit action that reveals the findings', () => {
    const onSelect = vi.fn();
    render(
      <PageMapView forms={twoForms()} jobId="job-1" selectedIndex={1} onSelect={onSelect} />
    );
    expand();
    fireEvent.click(screen.getByRole('button', { name: /view findings/i }));

    expect(onSelect).toHaveBeenCalledWith(1, { reveal: true });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('changes nothing when dismissed without choosing a region', () => {
    const onSelect = vi.fn();
    render(
      <PageMapView forms={twoForms()} jobId="job-1" selectedIndex={0} onSelect={onSelect} />
    );
    expand();
    loadAllMaps();

    fireEvent.keyDown(document, { key: 'Escape' });

    // Looking closer and backing out is not a selection.
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('never scrolls the page from inside the map, only the map box', () => {
    // scrollIntoView moves every scrollable ancestor, which scrolled the page
    // around behind the expanded dialog: the user could see movement but not
    // what had moved.
    const forms = twoForms();
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;

    try {
      const { rerender } = render(
        <PageMapView forms={forms} jobId="job-1" selectedIndex={0} onSelect={() => {}} />
      );
      loadAllMaps();
      rerender(
        <PageMapView forms={forms} jobId="job-1" selectedIndex={1} onSelect={() => {}} />
      );

      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});

/**
 * A form with no size has no place on the page.
 *
 * united.com is the measured case. Its second form is a co-browse support
 * widget sitting behind `display:none` on an ancestor `<section>`, so its
 * page rect is 0x0 at (0,0). A region was built for it regardless, and the
 * "Form 2" badge inside that region is positioned absolutely -- so it
 * painted at the very top-left corner of the map, a small marker claiming a
 * form was there. Clicking it selected a form whose screenshot does not
 * exist, which read as a form with an empty picture.
 *
 * The form stays in the report with its findings and its "Not shown on
 * page" label. What it does not get is a position it never had.
 */
const unplacedForm = (index: number, pageIndex = 0): AnalyzedForm => ({
  formId: `form-${index}`,
  visual: {
    visualIndex: index,
    width: 0,
    height: 0,
    hasScreenshot: false,
    notRendered: true,
    fields: [],
    pageRect: { x: 0, y: 0, width: 0, height: 0 },
    pageMap: { pageIndex, width: PAGE.width, height: PAGE.height }
  },
  accessibility: { fieldIssues: [{ field: 'cobrowse.pin', severity: 'medium', issue: 'no name' }] }
});

describe('a form with no position on the page', () => {
  it('is not outlined on the map', () => {
    const forms = [formOnPage(0, 0, { x: 96, y: 225, width: 520, height: 428 }), unplacedForm(1)];

    render(<PageMapView forms={forms} jobId="job-1" selectedIndex={0} onSelect={() => {}} />);
    loadMap();

    expect(regions()).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /^Form 2/ })).not.toBeInTheDocument();
  });

  it('is counted as not shown rather than quietly dropped', () => {
    // The map says two forms were found but one is outlined, so it has to
    // account for the difference.
    const forms = [formOnPage(0, 0, { x: 96, y: 225, width: 520, height: 428 }), unplacedForm(1)];

    render(<PageMapView forms={forms} jobId="job-1" selectedIndex={0} onSelect={() => {}} />);
    loadMap();

    expect(screen.getByText(/1 form outlined, 1 not shown on the page/i)).toBeInTheDocument();
  });

  it('says nothing extra when every form has a position', () => {
    const forms = [
      formOnPage(0, 0, { x: 0, y: 0, width: 100, height: 100 }),
      formOnPage(1, 0, { x: 0, y: 300, width: 100, height: 100 })
    ];

    render(<PageMapView forms={forms} jobId="job-1" selectedIndex={0} onSelect={() => {}} />);
    loadMap();

    expect(screen.queryByText(/not shown on the page/i)).not.toBeInTheDocument();
    expect(regions()).toHaveLength(2);
  });

  it('still shows the map when the selected form is the unplaced one', () => {
    // Selecting it must not blank the map or crash: the other form's
    // outline stays, and the header still names what is selected.
    const forms = [formOnPage(0, 0, { x: 96, y: 225, width: 520, height: 428 }), unplacedForm(1)];

    render(<PageMapView forms={forms} jobId="job-1" selectedIndex={1} onSelect={() => {}} />);
    loadMap();

    expect(screen.getByAltText(/scanned page/i)).toBeInTheDocument();
    expect(regions()).toHaveLength(1);
    expect(screen.getByText(/Form 2/)).toBeInTheDocument();
  });

  it('outlines a small form that really is on the page', () => {
    // The guard is about having no size, not about being small. A 20px
    // control is a real location.
    const forms = [formOnPage(0, 0, { x: 40, y: 80, width: 20, height: 20 })];

    render(<PageMapView forms={forms} jobId="job-1" selectedIndex={0} onSelect={() => {}} />);
    loadMap();

    expect(regions()).toHaveLength(1);
  });
});
