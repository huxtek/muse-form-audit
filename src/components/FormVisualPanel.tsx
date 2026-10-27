import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] items-start">
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
        <DialogContent className="max-w-[95vw] w-fit max-h-[92vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>
              {form.formId ? `Form ${form.formId}` : "Form screenshot"}
            </DialogTitle>
          </DialogHeader>

          {/* Same controlled selection, so a pin set inline stays set here. */}
          <FormVisualOverlay {...getOverlayProps()} />
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
