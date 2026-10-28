import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Download, Scan } from 'lucide-react';

interface ReportActionBarProps {
  /** The headline figure, omitted when nothing carried a score. */
  score: number | null;
  /** The site the report describes. */
  url?: string;
  formCount: number;
  /** Which model produced the scores, shown so a report is attributable. */
  modelLabel?: string;
  /** True for the sample report and any dev-mode run. */
  isSampleRun: boolean;
  /** Absent while there is nothing to export. */
  onDownload?: () => void;
  onNewScan: () => void;
}

/**
 * The report's own header: what it scored, and the two things anyone wants
 * next.
 *
 * "New Scan" used to sit at y=715 inside the progress card, on a page over
 * 3,000px tall, which meant that after reading a report the fastest way to
 * start another was the browser's Back button. Pinning the bar is the fix:
 * both actions stay reachable from anywhere in the report, however far down
 * the findings someone has scrolled.
 *
 * The score rides along because a figure is the one thing worth keeping in
 * view while reading what produced it.
 */
export const ReportActionBar = ({
  score,
  url,
  formCount,
  modelLabel,
  isSampleRun,
  onDownload,
  onNewScan
}: ReportActionBarProps) => {
  const subtitle = [
    url,
    formCount === 1 ? '1 form' : `${formCount} forms`,
    modelLabel
  ]
    .filter(Boolean)
    .join(' · ');

  return (
      /*
     * top-16, not top-0. The site header is fixed and 64px tall, so a bar
     * pinned to the viewport top parks underneath it: measured at viewport
     * y=18 to 54, fully behind the header, with elementFromPoint returning
     * the header and a click at the button's centre doing nothing at all.
     * A button that looks present and cannot be pressed is worse than the
     * buried one this replaces.
     */
    <div className="sticky top-16 z-30 -mx-4 px-4 py-3 mb-6 bg-background/90 backdrop-blur-md border-b border-border/60">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0">
          <div className="flex items-baseline gap-1.5">
            {score !== null && (
              <>
                <span className="text-2xl font-bold text-foreground leading-none">{score}</span>
                <span className="text-xs text-muted-foreground">/100</span>
              </>
            )}

            {/* Marked here as well as in the results: this bar is pinned, so
                it is the part most likely to be screenshotted on its own,
                and a score with no provenance reads as a real audit. */}
            {isSampleRun && (
              <Badge
                variant="outline"
                className="ml-1 text-[10px] uppercase tracking-wide border-amber-500/60 text-amber-400"
              >
                Sample
              </Badge>
            )}
          </div>

          <div className="text-xs text-muted-foreground mt-1 truncate">{subtitle}</div>
        </div>

        <div className="flex items-center gap-2 ml-auto">
          <Button onClick={onNewScan} size="sm">
            <Scan className="h-4 w-4 mr-2" />
            Scan another form
          </Button>

          {onDownload && (
            <Button onClick={onDownload} size="sm" variant="outline">
              <Download className="h-4 w-4 mr-2" />
              Download PDF
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

export default ReportActionBar;
