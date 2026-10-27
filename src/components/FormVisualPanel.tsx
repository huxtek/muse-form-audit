import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Maximize2 } from "lucide-react";
import FormFindingsList from "@/components/FormFindingsList";
import FormVisualOverlay from "@/components/FormVisualOverlay";
import type { AnalyzedForm } from "@/lib/scan-types";

/**
 * One form's screenshot beside its findings, with selection shared between
 * them: hovering or clicking either side lights up the other. Owning the
 * selection here is what makes that possible -- neither child can know about
 * the other.
 *
 * Also hosts the enlarged view, because the inline crop is rendered small
 * enough that real form text is hard to read.
 *
 * A pin belongs to one form -- field names repeat across forms, so carrying a
 * pin over would highlight an unrelated control. Callers must therefore give
 * this component a `key` derived from the form's identity, which resets the
 * selection by remounting rather than by clearing it from an effect.
 */
export const FormVisualPanel = ({ form, jobId, showSeverityCounts = true }: FormVisualPanelProps) => {
  const [hoveredField, setHoveredField] = useState<string | null>(null);
  const [pinnedField, setPinnedField] = useState<string | null>(null);
  const [zoomOpen, setZoomOpen] = useState(false);

  const hasScreenshot = Boolean(form.visual?.hasScreenshot);

  return (
    <div className="space-y-3">
      {/* Stacked, not side by side. The results card is around 700px wide, so
          splitting it left a 1280px-wide capture rendering at roughly a third
          of its size -- unreadable. Full width plus the enlarged view is the
          better trade. */}
      <div className="space-y-4">
        <div className="space-y-2 min-w-0">
          <FormVisualOverlay {...getOverlayProps()} />

          {hasScreenshot && (
            <Button variant="outline" size="sm" onClick={handleOpenZoom}>
              <Maximize2 className="h-4 w-4 mr-2" />
              Enlarge screenshot
            </Button>
          )}
        </div>

        <FormFindingsList {...getListProps()} />
      </div>

      <Dialog open={zoomOpen} onOpenChange={setZoomOpen}>
        {/* Explicit width: the default DialogContent is max-w-lg, and sizing to
            content left a short wide capture barely larger than inline. */}
        <DialogContent className="w-[95vw] max-w-[1800px] max-h-[92vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>
              {form.formId ? `Form ${form.formId}` : "Form screenshot"}
            </DialogTitle>
            <DialogDescription>
              Hover a highlight to read its findings, or click to keep it open.
            </DialogDescription>
          </DialogHeader>

          {/* Same controlled selection, so a pin set inline stays set here. */}
          <FormVisualOverlay {...getOverlayProps()} enlarged />
        </DialogContent>
      </Dialog>
    </div>
  );

  function getOverlayProps() {
    return {
      form,
      jobId,
      showSeverityCounts,
      hoveredField,
      pinnedField,
      onHoverField: handleHoverField,
      onPinField: handlePinField
    };
  }

  function getListProps() {
    return {
      form,
      hoveredField,
      pinnedField,
      onHoverField: handleHoverField,
      onPinField: handlePinField
    };
  }

  function handleHoverField(identifier: string | null) {
    setHoveredField(identifier);
  }

  function handlePinField(identifier: string | null) {
    setPinnedField(identifier);
  }

  function handleOpenZoom() {
    setZoomOpen(true);
  }
};

interface FormVisualPanelProps {
  form: AnalyzedForm;
  jobId: string;
  showSeverityCounts?: boolean;
}

export default FormVisualPanel;
