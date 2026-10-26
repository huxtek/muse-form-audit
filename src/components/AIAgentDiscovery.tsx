import { useEffect } from 'react';
import {
  injectAIAgentMeta,
  injectStructuredData,
  getAIAgentStructuredData,
  getAIAgentNavigationMap,
  getAIAgentCapabilities,
  createAIAgentBeacon
} from '@/lib/ai-agent-support';

const PAGE_INSTRUCTIONS: Record<string, string> = {
  home: 'This is the main Muse Form Audit interface. Enter a website URL in the input field to analyze forms for AI agent compatibility. Results include accessibility scores, form structure analysis, and optimization recommendations.'
};

interface AIAgentDiscoveryProps {
  page?: string;
  enableBeacon?: boolean;
  enableNavigation?: boolean;
  enableCapabilities?: boolean;
}

/**
 * AIAgentDiscovery Component
 * Makes the app discoverable and navigable by AI agents.
 * Renders nothing; it only injects metadata into the document head.
 */
const AIAgentDiscovery: React.FC<AIAgentDiscoveryProps> = ({
  page = 'default',
  enableBeacon = true,
  enableNavigation = true,
  enableCapabilities = true
}) => {
  useEffect(() => {
    injectAIAgentMeta();
    injectStructuredData(getAIAgentStructuredData());

    if (enableNavigation) {
      injectStructuredData(getAIAgentNavigationMap());
    }

    if (enableCapabilities) {
      injectStructuredData(getAIAgentCapabilities());
    }

    if (enableBeacon) {
      injectStructuredData(createAIAgentBeacon());
    }

    const pageInstructions = PAGE_INSTRUCTIONS[page];
    if (pageInstructions) {
      let instructionMeta = document.querySelector('meta[name="ai-page-instructions"]');
      if (!instructionMeta) {
        instructionMeta = document.createElement('meta');
        instructionMeta.setAttribute('name', 'ai-page-instructions');
        document.head.appendChild(instructionMeta);
      }
      instructionMeta.setAttribute('content', pageInstructions);
    }
  }, [page, enableBeacon, enableNavigation, enableCapabilities]);

  return null;
};

export default AIAgentDiscovery;
