import { Badge } from "@/components/ui/badge";
import { AlertTriangle, CheckCircle, MapPinOff } from "lucide-react";
import { SEVERITY_ORDER, SEVERITY_STYLES } from "@/defines/severities";
import type { AnalyzedForm, FieldIssue, IssueSeverity } from "@/lib/scan-types";

/**
 * The findings for one form, as a list beside its screenshot.
 *
 * Shares a selection key with the overlay -- the lowercased field name or id
 * -- so hovering or clicking an entry lights up the matching highlight on the
 * image and vice versa. Entries whose control is not on the screenshot are
 * grouped at the end and marked, rather than dropped: a finding the model made
 * must not disappear because the capture missed its control.
 */
export const FormFindingsList = ({
  form,
  hoveredField,
  pinnedField,
  onHoverField,
  onPinField
}: FormFindingsListProps) => {
  const groups = groupByField();

  if (groups.length === 0) {
    return (
      <div className="flex items-center gap-2 p-3 rounded-lg border border-border/40 bg-muted/20 text-sm text-muted-foreground">
        <CheckCircle className="h-4 w-4 text-emerald-500" />
        No field-level findings on this form.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <h5 className="text-sm font-semibold text-foreground">
        Findings ({form.accessibility?.fieldIssues?.length ?? 0})
      </h5>

      {/* Two columns once there is room: stacked under a full-width
          screenshot, a long list would push everything else off screen. */}
      <ul className="grid gap-1.5 sm:grid-cols-2">{groups.map(renderGroup)}</ul>

      <p className="text-xs text-muted-foreground">
        Hover to locate on the screenshot, click to keep it highlighted.
      </p>
    </div>
  );

  function renderGroup(group: FieldGroup) {
    const style = SEVERITY_STYLES[group.severity];
    const isPinned = pinnedField === group.identifier;
    const isActive = isPinned || hoveredField === group.identifier;

    return (
      <li key={group.identifier}>
        <button {...getGroupProps(group, isActive, isPinned)}>
          <span className="flex items-center gap-2 mb-1">
            <span className={`inline-block h-2 w-2 rounded-full shrink-0 ${style.dot}`} />
            <code className="text-xs font-mono text-foreground">{group.label}</code>

            {!group.placed && (
              <Badge variant="outline" className="text-[10px] ml-auto gap-1">
                <MapPinOff className="h-3 w-3" />
                not on image
              </Badge>
            )}
          </span>

          <span className="block space-y-1">
            {group.issues.map((issue, index) => (
              <span key={index} className="flex gap-2 text-xs text-muted-foreground">
                <AlertTriangle
                  className={`h-3 w-3 mt-0.5 shrink-0 ${SEVERITY_STYLES[issue.severity].text}`}
                />
                <span>{issue.issue}</span>
              </span>
            ))}
          </span>
        </button>
      </li>
    );
  }

  function getGroupProps(group: FieldGroup, isActive: boolean, isPinned: boolean) {
    return {
      type: "button" as const,
      "aria-pressed": isPinned,
      "aria-label": `${group.issues.length} finding${
        group.issues.length === 1 ? "" : "s"
      } on ${group.label}`,
      className: `w-full text-left p-2.5 rounded-lg border transition-colors ${
        isActive
          ? "border-foreground/40 bg-muted/60"
          : "border-border/40 bg-muted/20 hover:bg-muted/40"
      } ${group.placed ? "cursor-pointer" : "cursor-default"}`,
      onMouseEnter: () => onHoverField?.(group.identifier),
      onMouseLeave: () => onHoverField?.(null),
      onFocus: () => onHoverField?.(group.identifier),
      onBlur: () => onHoverField?.(null),
      onClick: () => onPinField?.(isPinned ? null : group.identifier)
    };
  }

  /**
   * One entry per control, worst severity first, with unplaceable findings
   * last so the list order roughly follows importance.
   */
  function groupByField(): FieldGroup[] {
    const issues = form.accessibility?.fieldIssues ?? [];
    const placedIdentifiers = new Set(
      (form.visual?.fields ?? []).flatMap((field) =>
        [field.name, field.id].filter(Boolean).map((value) => value.toLowerCase())
      )
    );

    const byIdentifier = new Map<string, FieldGroup>();

    for (const issue of issues) {
      const identifier = issue.field.toLowerCase();
      const existing = byIdentifier.get(identifier);

      if (existing) {
        existing.issues.push(issue);
        continue;
      }

      byIdentifier.set(identifier, {
        identifier,
        label: issue.field,
        issues: [issue],
        placed: placedIdentifiers.has(identifier),
        severity: "low"
      });
    }

    const groups = [...byIdentifier.values()].map((group) => ({
      ...group,
      severity: worstSeverity(group.issues)
    }));

    return groups.sort((a, b) => {
      if (a.placed !== b.placed) {
        return a.placed ? -1 : 1;
      }

      return SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
    });
  }

  function worstSeverity(issues: FieldIssue[]): IssueSeverity {
    return (
      SEVERITY_ORDER.find((severity) => issues.some((issue) => issue.severity === severity)) ?? "low"
    );
  }
};

interface FormFindingsListProps {
  form: AnalyzedForm;
  hoveredField: string | null;
  pinnedField: string | null;
  onHoverField?: (identifier: string | null) => void;
  onPinField?: (identifier: string | null) => void;
}

interface FieldGroup {
  identifier: string;
  label: string;
  issues: FieldIssue[];
  /** False when the control is absent from the screenshot. */
  placed: boolean;
  severity: IssueSeverity;
}

export default FormFindingsList;
