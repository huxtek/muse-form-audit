import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { validateURLMiddleware, validateOptions } from '../middleware/validation.js';
import { AIAgent } from '../agent.js';
import { isValidProvider, resolveProviderName } from '../lib/llm/index.js';

const router = express.Router();

const SCAN_TIER = process.env.SCAN_TIER || 'premium';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/**
 * Builds a deterministic mock analysis so the project runs end to end with no
 * API keys configured.
 */
const buildMockAnalysis = (targetUrl) => {
  const forms = [
    {
      formId: 'mock_form_1',
      url: targetUrl,
      characteristics: {
        action: '/submit',
        method: 'POST',
        hasValidation: true,
        isSecure: targetUrl.startsWith('https')
      },
      fields: [
        { name: 'email', type: 'email', required: true, hasLabel: true, hasAriaLabel: false },
        { name: 'password', type: 'password', required: true, hasLabel: true, hasAriaLabel: false },
        { name: 'remember', type: 'checkbox', required: false, hasLabel: true, hasAriaLabel: true }
      ],
      accessibility: {
        score: 82,
        issues: [
          'Missing aria-labels on email and password fields',
          'Form could benefit from better error messaging',
          'Consider adding autocomplete attributes'
        ],
        recommendations: [
          'Add aria-label attributes to form fields',
          'Implement live validation feedback',
          'Use semantic HTML5 input types'
        ]
      }
    }
  ];

  return {
    url: targetUrl,
    timestamp: new Date().toISOString(),
    jobId: `dev_${Date.now()}`,
    forms,
    summary: {
      totalForms: forms.length,
      totalPages: 1,
      discoveredUrls: 1,
      visitedUrls: 1,
      coveragePercentage: 100,
      aiSummary: `Mock analysis of ${targetUrl} found ${forms.length} form(s). This is simulated data for local development.`,
      scanMode: 'dev-mode-single-page'
    },
    metadata: {
      targetUrl,
      devMode: true
    }
  };
};

/**
 * POST /api/analyze
 * Single-page form analysis. Returns the result synchronously.
 */
router.post('/analyze', validateURLMiddleware, async (req, res) => {
  const validatedURL = req.validatedURL;
  const isDevMode = req.body.devMode === true;

  try {
    const { options } = req.body;

    if (options) {
      const optionsValidation = validateOptions(options);
      if (!optionsValidation.isValid) {
        return res.status(400).json({
          error: 'Invalid options',
          message: 'Request options contain invalid data',
          details: optionsValidation.errors,
          code: 'INVALID_OPTIONS'
        });
      }
    }

    console.log(`Analyzing ${validatedURL} (devMode: ${isDevMode})`);

    let analysisResult;

    if (isDevMode) {
      analysisResult = buildMockAnalysis(validatedURL);
    } else {
      const jobId = uuidv4();
      let finalResults = null;

      // Untrusted input: allowlisted provider names only.
      const providerName = resolveProviderName(
        isValidProvider(req.body.modelProvider) ? req.body.modelProvider : undefined
      );

      const agent = new AIAgent(
        jobId,
        validatedURL,
        false,
        SCAN_TIER,
        (update) => {
          console.log(`Analysis progress: ${update.progress}% - ${update.currentStep}`);
          if (update.status === 'completed' && update.results) {
            finalResults = update.results;
          }
        },
        providerName
      );

      try {
        await agent.runSinglePageAnalysis();

        if (!finalResults) {
          throw new Error('Analysis completed but no results were captured');
        }

        analysisResult = {
          url: validatedURL,
          timestamp: new Date().toISOString(),
          jobId,
          forms: finalResults.forms || [],
          summary: {
            totalForms: finalResults.summary?.totalForms || 0,
            totalPages: finalResults.summary?.totalPages || 1,
            discoveredUrls: finalResults.summary?.discoveredUrls || 1,
            visitedUrls: finalResults.summary?.visitedUrls || 1,
            coveragePercentage: finalResults.summary?.coveragePercentage || 100,
            aiSummary: finalResults.aiSummary || '',
            scanMode: finalResults.scanMode || 'single-page'
          },
          metadata: {
            targetUrl: finalResults.targetUrl || validatedURL,
            devMode: false
          }
        };
      } finally {
        await agent.cleanup();
      }
    }

    res.json({
      success: true,
      data: analysisResult,
      devMode: isDevMode
    });
  } catch (error) {
    console.error(`Analysis failed for ${validatedURL}:`, error.message);

    res.status(500).json({
      error: 'Analysis failed',
      message: IS_PRODUCTION
        ? 'An error occurred while analyzing the form. Please try again.'
        : error.message,
      devMode: isDevMode
    });
  }
});

export default router;
