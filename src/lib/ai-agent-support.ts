/**
 * AI Agent Support Utilities
 *
 * Declares the scanner itself as AI-agent friendly, so automated clients can
 * discover what the app does and how to drive it. All URLs are derived from the
 * origin the app is actually served from, so nothing is tied to a fixed domain.
 */

const APP_NAME = 'Muse Form Audit';

const getOrigin = (): string =>
  typeof window === 'undefined' ? '' : window.location.origin;

// AI Agent meta tags and structured data
export const AI_AGENT_META = {
  // OpenAI GPT and similar agents
  'ai-agent-friendly': 'true',
  'ai-crawlable': 'true',
  'ai-indexable': 'true',

  // Claude and Anthropic agents
  'anthropic-crawlable': 'true',
  'claude-friendly': 'true',

  // Google Bard/Gemini
  'google-ai-crawlable': 'true',
  'bard-indexable': 'true',

  // General AI agent support
  'ai-content-type': 'business-application',
  'ai-interaction-mode': 'form-analysis',
  'ai-service-category': 'accessibility-audit',

  // API and automation friendly
  'automation-friendly': 'true',
  'api-discoverable': 'true',
  'machine-readable': 'true'
};

// Helper function to inject a JSON-LD block into the document head
export const injectStructuredData = (data: object) => {
  const script = document.createElement('script');
  script.type = 'application/ld+json';
  script.textContent = JSON.stringify(data);
  document.head.appendChild(script);
};

// AI Agent structured data for discovery
export const getAIAgentStructuredData = () => ({
  '@context': 'https://schema.org',
  '@type': 'WebApplication',
  name: APP_NAME,
  description: 'AI-powered website form accessibility analysis and optimization tool',
  url: getOrigin(),
  applicationCategory: 'DeveloperApplication',
  operatingSystem: 'Web Browser',
  browserRequirements: 'Modern web browser with JavaScript support',

  // AI Agent specific properties
  aiAgentFriendly: true,
  automationSupported: true,
  apiAvailable: true,
  machineReadable: true,

  // Service capabilities for AI agents
  serviceType: [
    'Form Analysis',
    'Accessibility Audit',
    'AI Compatibility Testing',
    'Website Optimization'
  ],

  // Input/Output specification for AI agents
  potentialAction: [
    {
      '@type': 'AnalyzeAction',
      name: 'Analyze Website Forms',
      description: 'Analyze website forms for AI agent compatibility and accessibility',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: `${getOrigin()}/?url={website_url}`,
        actionPlatform: ['http://schema.org/WebPlatform'],
        httpMethod: 'GET'
      },
      object: {
        '@type': 'WebSite',
        name: 'Target Website URL'
      },
      result: {
        '@type': 'Report',
        name: 'AI Form Compatibility Report'
      }
    }
  ]
});

// AI Agent navigation map
export const getAIAgentNavigationMap = () => ({
  '@context': 'https://schema.org',
  '@type': 'SiteNavigationElement',
  name: 'AI Agent Navigation Map',
  description: 'Navigation structure optimized for AI agents',
  url: getOrigin(),

  hasPart: [
    {
      '@type': 'WebPage',
      name: 'Scanner - AI Form Analysis',
      url: `${getOrigin()}/`,
      description: 'Main form analysis interface for AI agents',
      mainContentOfPage: {
        '@type': 'WebPageElement',
        cssSelector: '.ai-scanner',
        description: 'AI-powered form scanner interface'
      },
      aiAgentInstructions:
        'Enter a website URL to analyze forms for AI compatibility. Results include accessibility scores and recommendations.'
    }
  ]
});

// AI Agent capability declaration
export const getAIAgentCapabilities = () => ({
  '@context': 'https://schema.org',
  '@type': 'Service',
  name: `${APP_NAME} - AI Agent Services`,
  description:
    'Specialized form analysis services designed for AI agents and automation tools',

  serviceOutput: [
    {
      '@type': 'Report',
      name: 'AI Compatibility Report',
      description: 'Detailed analysis of form AI-friendliness',
      encodingFormat: ['application/json', 'text/html', 'application/pdf']
    },
    {
      '@type': 'Dataset',
      name: 'Form Analysis Data',
      description: 'Structured data about form accessibility and AI compatibility',
      encodingFormat: 'application/json'
    }
  ],

  serviceAudience: [
    {
      '@type': 'Audience',
      audienceType: 'AI Agents',
      name: 'Artificial Intelligence Agents'
    },
    {
      '@type': 'Audience',
      audienceType: 'Automation Tools',
      name: 'Web Automation Software'
    },
    {
      '@type': 'Audience',
      audienceType: 'Developers',
      name: 'AI/ML Developers'
    }
  ]
});

// Helper function to inject AI agent meta tags
export const injectAIAgentMeta = () => {
  Object.entries(AI_AGENT_META).forEach(([name, content]) => {
    let metaTag = document.querySelector(`meta[name="${name}"]`);
    if (!metaTag) {
      metaTag = document.createElement('meta');
      metaTag.setAttribute('name', name);
      document.head.appendChild(metaTag);
    }
    metaTag.setAttribute('content', content);
  });
};

// AI Agent discovery beacon
export const createAIAgentBeacon = () => ({
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: APP_NAME,
  alternateName: 'AI-Friendly Form Analysis Tool',
  description: 'Discover and analyze website forms for AI agent compatibility',
  url: getOrigin(),

  // AI Agent discovery signals
  aiAgentSupport: {
    supported: true,
    version: '1.0',
    capabilities: [
      'form-analysis',
      'accessibility-audit',
      'ai-compatibility-testing',
      'automation-optimization'
    ]
  },

  // Machine-readable service description
  machineReadableDescription: {
    inputFormat: ['text/html', 'application/json'],
    outputFormat: ['application/json', 'text/html', 'application/pdf'],
    supportedLanguages: ['en']
  }
});
