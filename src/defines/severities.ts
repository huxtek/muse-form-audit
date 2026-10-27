import type { IssueSeverity } from "@/lib/scan-types";

/** Worst first. Used to pick a box's colour when a control has several findings. */
export const SEVERITY_ORDER: IssueSeverity[] = ['high', 'medium', 'low'];

/**
 * Presentation for each severity. Semantic Tailwind utilities only, so these
 * follow the theme rather than hardcoding a palette.
 */
export const SEVERITY_STYLES: Record<
  IssueSeverity,
  { label: string; border: string; fill: string; dot: string; badge: string; text: string }
> = {
  high: {
    label: 'high',
    border: 'border-destructive',
    fill: 'bg-destructive/20',
    dot: 'bg-destructive',
    badge: 'bg-destructive text-destructive-foreground',
    text: 'text-destructive'
  },
  medium: {
    label: 'medium',
    border: 'border-amber-500',
    fill: 'bg-amber-500/20',
    dot: 'bg-amber-500',
    badge: 'bg-amber-500 text-black',
    text: 'text-amber-500'
  },
  low: {
    label: 'low',
    border: 'border-sky-500',
    fill: 'bg-sky-500/15',
    dot: 'bg-sky-500',
    badge: 'bg-sky-500 text-black',
    text: 'text-sky-500'
  }
};
