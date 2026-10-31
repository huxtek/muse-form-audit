# HuxTek

Point it at a URL and it tells you whether an AI agent could actually fill out
the forms on that page.

HuxTek loads a page in a real browser, finds every form on it, photographs
each one, and asks a model to score it on structure, field labelling, input
hints, data types, validation, submission behaviour and accessibility. The
output is a per-form report: a score, findings tied to the individual control
they are about, highlighted on a screenshot of the form, and downloadable as a
PDF.

## What it looks at

- **Form discovery** — every `<form>` on the page, plus groups of fields the
  page never wrapped in one. Many modern sites have no `<form>` element at
  all; those are found by clustering the orphan controls and wrapping them.
- **Labelling and identity** — missing or orphaned `<label>`, missing
  `aria-label`, missing `name` and `id`, and accessible names too long to
  serve as a name.
- **What only a picture shows** — whether a label sits next to the control it
  describes, whether related controls are visibly grouped, whether the visual
  order matches the DOM order. The model is sent the form's screenshot
  alongside its markup.
- **What only the browser shows** — declared constraints, the regions waiting
  to announce an error, and what the browser says when those constraints are
  checked. Nothing is ever submitted.
- **Automation blockers** — CAPTCHA, file uploads, multi-step flows,
  client-side validation.
- **A score per form**, with findings split by severity and a recommendation
  for each.

## Project history

### The initial commit

`bce8323` was the scanner extracted from a larger product and published on its
own: a React + Vite front end, an Express backend that loaded pages through a
remote Browserless browser, OpenAI-driven per-form analysis, an SSRF guard on
the target URL, rate limiting, PDF export, a mock mode that runs with no API
keys, and 66 tests.

It found forms by querying `<form>` in the serialised HTML, scored them from
their markup alone, and reported the result as text.

### Added since

Grouped by what changed about the product, not by commit. Fixes are left out;
these are the things that were not there before.

**The analysis model**

- **Meta's Muse (`muse-wonder-1.0`) is now the default analyser**, with OpenAI
  still selectable and a rule-based heuristic as the floor. The provider is
  chosen per scan from the UI, and the report names the model that actually
  answered rather than the one that was requested.
- **Vision analysis.** Each form's screenshot is sent with its HTML, so the
  model can judge what markup cannot express.
- **Patience for a refusing model.** A refused call is retried within a time
  budget instead of being given up on, and the progress line says how long it
  will keep trying.
- **One problem per finding.** The analysis contract asks for each problem as
  its own entry with its own severity, so a control with three faults produces
  three findings rather than one paragraph.

**Visual evidence**

- **Annotated form screenshots.** Every form is photographed and each finding
  is drawn on the control it belongs to, hoverable and pinnable.
- **A clickable map of the whole page.** The full-page screenshot shows every
  form outlined and coloured by its worst finding; selecting one scrolls the
  map to it.
- **A tab per form**, carrying what distinguishes it — hidden, what kind it
  is, what it scored — so reaching a form is not a hunt across a screenshot.
- **The findings list and the picture share a selection**, so hovering one
  highlights the other.

**Form discovery**

- **Forms inferred on pages that never used a `<form>` tag**, by clustering
  controls the page left loose and wrapping them in the live DOM, so the HTML
  extractor, the geometry pass and the pairing between them all agree.
- **Forms that are in the markup but not on screen are kept and labelled**,
  with the mechanism that hides them named — `display:none` on an ancestor, or
  `visibility:hidden`, or simply no size. A sign-in form behind a menu still
  matters to an agent.

**Saying only what is true**

A recurring theme, because the worst thing this tool can do is present a fact
about itself as a finding about the page.

- **A site that refuses us is reported as a refusal**, with the gatekeeper
  named, instead of as a page with no forms. Covers refusal statuses and
  challenge pages served with a success status.
- **A page that could not be read fails the scan.** Zero characters of HTML is
  never reported as a form-free page.
- **The form image says what it is not showing.** A finding can only be drawn
  on a control that has a box, so the ones that cannot be drawn are listed
  with their severities and the reason — not rendered, or on the page but with
  no name or id, or named by the analyser and not found at all.
- **The page map does not invent positions.** A form with no size is not
  outlined, and the count beside the map accounts for the difference.

**Getting to the right page at all**

- **A website typed without a scheme is accepted.** `aa.com` is how people
  name a site; it is completed to https by both the browser and the API, while
  anything already carrying a scheme is matched against http and https and
  refused otherwise.
- **The page is waited for in a way that arrives.** Navigation settles on the
  parsed document and then waits a bounded time for a field to appear, rather
  than requiring the network to fall silent — which on many commercial sites
  never happens.
- **A slow page that rendered is kept.** A navigation timeout no longer
  discards a complete document.
- **The whole page is brought into one frame** for photography, repeatedly if
  growing the viewport makes the page taller, which it does on lazy-loading
  sites.
- **One identity for every request.** The guard's pre-flight and the browser
  send the same User-Agent, because a server that answers them differently
  decides which page gets scanned.

**Running a scan**

- **Scans are stoppable**, with a confirmation first: stopping is not
  reversible and produces no report.
- **A scan has its own address.** `/scan?url=...` is shareable and survives a
  reload, and Back and Forward behave.
- **A sample report needs no URL and no key**, from its own endpoint, labelled
  so it cannot be mistaken for a real audit.
- **The PDF is the same scan the page shows**, down to the score and the
  counts.
- **The interface was audited with the tool itself**, and what that found was
  fixed: real `<label>` associations, grouped options, native controls.

**Deployment**

- Deployable as two pieces: the UI on Netlify, the API on Render, with real
  scans switched on by configuration.

## Architecture

```
┌─────────────────────────┐        ┌──────────────────────────────┐
│  React + Vite frontend  │  HTTP  │  Express scanner backend     │
│  (port 8080)            │ ─────> │  (port 3001)                 │
│                         │  WS    │                              │
│  - scanner UI           │ <───── │  - SSRF-guarded URL intake   │
│  - annotated results    │        │  - rate limiting             │
│  - page map             │        │  - analysis agent            │
│  - PDF report export    │        │  - screenshot store          │
└─────────────────────────┘        └──────────────┬───────────────┘
                                                  │
                                   ┌──────────────▼───────────────┐
                                   │  Muse or OpenAI (analysis)   │
                                   │  Browserless (page loading)  │
                                   └──────────────────────────────┘
```

Screenshots never travel inside the results JSON; they go to an in-memory
store and are served from their own endpoints.

Key directories:

| Path | What lives there |
| --- | --- |
| `src/components/AIScanner.tsx` | The scanner UI: URL input, live progress, results |
| `src/components/FormVisualOverlay.tsx` | A form's screenshot with its findings drawn on it |
| `src/components/PageMapView.tsx` | Full-page screenshot with every form outlined |
| `src/components/FormAnalysisDisplay.tsx` | Per-form report rendering |
| `src/lib/form-purpose.ts` | Describing a form from what was measured |
| `src/lib/target-url.ts` | Turning what someone typed into a URL worth scanning |
| `src/lib/pdf-generator.ts` | PDF export of a completed report |
| `src/lib/scan-types.ts` | TypeScript shapes for the backend's scan results |
| `src/services/api.ts` | The only place the UI talks HTTP to the backend |
| `server/server.js` | API server, job store, WebSocket progress channel |
| `server/agent.js` | The agent that drives analysis of a page |
| `server/improved-agent.js` | Full-site crawl variant |
| `server/tools.js` | Page loading, form extraction, sitemap discovery |
| `server/lib/llm/` | Muse, OpenAI and heuristic providers behind one interface |
| `server/lib/analysis/` | The analysis prompt, the behaviour probe, label handling |
| `server/lib/visuals/` | Geometry, screenshots, page map, form inference |
| `server/lib/botWall.js` | Telling "we were not allowed to look" from "no forms" |
| `server/lib/pageReadiness.js` | When a page is ready, and whether it is worth reading |
| `server/middleware/urlGuard.js` | SSRF guard for user-supplied target URLs |
| `server/middleware/rateLimiting.js` | The four rate limiters |
| `server/mock-data/` | Canned responses so the app runs with zero API keys |
| `tests/` | Vitest suite (client in jsdom, server in node) |

## Prerequisites

- Node.js 20 or newer
- npm

Optional, and only needed for real (non-mock) scans:

- A Muse or OpenAI API key
- A [Browserless](https://browserless.io) token for the headless browser

## Install

```bash
git clone <your-fork-url> huxtek
cd huxtek

# frontend
npm install

# backend
cd server && npm install && cd ..
```

## Environment setup

```bash
cp .env.example .env
```

`.env.example` separates server-only secrets from public `VITE_` variables.
The distinction matters: **Vite inlines every `VITE_`-prefixed variable into
the browser bundle**, so anything with that prefix is published. Keys and
tokens must stay unprefixed.

It covers the settings most deployments need — provider keys, the browser
token, host and port, CORS, the URL guard and the rate limits. A number of
tuning knobs are not in it yet and are documented where they are read:

| Setting | Where it is read | What it tunes |
| --- | --- | --- |
| `NAVIGATION_WAIT_UNTIL`, `NAVIGATION_TIMEOUT_MS`, `FIELD_WAIT_MS`, `CONTENT_SETTLE_MS` | `server/lib/pageReadiness.js` | When a page counts as ready |
| `VISUAL_*` | `server/lib/visuals/captureFormVisuals.js` | Screenshot and page-map limits |
| `INFER_FORM_GROUPS` | `server/lib/visuals/inferFormGroups.js` | Turn form inference off |
| `CRAWLER_USER_AGENT` | `server/lib/userAgent.js` | How the scanner identifies itself |
| `MODEL_HTML_CHAR_LIMIT`, `MODEL_ANALYSIS_MAX_TOKENS` | `server/lib/analysis/modelFormAnalyzer.js` | Prompt size limits |
| `MAX_LABEL_CHARS` | `server/lib/analysis/fieldLabel.js` | When a label is too long to be a name |
| `PROBE_*` | `server/lib/analysis/probeFormBehaviour.js` | Behaviour probe limits |
| `JOB_READ_RATE_LIMIT_*` | `server/middleware/rateLimiting.js` | The polling limiter |

## Run it

Two terminals:

```bash
# terminal 1 — scanner API on http://127.0.0.1:3001
cd server && npm start

# terminal 2 — frontend on http://localhost:8080
npm run dev
```

Then open http://localhost:8080.

`cd server && npm start` and `node server/server.js` from the repository root
are equivalent: the server resolves both `.env` and `server/mock-data/`
relative to its own file, not to the working directory.

## API endpoints

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/health` | Liveness, plus whether a model and the browser are configured |
| `GET` | `/api/config` | Public configuration the UI reads at startup |
| `POST` | `/api/scan` | Starts an asynchronous scan job, returns a `jobId` |
| `GET` | `/api/report/:jobId` | Polls one job: status, progress, and results when finished |
| `POST` | `/api/scan/:jobId/cancel` | Stops a running scan; no report is produced |
| `GET` | `/api/screenshot/:jobId/:formIndex` | One form's annotated screenshot |
| `GET` | `/api/page-map/:jobId/:pageIndex` | The full-page screenshot behind the map |
| `POST` | `/api/demo` | A sample report, with no URL and no key |
| `GET` | `/api/jobs` | Lists the in-memory job records |
| `DELETE` | `/api/job/:jobId` | Drops a job record |
| `POST` | `/api/analyze` | Synchronous single-page analysis |

There is also a WebSocket channel on the same port that pushes live progress
for a subscribed `jobId`.

`POST /api/analyze` works, but the UI does not call it — the scanner goes
through `POST /api/scan` and then polls `/api/report/:jobId`. Job records live
in memory, so they are gone when the server restarts.

## Mock mode: no API keys required

The app ships with canned scan responses so you can exercise the whole flow
without a model key or a browser token. Progress updates over the WebSocket,
the per-form report, the annotated screenshots and the PDF export all work.

How it is wired:

- It is a **client-side** toggle. `DevModeContext` stores it in
  `localStorage` under the key `huxtek-dev-mode`, and it defaults to
  **on** in a dev build (`npm run dev`).
- The header **Dev Mode** toggle flips it. The value is sent as `devMode` in
  the `POST /api/scan` body, and the backend answers from
  `server/mock-data/*.json` instead of calling any provider.
- In a production build the toggle is forced off and is not reachable, so a
  deployed instance cannot serve mock results.
- `MOCK_SCAN_DELAY_MS` (default `4500`) paces the fake progress updates so the
  live WebSocket path behaves like a real scan. Set it to `0` for instant
  completion.

Mock output is labelled so it cannot be mistaken for a real audit: a **Mock
Data** badge and a banner above the results in the UI, and a `MOCK DATA -
sample report, not a real audit` line under the title of the generated PDF.

Turn Dev Mode off to run a real scan, which needs a provider key and
`BROWSERLESS_TOKEN`.

## Security: the server has no authentication

Read this before you deploy anything.

**The scanner backend is unauthenticated by default.** There is no login, no
API key check, and no per-user quota. Anyone who can reach the server can
submit scan requests, and every real scan spends *your* model and Browserless
credits. An exposed instance is a bill waiting to happen.

Until the auth layer lands, run it one of these ways:

- Locally, bound to loopback (the default `HOST=127.0.0.1`).
- Behind a reverse proxy that enforces authentication.
- Inside a private network with no public ingress.

Other controls that *are* in place:

- **SSRF guard** (`server/middleware/urlGuard.js`) — target URLs must be
  `http:` or `https:`; a missing scheme is completed to https, and a scheme
  that is present is never rewritten; hostnames are DNS-resolved and rejected
  if they land in a private or reserved range, including the cloud metadata
  address `169.254.169.254`; `localhost` and `*.localhost` are rejected;
  credentials in a URL are refused; redirects are capped and **re-validated at
  every hop** so an open redirect cannot be used as a bypass; responses have a
  size cap and requests have a timeout. Set `ALLOW_PRIVATE_TARGETS=true` to
  deliberately scan localhost during development — metadata endpoints stay
  blocked regardless.
- **Rate limiting** — enabled in all environments, not just production, with a
  tighter limit on the expensive `/api/scan` path. Defaults: **5 scans per
  300 s**, 100 per 900 s for the rest of `/api`, 900 per 900 s for job polling
  (a long scan is polled dozens of times and used to exhaust the general
  limit), and 30 per 60 s for `/health`. Every window is configurable.
- **CORS allowlist** — origins come from `ALLOWED_ORIGINS`; there is no
  wildcard.
- **Request hardening** — `helmet`, a 100 kB JSON body limit, and no stack
  traces or internal error messages in production responses.

## Build

```bash
npm run build       # production bundle into dist/
npm run typecheck   # tsc --noEmit, app and test projects
npm run lint        # eslint
npm run preview     # serve the built bundle
```

## Testing

```bash
npm test            # 751 tests, one pass
npm run test:watch  # watch mode
```

One Vitest config runs two projects: `tests/client` in jsdom and
`tests/server` in node. Both run from the root install, so there is nothing to
install inside `server/`.

The suite is hermetic — no network, no DNS, and no running server. `dns.lookup`
is mocked and `fetch` is stubbed, so it passes with port 3001 closed.

What it concentrates on, rather than chasing a coverage number:

- The **SSRF guard**, where a silent regression would be expensive.
- The **decisions about whether there is a page worth scanning** — a refusal,
  a challenge page, a navigation timeout that did or did not leave a usable
  document — because each of those has already been reported as "no forms
  found" once.
- **Regression cover for every bug found and fixed**, named in the test with
  the site that produced it, so the test says why it exists.

Code that runs inside the page through `page.evaluate` cannot execute under
node and is not covered by unit tests; it is checked by running real scans.
Form inference is the exception and is driven through jsdom.

## Not included / coming later

This repository is the scanner, and only the scanner. Deliberately absent:

- **Authentication** — no login, signup, sessions, or user accounts.
- **Subscriptions and billing** — no plans, quotas, payment provider, or
  usage metering.

Both were stripped out so the scanner could be published on its own. The seams
are left clean: `src/services/api.ts` is where a request token would be
attached, and `server/server.js` is where auth middleware would slot in ahead
of the scan routes.

Also worth knowing:

- Scan jobs and screenshots are held in memory; there is no database and no
  persistence. Jobs expire on a TTL (30 minutes by default, 100 at most, swept
  every 60 s); screenshots are evicted oldest-first against a byte budget
  (150 MB by default) rather than on a clock.
- `app.set('trust proxy', 1)` is wrong for a platform that adds more than one
  hop. Behind such a proxy the limiter sees the proxy's address rather than the
  client's, which makes every rate limit global instead of per-IP. Set it to
  the real number of hops before relying on per-client limits in production.
- The crawler loads pages through a remote Browserless browser via
  `puppeteer.connect()`. Redirects followed *inside* that remote browser are
  not re-validated by the URL guard. That is safe while the browser is remote,
  but anyone switching to a local `puppeteer.launch()` must add per-hop
  validation inside the browser.
- Forms inside a shadow root or an iframe are not found. The field selectors do
  not cross either boundary.
- `npm audit` reports open advisories in both dependency trees. Every one needs
  a major-version bump, so none have been applied.

## License

MIT. See [LICENSE](./LICENSE).
