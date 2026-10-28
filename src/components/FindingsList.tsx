import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CheckCircle, ListChecks } from 'lucide-react';
import { SEVERITY_ORDER, SEVERITY_STYLES } from '@/defines/severities';
import { collectFindings, countSeverities, type Finding } from '@/lib/report-data';
import type { AnalyzedForm, IssueSeverity } from '@/lib/scan-types';

const ALL_SEVERITIES = 'all';

type SeverityFilter = IssueSeverity | typeof ALL_SEVERITIES;

interface FindingsListProps {
  /** Every form in the scan. Findings are flattened across all of them. */
  forms: AnalyzedForm[];
}

/**
 * Everything to fix, in one list, worst first.
 *
 * Replaces two parallel lists -- "Issues Found" and "Recommendations" -- that
 * sat 260px apart, so a problem and its remedy were never on screen together.
 * They could not be zipped either: nothing keyed one to the other and the
 * counts did not match, with one sample form carrying four issues against
 * eight recommendations.
 *
 * The field-level findings are better than both. Each already names the
 * control, the severity and the remedy in a single sentence, which is what
 * the landing page promises: the attribute to add and the field to add it to.
 *
 * Flat rather than grouped by form, so one broken form among three healthy
 * ones is obvious without expanding anything. Each row carries its form, and
 * the filter narrows by severity for anyone who only wants the blockers.
 */
export const FindingsList = ({ forms }: FindingsListProps) => {
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>(ALL_SEVERITIES);

  const findings = collectFindings(forms);
  const counts = countSeverities(findings);
  const visible =
    severityFilter === ALL_SEVERITIES
      ? findings
      : findings.filter((finding) => finding.severity === severityFilter);
  const showFormLabels = forms.length > 1;

  return (
    <Card className="bg-card/50 border-border/50">
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-x-3 gap-y-2 text-base">
          <span className="flex items-center gap-2">
            <ListChecks className="h-4 w-4" />
            {counts.total === 1 ? '1 finding' : `${counts.total} findings`}
          </span>

          {counts.total > 0 && (
            <span className="flex flex-wrap items-center gap-1.5">
              {renderFilter(ALL_SEVERITIES, counts.total, 'All')}
              {SEVERITY_ORDER.filter((severity) => counts[severity] > 0).map((severity) =>
                renderFilter(severity, counts[severity], SEVERITY_STYLES[severity].label)
              )}
            </span>
          )}
        </CardTitle>
      </CardHeader>

      <CardContent>
        {counts.total === 0 ? renderClean() : <ul className="space-y-2">{visible.map(renderFinding)}</ul>}
      </CardContent>
    </Card>
  );

  function renderFilter(value: SeverityFilter, count: number, label: string) {
    const isActive = severityFilter === value;

    return (
      <Button
        key={value}
        type="button"
        size="sm"
        variant={isActive ? 'secondary' : 'ghost'}
        aria-pressed={isActive}
        onClick={() => setSeverityFilter(value)}
        className="h-7 px-2.5 text-xs font-medium capitalize"
      >
        {value !== ALL_SEVERITIES && (
          <span
            className={`inline-block h-2 w-2 rounded-full mr-1.5 ${SEVERITY_STYLES[value].dot}`}
          />
        )}
        {label} {count}
      </Button>
    );
  }

  function renderFinding(finding: Finding, index: number) {
    return (
      <li
        key={`${finding.formIndex}-${finding.field ?? 'form'}-${index}`}
        className={`border-l-2 ${SEVERITY_STYLES[finding.severity].border} rounded-r-md bg-muted/20 pl-3 pr-3 py-2.5`}
      >
        <p className="text-sm text-foreground">{finding.issue}</p>

        <div className="flex flex-wrap items-center gap-2 mt-1.5">
          {finding.field ? (
            <code className="text-xs font-mono text-muted-foreground">{finding.field}</code>
          ) : (
            <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
              Whole form
            </Badge>
          )}

          <span className={`text-xs ${SEVERITY_STYLES[finding.severity].text}`}>
            {SEVERITY_STYLES[finding.severity].label}
          </span>

          {showFormLabels && (
            <span className="text-xs text-muted-foreground">{finding.formLabel}</span>
          )}
        </div>
      </li>
    );
  }

  function renderClean() {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <CheckCircle className="h-4 w-4 text-emerald-500" />
        Nothing to fix. No field-level or whole-form findings were raised.
      </div>
    );
  }
};

export default FindingsList;
