import { useEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, CheckCircle, FlaskConical, ImageOff } from "lucide-react";
import { getScreenshotUrl } from "@/lib/api-config";
import { SEVERITY_ORDER, SEVERITY_STYLES } from "@/defines/severities";
import type { AnalyzedForm, FieldIssue, IssueSeverity, VisualField } from "@/lib/scan-types";

/** Boxes below this width get their badge placed outside, so it stays legible. */
const NARROW_BOX = 44;

/**
 * Findings shown in a floating tooltip before it defers to the list below.
 *
 * Three keeps the tooltip around 110px plus its header, which stays clear
 * even over the 132px-tall wide capture that caused the original clipping.
 */
const TOOLTIP_ISSUE_LIMIT = 3;

/**
 * Renders a captured form screenshot with one highlight per control that has a
 * finding, so an issue can be seen in place rather than read from a list.
 *
 * The screenshot is served from its own endpoint rather than inlined, and the
 * captured pixel size is known, so highlights are positioned in percentages of
 * the natural size. That keeps them aligned at any rendered width without
 * measuring the image or listening for resize.
 */
export const FormVisualOverlay = ({
  form,
  jobId,
  showSeverityCounts = true,
  hoveredField = null,
  pinnedField = null,
  onHoverField,
  onPinField,
  enlarged = false
}: FormVisualOverlayProps) => {
  const visual = form.visual;
  const fieldIssues = form.accessibility?.fieldIssues ?? [];
  const [imageState, setImageState] = useState<"loading" | "ready" | "error">("loading");
  /**
   * Usable both ways: a parent that wants the image and a findings list in
   * step passes selection down, and anything rendering the overlay on its own
   * still gets working hover and pin behaviour.
   */
  const isControlled = onHoverField !== undefined || onPinField !== undefined;
  const [ownHoveredField, setOwnHoveredField] = useState<string | null>(null);
  const [ownPinnedField, setOwnPinnedField] = useState<string | null>(null);
  const activeHover = isControlled ? hoveredField : ownHoveredField;
  const activePin = isControlled ? pinnedField : ownPinnedField;
  /**
   * The decoded image's own dimensions, read on load.
   *
   * Highlights are positioned as percentages, and the divisor has to be the
   * size of the image actually on screen. Trusting server-reported numbers
   * means any disagreement -- a clamped capture, a changed capture path --
   * silently shifts every box. The browser cannot be wrong about this.
   */
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  // Reset when the form changes, otherwise a previous form's error state sticks.
  const lastKey = useRef<string>("");

  useEffect(() => {
    const key = `${jobId}:${visual?.visualIndex}`;
    if (lastKey.current !== key) {
      lastKey.current = key;
      setImageState("loading");
      setNaturalSize(null);
      setOwnHoveredField(null);
      setOwnPinnedField(null);
    }
  }, [jobId, visual?.visualIndex]);

  if (!visual?.hasScreenshot || !visual.width || !visual.height) {
    return renderUnavailable();
  }

  return (
    <div className="space-y-3">
      {renderLegend()}

      {/* A light "paper" frame so the capture reads as a web page against the
          dark UI. The padding also means the frame's rounded corners never sit
          over the screenshot's own content.

          Deliberately NOT overflow-hidden: tooltips are positioned against the
          highlights, and clipping the frame cut them off on short captures. */}
      <div
        className={`rounded-xl border border-border/60 bg-white p-2 shadow-lg shadow-black/20 ${
          enlarged ? "block w-full" : "inline-block max-w-full"
        }`}
      >
        <div className={`relative ${enlarged ? "block w-full" : "inline-block max-w-full"}`}>
          <img {...getImageProps()} />

          {imageState === "ready" && highlightedFields().map(renderHighlight)}

          {imageState === "error" && (
            <div className="p-6 text-sm text-muted-foreground">
              Screenshot could not be loaded.
            </div>
          )}
        </div>
      </div>

      {renderFooter()}
    </div>
  );

  function renderLegend() {
    const counts = countsBySeverity();

    return (
      <div className="flex flex-wrap items-center gap-2">
        {visual?.isSample && (
          <Badge variant="secondary" className="text-xs">
            <FlaskConical className="h-3 w-3 mr-1" />
            Sample image
          </Badge>
        )}

        {fieldIssues.length === 0 ? (
          <Badge variant="outline" className="text-xs">
            <CheckCircle className="h-3 w-3 mr-1" />
            No field-level issues
          </Badge>
        ) : (
          // Suppressed for a single-form scan, where the score strip above
          // already shows the same totals.
          showSeverityCounts &&
          SEVERITY_ORDER.filter((severity) => counts[severity] > 0).map((severity) => (
            <Badge key={severity} variant="outline" className="text-xs">
              <span className={`inline-block h-2 w-2 rounded-full mr-2 ${SEVERITY_STYLES[severity].dot}`} />
              {counts[severity]} {SEVERITY_STYLES[severity].label}
            </Badge>
          ))
        )}
      </div>
    );
  }

  function renderHighlight(entry: HighlightEntry) {
    const { field, severity, issues } = entry;
    const style = SEVERITY_STYLES[severity];
    const isPinned = activePin === entry.identifier;
    const isActive = isPinned || activeHover === entry.identifier;
    const narrow = field.rect.width < NARROW_BOX;

    return (
      <div key={entry.key} {...getHighlightProps(entry)}>
        <div
          className={`absolute inset-0 rounded-sm border-2 transition-shadow ${style.border} ${style.fill} ${
            isActive ? "ring-2 ring-offset-1 ring-foreground/50" : ""
          } ${isPinned ? "shadow-lg" : ""}`}
        />

        {/* Checkboxes and radios are too small to hold the badge, and their
            label sits to the RIGHT, so the badge goes out to the left to avoid
            covering it. */}
        <span
          className={`absolute ${narrow ? "top-0 right-full mr-1" : "-top-2 left-1"} ${style.badge} text-[10px] font-semibold leading-none px-1 py-0.5 rounded`}
        >
          {issues.length}
        </span>

        {isActive && renderTooltip(entry)}
      </div>
    );
  }

  function renderTooltip(entry: HighlightEntry) {
    // Anchored below the box, or above it when the box sits low in the image,
    // so the tooltip stays inside the frame.
    const frameHeight = naturalSize?.height || visual?.height || 0;
    const below = entry.field.rect.y + entry.field.rect.height < frameHeight * 0.7;

    // pointer-events-none: a short capture leaves the tooltip hanging over
    // whatever sits below the image, and an informational panel must never
    // swallow a click meant for a control underneath it.
    return (
      <div
        role="tooltip"
        className={`absolute z-20 w-72 max-w-[80vw] p-3 rounded-md border border-border bg-popover text-popover-foreground shadow-lg text-left pointer-events-none ${
          below ? "top-full mt-2" : "bottom-full mb-2"
        } left-0`}
      >
        <div className="flex items-center gap-2 mb-2">
          <span className={`inline-block h-2 w-2 rounded-full ${SEVERITY_STYLES[entry.severity].dot}`} />
          <code className="text-xs font-mono">{entry.label}</code>
          <Badge variant="outline" className="text-[10px] ml-auto">
            {SEVERITY_STYLES[entry.severity].label}
          </Badge>
        </div>

        {/* Capped, because a control with six findings would produce a
            tooltip taller than the capture it floats over -- the clipping
            this component already had to be fixed for once. The findings
            list below the screenshot carries every one of them, so nothing
            is lost by stopping here. */}
        <ul className="space-y-2">
          {entry.issues.slice(0, TOOLTIP_ISSUE_LIMIT).map((issue, index) => (
            <li key={index} className="text-xs text-muted-foreground flex gap-2">
              <AlertTriangle className={`h-3 w-3 mt-0.5 shrink-0 ${SEVERITY_STYLES[issue.severity].text}`} />
              <span>{issue.issue}</span>
            </li>
          ))}
        </ul>

        {entry.issues.length > TOOLTIP_ISSUE_LIMIT && (
          // Plain text, not a control: this tooltip is pointer-events-none by
          // design, so anything clickable here would either be dead or would
          // start swallowing clicks meant for the image again.
          <p className="mt-2 text-xs font-medium text-foreground">
            +{entry.issues.length - TOOLTIP_ISSUE_LIMIT} more in the findings list below
          </p>
        )}
      </div>
    );
  }

  function renderUnavailable() {
    return (
      <div className="flex items-start gap-3 p-4 rounded-lg border border-border/50 bg-muted/30">
        <ImageOff className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
        <div className="text-sm">
          <p className="font-medium text-foreground">No screenshot for this form</p>
          <p className="text-muted-foreground">
            {visual?.unavailableReason
              ? `Capture skipped: ${visual.unavailableReason}.`
              : "The form was not captured, so there is nothing to highlight."}{" "}
            The written findings are in the Details tab.
          </p>
        </div>
      </div>
    );
  }

  function renderFooter() {
    const unmatched = unmatchedIssues();

    return (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Hover a highlight to read its findings, or click to keep it open.
          {visual?.truncated ? " The form was taller than the capture limit, so the image is cropped." : ""}
        </p>

        {unmatched.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {unmatched.length} finding{unmatched.length === 1 ? "" : "s"} could not be placed on the
            image ({unmatched.map((issue) => issue.field).join(", ")}). See the Details tab.
          </p>
        )}
      </div>
    );
  }

  function getImageProps() {
    return {
      src: getScreenshotUrl(jobId, visual?.visualIndex ?? 0),
      alt: `Screenshot of form ${form.formId ?? visual?.visualIndex}`,
      // Enlarged fills the dialog width, so a short wide crop still gets
      // bigger rather than rendering at its own modest natural size.
      className: enlarged
        ? "block w-full h-auto rounded-md"
        : "block max-w-full h-auto rounded-md",
      // Reserving the captured ratio stops the highlights flashing in the
      // wrong place for a frame while the image decodes.
      style: { aspectRatio: `${visual?.width} / ${visual?.height}` },
      onLoad: handleImageLoad,
      onError: handleImageError
    };
  }

  function getHighlightProps(entry: HighlightEntry) {
    const { rect } = entry.field;
    // Natural size wins; the reported size is only a fallback for the frame
    // before the image has decoded.
    const width = naturalSize?.width || visual?.width || 1;
    const height = naturalSize?.height || visual?.height || 1;

    return {
      className: "absolute group cursor-pointer",
      style: {
        left: `${(rect.x / width) * 100}%`,
        top: `${(rect.y / height) * 100}%`,
        width: `${(rect.width / width) * 100}%`,
        height: `${(rect.height / height) * 100}%`
      },
      tabIndex: 0,
      role: "button",
      "aria-label": `${entry.issues.length} finding${entry.issues.length === 1 ? "" : "s"} on ${entry.label}`,
      "aria-pressed": activePin === entry.identifier,
      onMouseEnter: () => handleHover(entry.identifier),
      onMouseLeave: () => handleHover(null),
      onFocus: () => handleHover(entry.identifier),
      onBlur: () => handleHover(null),
      onClick: () => handlePin(entry.identifier),
      // A div with role=button does not get Enter/Space for free.
      onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          handlePin(entry.identifier);
        }
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

  function handleHover(identifier: string | null) {
    if (isControlled) {
      onHoverField?.(identifier);

      return;
    }

    setOwnHoveredField(identifier);
  }

  /** Clicking toggles a pin, so a finding can be read without holding hover. */
  function handlePin(identifier: string) {
    const next = activePin === identifier ? null : identifier;

    if (isControlled) {
      onPinField?.(next);

      return;
    }

    setOwnPinnedField(next);
  }

  /** Pairs each renderable control with the findings attributed to it. */
  function highlightedFields(): HighlightEntry[] {
    const byIdentifier = new Map<string, FieldIssue[]>();

    for (const issue of fieldIssues) {
      const key = issue.field.toLowerCase();
      byIdentifier.set(key, [...(byIdentifier.get(key) ?? []), issue]);
    }

    const entries: HighlightEntry[] = [];
    const used = new Set<string>();

    (visual?.fields ?? []).forEach((field, index) => {
      const identifier = (field.name || field.id || "").toLowerCase();
      const issues = identifier ? byIdentifier.get(identifier) : undefined;

      if (!issues?.length) {
        return;
      }

      // A radio or checkbox group shares one name: highlight the first member
      // only, so one finding does not paint the same box several times.
      if (used.has(identifier)) {
        return;
      }
      used.add(identifier);

      entries.push({
        key: `${identifier}-${index}`,
        // Lowercased name/id. The shared selection key between the image and
        // the findings list, which only knows field names.
        identifier,
        label: field.name || field.id,
        field,
        // Worst first, so a capped tooltip never hides the high-severity
        // finding behind "+2 more" while the box is painted red for it.
        // Stable within a severity, keeping the model's own ordering.
        issues: [...issues].sort(
          (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
        ),
        severity: worstSeverity(issues)
      });
    });

    return entries;
  }

  function unmatchedIssues(): FieldIssue[] {
    const identifiers = new Set(
      (visual?.fields ?? []).flatMap((field) =>
        [field.name, field.id].filter(Boolean).map((value) => value.toLowerCase())
      )
    );

    return fieldIssues.filter((issue) => !identifiers.has(issue.field.toLowerCase()));
  }

  function countsBySeverity(): Record<IssueSeverity, number> {
    return fieldIssues.reduce(
      (acc, issue) => {
        acc[issue.severity] = (acc[issue.severity] ?? 0) + 1;

        return acc;
      },
      { high: 0, medium: 0, low: 0 } as Record<IssueSeverity, number>
    );
  }

  function worstSeverity(issues: FieldIssue[]): IssueSeverity {
    return (
      SEVERITY_ORDER.find((severity) => issues.some((issue) => issue.severity === severity)) ?? "low"
    );
  }
};

interface FormVisualOverlayProps {
  /** The analyzed form, including its captured geometry. */
  form: AnalyzedForm;
  /** Job the screenshot belongs to, used to build the image URL. */
  jobId: string;
  /**
   * Whether to repeat the per-form severity totals. Hidden when the page
   * already shows the same numbers for a single form.
   */
  showSeverityCounts?: boolean;
  /**
   * Selection is controlled by the parent so the image and the findings list
   * stay in step. `hoveredField` is transient; `pinnedField` survives until
   * it is toggled off.
   */
  hoveredField?: string | null;
  pinnedField?: string | null;
  onHoverField?: (identifier: string | null) => void;
  onPinField?: (identifier: string | null) => void;
  /**
   * Fill the available width rather than sitting at the capture's natural
   * size. Used by the enlarged view, where a short wide crop would otherwise
   * barely grow.
   */
  enlarged?: boolean;
}

interface HighlightEntry {
  key: string;
  identifier: string;
  label: string;
  field: VisualField;
  issues: FieldIssue[];
  severity: IssueSeverity;
}

export default FormVisualOverlay;
