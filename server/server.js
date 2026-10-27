import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env') });

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { v4 as uuidv4 } from 'uuid';
import { AIAgent } from './agent.js';
import { rewriteOrigin } from './lib/rewriteOrigin.js';
import {
  getPageMap,
  getScreenshot,
  putPageMap,
  putScreenshot,
  screenshotStoreStats
} from './lib/visuals/screenshotStore.js';
import {
  SAMPLE_FIELD_ISSUES,
  SAMPLE_FORM_IMAGE,
  SAMPLE_PAGE_IMAGE,
  sampleFormVisual
} from './lib/visuals/sampleFormVisual.js';
import { getFixtureHostname, rewriteProseHostDeep } from './lib/rewriteProseHost.js';
import { ImprovedFullCrawlAgent } from './improved-agent.js';
import {
  createLlmProvider,
  describeProviders,
  isValidProvider,
  resolveProviderName
} from './lib/llm/index.js';

/** Which env var each provider needs, for the startup banner only. */
const MODEL_ENV_VARS = { heuristic: null, muse: 'MODEL_API_KEY', openai: 'OPENAI_API_KEY' };
import analyzeRoutes from './routes/analyze.js';
import { validateURLMiddleware, getUrlGuardConfig } from './middleware/validation.js';
import {
  generalApiLimiter,
  scanLimiter,
  publicLimiter,
  rateLimitInfo
} from './middleware/rateLimiting.js';

const PORT = Number.parseInt(process.env.PORT ?? '3001', 10);
const HOST = process.env.HOST || '127.0.0.1';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || '100kb';
const SCAN_TIER = process.env.SCAN_TIER || 'premium';
const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:8080', 'http://127.0.0.1:8080'];
// Total wall-clock time a mock scan spends in `running` before completing.
// Small by default so the zero-config path stays snappy; 0 completes instantly.
const MOCK_SCAN_DELAY_MS = Math.max(
  0,
  Number.parseInt(process.env.MOCK_SCAN_DELAY_MS ?? '4500', 10) || 0
);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const originAllowlist = allowedOrigins.length > 0 ? allowedOrigins : DEFAULT_ALLOWED_ORIGINS;

const mockFullCrawlResponse = JSON.parse(
  readFileSync(path.join(__dirname, 'mock-data', 'full-crawl-response.json'), 'utf8')
);
const mockSinglePageResponse = JSON.parse(
  readFileSync(path.join(__dirname, 'mock-data', 'single-page-response.json'), 'utf8')
);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
  })
);

app.set('trust proxy', 1);

// Origin allowlist. Add deployment origins via ALLOWED_ORIGINS (comma separated).
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || originAllowlist.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('Origin not allowed by CORS'));
    },
    credentials: false,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Accept', 'Origin'],
    maxAge: 86400
  })
);

app.use(morgan(IS_PRODUCTION ? 'combined' : 'dev'));
app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: JSON_BODY_LIMIT }));
app.use(rateLimitInfo);

// In-memory job store. Swap for a shared store if you run more than one process.
const jobs = new Map();
const agents = new Map();

// =============================================================================
// HEALTH
// =============================================================================

app.get('/health', publicLimiter, (req, res) => {
  res.json({
    status: 'healthy',
    service: 'muse-form-audit-server',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    uptime: process.uptime(),
    services: {
      // Presence only. Never report key material.
      browser: process.env.BROWSERLESS_TOKEN ? 'configured' : 'not configured'
    },
    models: {
      default: resolveProviderName(),
      providers: describeProviders()
    },
    urlGuard: {
      allowPrivateTargets: getUrlGuardConfig().allowPrivateTargets
    }
  });
});

// =============================================================================
// WEBSOCKET
// =============================================================================

wss.on('connection', (ws) => {
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.type === 'subscribe' && data.jobId) {
        ws.jobId = data.jobId;
        ws.send(
          JSON.stringify({
            type: 'subscribed',
            jobId: data.jobId,
            message: 'Successfully subscribed to job updates'
          })
        );
      }

      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
      }
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
  });
});

function broadcastUpdate(jobId, update) {
  wss.clients.forEach((client) => {
    if (client.jobId === jobId && client.readyState === 1) {
      client.send(JSON.stringify(update));
    }
  });
}

// =============================================================================
// MOCK SCAN
// =============================================================================

/** Deep-clone a fixture and re-point every URL it carries at the submitted site. */
function buildMockResponse(fixture, jobId, validatedURL, fullCrawl) {
  const now = new Date().toISOString();
  // Read before the spread below overwrites `url` with the submitted target.
  const fixtureHostname = getFixtureHostname(fixture);
  const mockResponse = {
    ...structuredClone(fixture),
    id: jobId,
    jobId,
    url: validatedURL,
    fullCrawl,
    devMode: true,
    createdAt: now,
    timestamp: now
  };

  const toSubmittedOrigin = (value) =>
    typeof value === 'string' ? rewriteOrigin(value, validatedURL) : value;

  if (mockResponse.results) {
    const { results } = mockResponse;

    if (results.targetUrl) results.targetUrl = toSubmittedOrigin(results.targetUrl);
    if (results.url) results.url = toSubmittedOrigin(results.url);
    if (results.pageUrl) results.pageUrl = toSubmittedOrigin(results.pageUrl);
    if (results.metadata?.targetUrl) {
      results.metadata.targetUrl = toSubmittedOrigin(results.metadata.targetUrl);
    }
    if (results.summary?.targetUrl) {
      results.summary.targetUrl = toSubmittedOrigin(results.summary.targetUrl);
    }

    for (const key of ['discoveredUrls', 'visitedUrls']) {
      if (Array.isArray(results[key])) {
        results[key] = results[key].map(toSubmittedOrigin);
      }
      if (Array.isArray(results.summary?.[key])) {
        results.summary[key] = results.summary[key].map(toSubmittedOrigin);
      }
    }

    if (Array.isArray(results.forms)) {
      results.forms.forEach((form) => {
        if (form.url) form.url = toSubmittedOrigin(form.url);
        if (form.pageUrl) form.pageUrl = toSubmittedOrigin(form.pageUrl);
      });
    }
  }

  if (mockResponse.formData) {
    const { formData } = mockResponse;
    if (formData.pageUrl) formData.pageUrl = toSubmittedOrigin(formData.pageUrl);
    if (formData.analysis?.url) {
      formData.analysis.url = toSubmittedOrigin(formData.analysis.url);
    }
  }

  // Catch the fixture host wherever it survives the structured pass above:
  // inside prose (`aiSummary`), inside page titles held as hidden field values,
  // and in any URL-bearing field not enumerated here. The structured fields are
  // already on the submitted origin, so this cannot touch them twice.
  rewriteProseHostDeep(mockResponse, fixtureHostname, validatedURL);

  attachSampleVisuals(mockResponse, jobId);

  return mockResponse;
}

/**
 * Gives every mock form the bundled sample screenshot and matching per-field
 * findings, so the visual tab works on the zero-key Dev Mode path with no
 * browser and no network.
 */
function attachSampleVisuals(mockResponse, jobId) {
  const forms = mockResponse?.results?.forms;
  if (!Array.isArray(forms)) {
    return;
  }

  forms.forEach((form, index) => {
    form.visual = sampleFormVisual(index);
    form.accessibility = form.accessibility || {};
    // Only synthesise findings when the fixture has none, so a fixture that
    // grows its own field issues later wins.
    if (!Array.isArray(form.accessibility.fieldIssues) || form.accessibility.fieldIssues.length === 0) {
      form.accessibility.fieldIssues = SAMPLE_FIELD_ISSUES;
    }

    putScreenshot(jobId, index, { buffer: SAMPLE_FORM_IMAGE, contentType: 'image/png' });
    putPageMap(jobId, form.visual.pageMap.pageIndex, {
      buffer: SAMPLE_PAGE_IMAGE,
      contentType: 'image/png'
    });
  });
}

/**
 * Progress timeline for a mock scan, as `[fractionOfTotalDelay, update]` pairs.
 * Mirrors the update types the real agents emit (`forms_discovered`,
 * `form_analyzed`) so the live-progress WebSocket path is actually exercised.
 */
function buildMockTimeline(mockResponse, fullCrawl) {
  const forms = Array.isArray(mockResponse.results?.forms) ? mockResponse.results.forms : [];
  const formsCount = forms.length;
  const totalPages = mockResponse.results?.summary?.totalPages ?? 1;
  const midpointForm = Math.max(1, Math.ceil(formsCount / 2));

  return [
    [
      0.12,
      {
        type: 'progress',
        status: 'running',
        progress: 15,
        currentStep: fullCrawl ? 'Discovering pages from sitemap...' : 'Loading target page...'
      }
    ],
    [
      0.3,
      {
        type: 'progress',
        status: 'running',
        progress: 35,
        currentStep: fullCrawl ? `Crawling ${totalPages} discovered pages...` : 'Extracting forms...'
      }
    ],
    [
      0.48,
      {
        type: 'forms_discovered',
        status: 'running',
        progress: 50,
        formsCount,
        formsFound: formsCount,
        currentStep: `Discovered ${formsCount} form${formsCount === 1 ? '' : 's'}`
      }
    ],
    [
      0.66,
      {
        type: 'form_analyzed',
        status: 'running',
        progress: 70,
        formsFound: formsCount,
        formsAnalyzed: midpointForm,
        formData: { formIndex: midpointForm, totalForms: formsCount },
        currentStep: `Analyzing form ${midpointForm} of ${formsCount}`
      }
    ],
    [
      0.84,
      {
        type: 'form_analyzed',
        status: 'running',
        progress: 88,
        formsFound: formsCount,
        formsAnalyzed: formsCount,
        formData: { formIndex: formsCount, totalForms: formsCount },
        currentStep: `Analyzing form ${formsCount} of ${formsCount}`
      }
    ],
    [
      1,
      {
        type: 'progress',
        status: 'completed',
        progress: 100,
        formsFound: formsCount,
        formsAnalyzed: formsCount,
        currentStep: fullCrawl
          ? `Full crawl completed! Analyzed ${formsCount} forms across ${totalPages} pages.`
          : `Per-form analysis completed - all ${formsCount} forms analyzed`,
        results: mockResponse.results,
        formData: mockResponse.formData ?? null
      }
    ]
  ];
}

/**
 * Apply a mock timeline to the job store and broadcast each step. With
 * MOCK_SCAN_DELAY_MS=0 every step lands synchronously, so the first poll sees
 * a completed job (the original instant-success behaviour).
 */
function runMockTimeline(jobId, timeline) {
  const apply = (update) => {
    const currentJob = jobs.get(jobId);
    if (!currentJob) return;

    Object.assign(currentJob, update);
    jobs.set(jobId, currentJob);
    broadcastUpdate(jobId, { jobId, ...update });
  };

  if (MOCK_SCAN_DELAY_MS === 0) {
    timeline.forEach(([, update]) => apply(update));
    return;
  }

  timeline.forEach(([fraction, update]) => {
    setTimeout(() => apply(update), Math.round(fraction * MOCK_SCAN_DELAY_MS));
  });
}

// =============================================================================
// SCAN
// =============================================================================

app.use('/api', generalApiLimiter);
app.use('/api', analyzeRoutes);

app.post('/api/scan', scanLimiter, validateURLMiddleware, async (req, res) => {
  try {
    const { fullCrawl = false, devMode = false, modelProvider } = req.body;
    const validatedURL = req.validatedURL;
    const jobId = uuidv4();

    // Untrusted input: only an allowlisted provider name is honoured, anything
    // else falls back to the server default.
    const providerName = resolveProviderName(
      isValidProvider(modelProvider) ? modelProvider : undefined
    );
    const provider = createLlmProvider(providerName);

    const job = {
      id: jobId,
      url: validatedURL,
      fullCrawl,
      modelProvider: providerName,
      modelLabel: provider.label,
      model: provider.model,
      status: 'queued',
      createdAt: new Date().toISOString(),
      progress: 0,
      currentStep: 'Initializing...',
      results: null,
      error: null,
      formsAnalyzed: 0,
      formsFound: 0
    };

    jobs.set(jobId, job);

    if (devMode) {
      const fixture = fullCrawl ? mockFullCrawlResponse : mockSinglePageResponse;
      const mockResponse = buildMockResponse(fixture, jobId, validatedURL, fullCrawl);

      // Start in `running` with no results yet, so the client opens its
      // progress WebSocket and walks the timeline exactly as a real scan does.
      Object.assign(job, mockResponse, {
        status: 'running',
        progress: 0,
        currentStep: 'Starting scan...',
        results: null,
        formData: null,
        formsFound: 0,
        formsAnalyzed: 0
      });
      jobs.set(jobId, job);

      runMockTimeline(jobId, buildMockTimeline(mockResponse, fullCrawl));

      res.json({
        success: true,
        jobId,
        message: `Mock ${fullCrawl ? 'full crawl' : 'single page'} scan initiated`,
        websocket_url: `ws://${HOST}:${PORT}`,
        devMode: true,
        modelProvider: providerName,
        modelLabel: provider.label,
        model: provider.model
      });
      return;
    }

    const AgentClass = fullCrawl ? ImprovedFullCrawlAgent : AIAgent;
    const agent = new AgentClass(jobId, validatedURL, fullCrawl, SCAN_TIER, (update) => {
      const currentJob = jobs.get(jobId);
      if (!currentJob) return;

      Object.assign(currentJob, update);

      if (update.type === 'form_analyzed') {
        currentJob.formsAnalyzed = update.formsAnalyzed || (currentJob.formsAnalyzed || 0) + 1;
      }

      if (update.type === 'forms_discovered' && update.formsCount) {
        currentJob.formsFound = update.formsCount;
      }

      jobs.set(jobId, currentJob);

      broadcastUpdate(jobId, {
        type: 'progress',
        jobId,
        ...update,
        formsAnalyzed: currentJob.formsAnalyzed || 0,
        formsFound: currentJob.formsFound || 0
      });
    }, providerName);

    agents.set(jobId, agent);

    const scanMethod = fullCrawl ? 'startScan' : 'startPerFormScan';
    agent[scanMethod]().catch((error) => {
      console.error(`Scan failed for job ${jobId}:`, error.message);
      const currentJob = jobs.get(jobId);
      if (currentJob) {
        currentJob.status = 'failed';
        currentJob.error = IS_PRODUCTION ? 'Scan failed' : error.message;
        jobs.set(jobId, currentJob);
      }

      broadcastUpdate(jobId, {
        type: 'error',
        jobId,
        status: 'failed',
        error: IS_PRODUCTION ? 'Scan failed' : error.message
      });
    });

    res.json({
      success: true,
      jobId,
      message: 'Scan initiated successfully',
      websocket_url: `ws://${HOST}:${PORT}`,
      modelProvider: providerName,
      modelLabel: provider.label,
      model: provider.model
    });
  } catch (error) {
    console.error('Scan initiation error:', error.message);
    res.status(500).json({
      error: 'Failed to initiate scan',
      message: IS_PRODUCTION ? 'Failed to initiate scan' : error.message
    });
  }
});

/**
 * Serves one captured form screenshot. The bytes are held in process memory
 * rather than inlined into the scan results, so polling stays small.
 */
app.get('/api/screenshot/:jobId/:formIndex', (req, res) => {
  const { jobId, formIndex } = req.params;

  if (!jobs.has(jobId)) {
    res.status(404).json({ error: 'Not Found', message: 'Unknown job' });

    return;
  }

  const index = Number.parseInt(formIndex, 10);
  if (!Number.isInteger(index) || index < 0) {
    res.status(400).json({ error: 'Bad Request', message: 'formIndex must be a non-negative integer' });

    return;
  }

  const image = getScreenshot(jobId, index);
  if (!image) {
    res.status(404).json({ error: 'Not Found', message: 'No screenshot for that form' });

    return;
  }

  res.set('Content-Type', image.contentType);
  res.set('Content-Length', String(image.byteLength));
  // Immutable for the life of the job; jobs are in-memory and never reused.
  res.set('Cache-Control', 'private, max-age=3600');
  // helmet defaults Cross-Origin-Resource-Policy to same-origin, which blocks
  // the browser from rendering this image when the UI is served from a
  // different port. Relaxed for this endpoint only; access is still gated by
  // the unguessable job id and the CORS allowlist.
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  res.send(image.buffer);
});

/**
 * Serves the whole-page map for one scanned page. JPEG; used as a navigation
 * aid with each analysed form outlined on it.
 */
app.get('/api/page-map/:jobId/:pageIndex', (req, res) => {
  const { jobId, pageIndex } = req.params;

  if (!jobs.has(jobId)) {
    res.status(404).json({ error: 'Not Found', message: 'Unknown job' });

    return;
  }

  const index = Number.parseInt(pageIndex, 10);
  if (!Number.isInteger(index) || index < 0) {
    res.status(400).json({ error: 'Bad Request', message: 'pageIndex must be a non-negative integer' });

    return;
  }

  const image = getPageMap(jobId, index);
  if (!image) {
    res.status(404).json({ error: 'Not Found', message: 'No page map for that page' });

    return;
  }

  res.set('Content-Type', image.contentType);
  res.set('Content-Length', String(image.byteLength));
  res.set('Cache-Control', 'private, max-age=3600');
  // See the screenshot endpoint: helmet's same-origin default would stop the
  // browser rendering this when the UI is served from another port.
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  res.send(image.buffer);
});

app.get('/api/report/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  res.json(job);
});

app.get('/api/jobs', (req, res) => {
  const jobList = Array.from(jobs.values()).map((job) => ({
    id: job.id,
    url: job.url,
    status: job.status,
    progress: job.progress,
    createdAt: job.createdAt,
    currentStep: job.currentStep
  }));

  res.json({ jobs: jobList, total: jobList.length, active_agents: agents.size });
});

app.delete('/api/job/:jobId', (req, res) => {
  const { jobId } = req.params;
  const agent = agents.get(jobId);

  if (agent) {
    agent.stop();
    agents.delete(jobId);
  }

  const jobExists = jobs.has(jobId);
  jobs.delete(jobId);

  if (jobExists) {
    res.json({ success: true, message: 'Job cancelled and removed' });
  } else {
    res.status(404).json({ error: 'Job not found' });
  }
});

// =============================================================================
// ERROR HANDLING
// =============================================================================

app.use((error, req, res, next) => {
  if (error.message === 'Origin not allowed by CORS') {
    res.status(403).json({
      error: 'Forbidden',
      message: 'Origin not allowed. Add it to ALLOWED_ORIGINS.',
      timestamp: new Date().toISOString()
    });
    return;
  }

  console.error('Server error:', error.message);

  res.status(error.status || 500).json({
    error: 'Internal Server Error',
    // Never leak stack traces or internal messages in production.
    message: IS_PRODUCTION ? 'Something went wrong' : error.message,
    timestamp: new Date().toISOString()
  });
});

app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.originalUrl} not found`,
    timestamp: new Date().toISOString()
  });
});

// =============================================================================
// START
// =============================================================================

server.listen(PORT, HOST, () => {
  console.log('Muse Form Audit server ready');
  console.log(`  listening on     http://${HOST}:${PORT}`);
  console.log(`  environment      ${process.env.NODE_ENV || 'development'}`);
  console.log(`  health check     http://${HOST}:${PORT}/health`);
  console.log(`  allowed origins  ${originAllowlist.join(', ')}`);
  console.log(`  default analysis ${resolveProviderName()}`);
  Object.entries(describeProviders()).forEach(([name, info]) => {
    const status = info.configured
      ? 'ready'
      : `missing ${MODEL_ENV_VARS[name] ?? 'credentials'}`;
    console.log(`    ${name.padEnd(11)}${status.padEnd(26)} (${info.model})`);
  });
  console.log(`  browser token    ${process.env.BROWSERLESS_TOKEN ? 'configured' : 'missing (use mock mode)'}`);
  console.log(`  mock scan delay  ${MOCK_SCAN_DELAY_MS}ms`);
  console.log('  NOTE: this server has no authentication. Do not expose it publicly.');
});

export default app;
