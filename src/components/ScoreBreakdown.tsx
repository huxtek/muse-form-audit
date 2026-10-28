import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { BarChart3 } from 'lucide-react';
import { aggregateCategories, type CategoryTotal } from '@/lib/report-data';
import type { AnalyzedForm } from '@/lib/scan-types';

const STRONG_RATIO = 0.8;
const WEAK_RATIO = 0.5;

interface ScoreBreakdownProps {
  /** Every form in the scan. Categories are totalled across all of them. */
  forms: AnalyzedForm[];
  /** The headline figure, so the panel can say what it decomposes. */
  score: number | null;
}

/**
 * Where the score came from: the eight scored categories, worst gap first.
 *
 * This replaces four progress bars labelled Form Discovery, Field
 * Identification, Data Entry and Form Submission, whose values were the one
 * score minus 10, minus 5, unchanged and minus 15. Nothing measured any of
 * them. The real per-category scores were in the payload the whole time and
 * sum exactly to the headline figure, which is the breakdown the landing page
 * has been promising.
 */
export const ScoreBreakdown = ({ forms, score }: ScoreBreakdownProps) => {
  const categories = aggregateCategories(forms);
  const formCount = forms.length;

  return categories.length === 0 ? null : (
    <Card className="bg-card/50 border-border/50">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <BarChart3 className="h-4 w-4" />
          {score === null ? 'Score breakdown' : `Where the ${score} comes from`}
        </CardTitle>

        <p className="text-sm text-muted-foreground">
          {formCount === 1
            ? 'Eight categories, totalling 100 points. Biggest losses first.'
            : `Eight categories across ${formCount} forms, totalling 100 points each. Biggest losses first.`}
        </p>
      </CardHeader>

      <CardContent className="space-y-3">
        {categories.map(renderCategory)}
      </CardContent>
    </Card>
  );

  function renderCategory(category: CategoryTotal) {
    const percent = category.maxScore > 0 ? (category.score / category.maxScore) * 100 : 0;

    return (
      <div key={category.key} className="grid grid-cols-[9rem_1fr_4.5rem] items-center gap-3">
        <span className="text-sm text-foreground">{category.label}</span>

        <Progress value={percent} className="h-2" />

        <span className={`text-sm font-semibold text-right ${getToneClass(percent)}`}>
          {category.score}/{category.maxScore}
        </span>
      </div>
    );
  }

  function getToneClass(percent: number) {
    const ratio = percent / 100;
    let tone = 'text-destructive';

    if (ratio >= STRONG_RATIO) {
      tone = 'text-emerald-500';
    } else if (ratio >= WEAK_RATIO) {
      tone = 'text-amber-500';
    }

    return tone;
  }
};

export default ScoreBreakdown;
