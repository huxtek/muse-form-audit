import { AIScanner } from "@/components/AIScanner";

/**
 * The landing page shell: background, container, and the scanner.
 *
 * The headline and the example report live inside AIScanner rather than here,
 * because they belong in the same grid as the URL input -- the message and
 * the action read as one thing, and all three disappear together once a scan
 * starts, giving the results the full width.
 *
 * This used to hold its own copy as well, which is how the page ended up
 * describing itself five times: a subtitle here, a paragraph in the scanner,
 * a card title, process bullets and feature cards. It also wrapped a second
 * min-h-screen section, leaving a screenful of dead space between the pitch
 * and the input.
 */
export const Hero = () => {
  return (
    <div className="min-h-screen relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-hero" />

      <div className="relative z-10 container mx-auto px-4 py-16 md:py-20">
        <div className="max-w-6xl mx-auto">
          <AIScanner />
        </div>
      </div>
    </div>
  );
};
