import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { ImageOff, Maximize2 } from "lucide-react";
import { getPageMapUrl } from "@/lib/api-config";
import { SEVERITY_ORDER, SEVERITY_STYLES } from "@/defines/severities";
import type { AnalyzedForm, IssueSeverity } from "@/lib/scan-types";

/**
 * The scanned page as a whole, with every analysed form outlined and
 * clickable. Choosing a region selects that form and brings its annotated
 * crop into view.
 *
 * Sized to the container's WIDTH, inside a fixed-height scroll box. A page
 * screenshot is typically three or four times taller than it is wide, so
 * capping the height instead -- which is what this used to do -- rendered a
 * 1280x4393 page about 134px across: too small to read and too small to aim
 * at. Fitting the width and scrolling keeps the page legible without letting
 * it swallow the results.
 *
 * Regions are positioned as percentages of the DECODED image's dimensions
 * rather than the server-reported ones, for the same reason the form overlay
 * does: the browser cannot be wrong about the size of the image it just
 * rendered, so a clamped or re-plumbed capture can never shift the regions.
 */
export const PageMapView = ({ forms, jobId, selectedIndex, onSelect }: PageMapViewProps) => {
  const [imageState, setImageState] = useState<"loading" | "ready" | "error">("loading");
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [expandedOpen, setExpandedOpen] = useState(false);
  const lastKey = useRef<string>("");
  const scrollBox = useRef<HTMLDivElement | null>(null);
  const selectedRegion = useRef<HTMLButtonElement | null>(null);

  const selected = forms[selectedIndex];
  const pageMap = selected?.visual?.pageMap;
  const pageIndex = pageMap?.pageIndex ?? 0;

  useEffect(() => {
    const key = `${jobId}:${pageIndex}`;
    if (lastKey.current !== key) {
      lastKey.current = key;
      setImageState("loading");
      setNaturalSize(null);
    }
  }, [jobId, pageIndex]);

  // Keep the chosen form visible in the scroll box. Selection also arrives
  // from the numeric picker, so without this the map can silently be showing
  // a different part of the page than the panel below describes.
  //
  // Scrolls the box by setting scrollTop rather than calling scrollIntoView
  // on the region: scrollIntoView moves EVERY scrollable ancestor, including
  // the document, so it dragged the page sideways under the picker and --
  // worse -- scrolled the page around behind the expanded map, where the
  // user could see it move but not see what had moved.
  useEffect(() => {
    const box = scrollBox.current;
    const region = selectedRegion.current;

    if (imageState !== "ready" || !box || !region) {
      return;
    }

    const boxRect = box.getBoundingClientRect();
    const regionRect = region.getBoundingClientRect();
    const alreadyVisible = regionRect.top >= boxRect.top && regionRect.bottom <= boxRect.bottom;

    if (alreadyVisible) {
      return;
    }

    const offsetInContent = regionRect.top - boxRect.top + box.scrollTop;
    const centred = offsetInContent - (box.clientHeight - regionRect.height) / 2;
    const furthest = box.scrollHeight - box.clientHeight;

    box.scrollTo({
      top: Math.min(Math.max(centred, 0), Math.max(furthest, 0)),
      behavior: scrollBehavior()
    });
  }, [selectedIndex, imageState]);

  if (!pageMap) {
    return null;
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-foreground">Scanned page</span>
        <span className="text-xs text-muted-foreground">
          {regions().length} {regions().length === 1 ? "form" : "forms"} outlined
          {unplacedCount() > 0 && `, ${unplacedCount()} not shown on the page`} &mdash; showing{" "}
          <span className="text-foreground font-medium">Form {selectedIndex + 1}</span>
        </span>
        {pageMap.truncated && (
          <Badge variant="outline" className="text-xs">
            Long page &mdash; map cropped
          </Badge>
        )}
      </div>

      {imageState === "error" ? (
        <div className="flex items-start gap-3 p-4 rounded-lg border border-border/50 bg-muted/30">
          <ImageOff className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
          <p className="text-sm text-muted-foreground">
            The page map could not be loaded. The form screenshots below are unaffected.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="rounded-xl border border-border/60 bg-white p-2 shadow-lg shadow-black/20">
            {/* Fixed height with the page scrolling inside it. The scrollbar
                doubles as the hint that there is more page below. */}
            <div
              ref={scrollBox}
              className="relative max-h-[460px] overflow-y-auto overflow-x-hidden rounded-md"
            >
              {renderMap()}
            </div>
          </div>

          <Button variant="outline" size="sm" onClick={handleOpenExpanded}>
            <Maximize2 className="h-4 w-4 mr-2" />
            Expand page
          </Button>
        </div>
      )}

      <Dialog open={expandedOpen} onOpenChange={setExpandedOpen}>
        <DialogContent className="w-[95vw] max-w-[1800px] max-h-[92vh] flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Scanned page</DialogTitle>
            <DialogDescription>
              Click a form to close this view and jump to its findings.
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-auto rounded-md bg-white p-2">{renderMap(true)}</div>

          <DialogFooter className="sm:justify-between gap-2">
            <span className="text-sm text-muted-foreground self-center">
              Form {selectedIndex + 1} selected
            </span>

            {/* For someone who expanded the map to look, changed nothing, and
                wants to get back to the form they already had open. */}
            <Button size="sm" onClick={handleViewFindings}>
              View findings
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );

  /**
   * The map image with its regions. Rendered twice -- inline and expanded --
   * so a click lands on the same geometry in both.
   */
  function renderMap(expanded = false) {
    return (
      <div className="relative w-full">
        <img {...getImageProps(expanded)} />

        {imageState === "ready" && regions().map((region) => renderRegion(region, expanded))}
      </div>
    );
  }

  function renderRegion(region: Region, expanded: boolean) {
    const style = SEVERITY_STYLES[region.severity];
    const isSelected = region.index === selectedIndex;

    return (
      <button key={region.key} {...getRegionProps(region, expanded, isSelected)}>
        <span
          className={`absolute inset-0 rounded-sm border-2 transition-colors ${style.border} ${
            isSelected ? style.fill : "bg-transparent hover:bg-foreground/5"
          }`}
        />

        <span
          className={`absolute top-1 left-1 ${style.badge} text-[10px] font-semibold leading-none px-1.5 py-0.5 rounded shadow`}
        >
          Form {region.index + 1}
          {region.issueCount > 0 ? ` · ${region.issueCount}` : ""}
        </span>
      </button>
    );
  }

  function getImageProps(expanded: boolean) {
    return {
      src: getPageMapUrl(jobId, pageIndex),
      alt: "Screenshot of the scanned page",
      // Full container width, height whatever the page's ratio makes it. The
      // scroll box above bounds what is on screen.
      className: `block w-full h-auto ${expanded ? "" : "cursor-zoom-in"}`,
      style: { aspectRatio: `${pageMap?.width} / ${pageMap?.height}` },
      // Clicking the image is most people's first instinct on a small
      // screenshot; inline that opens the expanded view rather than doing
      // nothing. Regions sit above this and take their own clicks.
      ...(expanded ? {} : { onClick: handleOpenExpanded }),
      onLoad: handleImageLoad,
      onError: handleImageError
    };
  }

  function getRegionProps(region: Region, expanded: boolean, isSelected: boolean) {
    const width = naturalSize?.width || pageMap?.width || 1;
    const height = naturalSize?.height || pageMap?.height || 1;
    const { rect } = region;

    return {
      type: "button" as const,
      // Only the inline map tracks the region for scrolling; the expanded one
      // is its own scroll context and is already showing what was clicked.
      ref: !expanded && isSelected ? selectedRegion : undefined,
      "aria-label": `Form ${region.index + 1}, ${region.issueCount} finding${
        region.issueCount === 1 ? "" : "s"
      }`,
      "aria-pressed": isSelected,
      onClick: () => handleSelect(region.index, expanded),
      className: "absolute cursor-pointer",
      style: {
        left: `${(rect.x / width) * 100}%`,
        top: `${(rect.y / height) * 100}%`,
        width: `${(rect.width / width) * 100}%`,
        height: `${(rect.height / height) * 100}%`
      }
    };
  }

  function handleImageLoad(event: SyntheticEvent<HTMLImageElement>) {
    const { naturalWidth, naturalHeight } = event.currentTarget;

    if (naturalWidth > 0 && naturalHeight > 0) {
      setNaturalSize({ width: naturalWidth, height: naturalHeight });
    }

    setImageState("ready");
  }

  function handleImageError() {
    setImageState("error");
  }

  /**
   * A region was chosen: show that form, from either map.
   *
   * The expanded view closes on the way. Selecting in place and leaving the
   * dialog up was tried first and it recreated the problem this whole view
   * exists to fix -- the click's payoff landed behind the dialog, so clicking
   * a form felt like nothing had happened. Clicking a labelled region is a
   * deliberate "show me this one", and nothing is lost by honouring it: the
   * inline map sits directly above the detail with the same regions on it,
   * and Expand page is one click away.
   */
  function handleSelect(index: number, expanded: boolean) {
    if (expanded) {
      setExpandedOpen(false);
    }

    onSelect(index, { reveal: true });
  }

  function handleOpenExpanded() {
    setExpandedOpen(true);
  }

  /** Leaving with whatever is already selected, without picking a region. */
  function handleViewFindings() {
    setExpandedOpen(false);
    onSelect(selectedIndex, { reveal: true });
  }

  /**
   * Whether a form has a place on the page at all.
   *
   * united.com's co-browse PIN form is the measured case: it sits behind
   * `display:none` on an ancestor, so its page rect is 0x0 at (0,0). A region
   * was drawn for it anyway, and because the "Form 2" badge is positioned
   * absolutely inside the region it painted at the very top-left corner of
   * the map -- a marker for a form that is nowhere on the page, which
   * selected a form whose screenshot does not exist.
   */
  function placedOnPage(form: AnalyzedForm): boolean {
    const rect = form.visual?.pageRect;

    return Boolean(rect && rect.width >= 1 && rect.height >= 1);
  }

  /** Forms on this page that have no position to outline. */
  function unplacedCount(): number {
    return forms.filter(
      (form) => form.visual?.pageMap?.pageIndex === pageIndex && !placedOnPage(form)
    ).length;
  }

  /** Forms that sit on the page currently being shown. */
  function regions(): Region[] {
    return forms.reduce<Region[]>((acc, form, index) => {
      const visual = form.visual;
      const rect = visual?.pageRect;

      if (!rect || visual?.pageMap?.pageIndex !== pageIndex) {
        return acc;
      }

      // No size means no location. Outlining it anyway put a badge in the
      // corner of the map claiming a form was there.
      if (!placedOnPage(form)) {
        return acc;
      }

      const issues = form.accessibility?.fieldIssues ?? [];

      acc.push({
        key: `${form.formId ?? "form"}-${index}`,
        index,
        rect,
        issueCount: issues.length,
        severity:
          SEVERITY_ORDER.find((severity) => issues.some((issue) => issue.severity === severity)) ??
          "low"
      });

      return acc;
    }, []);
  }
};

/** Respects a reader who has asked for less motion. */
function scrollBehavior(): ScrollBehavior {
  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  return reduced ? "auto" : "smooth";
}

interface PageMapViewProps {
  /** Every analysed form in the scan, across all pages. */
  forms: AnalyzedForm[];
  /** Job the map belongs to, used to build the image URL. */
  jobId: string;
  /** Index into `forms` of the form being inspected. */
  selectedIndex: number;
  /**
   * Called with a form index when a region is chosen. `reveal` asks the
   * caller to bring the form's detail into view -- false while the expanded
   * map is still open, since scrolling the page behind a dialog is pointless.
   */
  onSelect: (index: number, options?: { reveal?: boolean }) => void;
}

interface Region {
  key: string;
  index: number;
  rect: { x: number; y: number; width: number; height: number };
  issueCount: number;
  severity: IssueSeverity;
}

export default PageMapView;
