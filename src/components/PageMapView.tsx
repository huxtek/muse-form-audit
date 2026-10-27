import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { ImageOff } from "lucide-react";
import { getPageMapUrl } from "@/lib/api-config";
import { SEVERITY_ORDER, SEVERITY_STYLES } from "@/defines/severities";
import type { AnalyzedForm, IssueSeverity } from "@/lib/scan-types";

/**
 * The scanned page as a whole, with every analysed form outlined and
 * clickable. Choosing a region selects that form, and the annotated crop
 * below shows it in detail.
 *
 * Regions are positioned as percentages of the DECODED image's dimensions
 * rather than the server-reported ones, for the same reason the form overlay
 * does: the browser cannot be wrong about the size of the image it just
 * rendered, so a clamped or re-plumbed capture can never shift the regions.
 */
export const PageMapView = ({ forms, jobId, selectedIndex, onSelect }: PageMapViewProps) => {
  const [imageState, setImageState] = useState<"loading" | "ready" | "error">("loading");
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const lastKey = useRef<string>("");

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

  if (!pageMap) {
    return null;
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-foreground">Scanned page</span>
        <span className="text-xs text-muted-foreground">
          {regions().length} {regions().length === 1 ? "form" : "forms"} outlined &mdash; choose one to inspect
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
        <div className="inline-block max-w-full rounded-xl border border-border/60 bg-white p-2 shadow-lg shadow-black/20">
          <div className="relative inline-block max-w-full overflow-hidden rounded-md">
            <img {...getImageProps()} />

            {imageState === "ready" && regions().map(renderRegion)}
          </div>
        </div>
      )}
    </div>
  );

  function renderRegion(region: Region) {
    const style = SEVERITY_STYLES[region.severity];
    const isSelected = region.index === selectedIndex;

    return (
      <button key={region.key} {...getRegionProps(region)}>
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

  function getImageProps() {
    return {
      src: getPageMapUrl(jobId, pageIndex),
      alt: `Screenshot of the scanned page`,
      // Capped height so a long page does not dominate the results. The image
      // scales proportionally, and the regions are positioned in percentages,
      // so they stay aligned at any rendered size.
      className: "block max-w-full h-auto max-h-[460px] w-auto",
      style: { aspectRatio: `${pageMap?.width} / ${pageMap?.height}` },
      onLoad: handleImageLoad,
      onError: handleImageError
    };
  }

  function getRegionProps(region: Region) {
    const width = naturalSize?.width || pageMap?.width || 1;
    const height = naturalSize?.height || pageMap?.height || 1;
    const { rect } = region;

    return {
      type: "button" as const,
      "aria-label": `Form ${region.index + 1}, ${region.issueCount} finding${
        region.issueCount === 1 ? "" : "s"
      }`,
      "aria-pressed": region.index === selectedIndex,
      onClick: () => handleSelect(region.index),
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

  function handleSelect(index: number) {
    onSelect(index);
  }

  /** Forms that sit on the page currently being shown. */
  function regions(): Region[] {
    return forms.reduce<Region[]>((acc, form, index) => {
      const visual = form.visual;
      const rect = visual?.pageRect;

      if (!rect || visual?.pageMap?.pageIndex !== pageIndex) {
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

interface PageMapViewProps {
  /** Every analysed form in the scan, across all pages. */
  forms: AnalyzedForm[];
  /** Job the map belongs to, used to build the image URL. */
  jobId: string;
  /** Index into `forms` of the form being inspected. */
  selectedIndex: number;
  /** Called with a form index when a region is chosen. */
  onSelect: (index: number) => void;
}

interface Region {
  key: string;
  index: number;
  rect: { x: number; y: number; width: number; height: number };
  issueCount: number;
  severity: IssueSeverity;
}

export default PageMapView;
