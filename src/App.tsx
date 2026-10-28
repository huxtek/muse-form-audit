import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { DevModeProvider } from "@/contexts/DevModeContext";
import { SCAN_ROUTE } from "@/lib/scan-url";
import Index from "./pages/Index";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <DevModeProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <Routes>
            {/* Both paths render the same element on purpose. The scan form
                and the report it produces are two states of one page, and
                React Router reconciles a same-type element in the same
                position without remounting -- so starting a scan on `/` and
                landing on `/scan` keeps the running job alive. Verified by
                probe: one mount, state preserved across the navigation.

                `/` keeps the form because the shortest path to a first scan
                should be the home page, not a click into a sub-page. */}
            <Route path="/" element={<Index />} />
            <Route path={SCAN_ROUTE} element={<Index />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </DevModeProvider>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
