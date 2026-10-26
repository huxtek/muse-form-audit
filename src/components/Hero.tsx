import { Bot } from "lucide-react";
import { AIScanner } from "@/components/AIScanner";

export const Hero = () => {
  return (
    <div className="min-h-screen relative overflow-hidden">
      {/* Simple gradient background */}
      <div className="absolute inset-0 bg-gradient-hero" />

      <div className="relative z-10 container mx-auto px-4 py-20">
        <div className="max-w-4xl mx-auto text-center">
          {/* Header */}
          <div className="flex items-center justify-center gap-3 mb-6">
            <Bot className="h-8 w-8 text-primary" />
            <h1 className="text-5xl md:text-7xl font-bold bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">
              Muse Form Audit
            </h1>
          </div>

          <p className="text-xl md:text-2xl text-muted-foreground mb-12 max-w-3xl mx-auto leading-relaxed">
            Discover if your website forms are accessible to AI agents with comprehensive AI-driven scanning.
          </p>

          {/* AI Scanner */}
          <AIScanner />
        </div>
      </div>
    </div>
  );
};
