# Muse Form Audit

Point it at a URL and it tells you whether an AI agent could actually fill out
the forms on that page.

Muse Form Audit crawls a page (or a whole site), extracts every form it can
find, and runs each one through an LLM-driven analysis that scores it on
structure, field labelling, input hints, data types, validation, submission
behaviour, and accessibility. The output is a per-form report with concrete
issues and recommendations, downloadable as a PDF.

## What it looks at

- **Form detection** — finds forms and their fields (inputs, textareas, selects,
  buttons) along with form-level attributes like `action` and `method`.
- **Labelling and ARIA** — missing `aria-label`, missing or orphaned `<label>`,
  missing `name` attributes.
- **Automation blockers** — CAPTCHA of various flavours, file upload fields,
  multi-step flows, custom client-side validation.
- **AI compatibility score** — a numeric score per form plus a breakdown of
  critical versus partial blockers.
- **Recommendations** — actionable suggestions rather than just a pass/fail.

## Architecture

```
┌─────────────────────────┐        ┌──────────────────────────────┐
│  React + Vite frontend  │  HTTP  │  Express scanner backend     │
│  (port 8080)            │ ─────> │  (port 3001)                 │
│                         │  WS    │                              │
│  - scanner UI           │ <───── │  - SSRF-guarded URL intake   │
│  - live progress        │        │  - rate limiting             │
│  - PDF report export    │        │  - LLM analysis agent        │
└─────────────────────────┘        └──────────────┬───────────────┘
                                                  │
                                   ┌──────────────▼───────────────┐
                                   │  OpenAI (analysis)           │
                                   │  Browserless (page loading)  │
                                   └──────────────────────────────┘
```

Key directories:

| Path | What lives there |
| --- | --- |
| `src/components/AIScanner.tsx` | The scanner UI: URL input, live progress, results |
| `src/components/FormAnalysisDisplay.tsx` | Per-form report rendering |
| `src/lib/pdf-generator.ts` | PDF export of a completed report |
| `src/lib/scan-types.ts` | TypeScript shapes for the backend's scan results |
| `src/services/api.ts` | The only place the UI talks HTTP to the backend |
| `server/server.js` | API server, job store, WebSocket progress channel |
| `server/agent.js` | LLM agent that drives analysis of a single page |
| `server/improved-agent.js` | Full-site crawl variant |
| `server/tools.js` | Page fetching, form extraction, sitemap discovery |
| `server/routes/analyze.js` | The synchronous `POST /api/analyze` route |
| `server/middleware/urlGuard.js` | SSRF guard for user-supplied target URLs |
| `server/middleware/rateLimiting.js` | The three rate limiters |
| `server/mock-data/` | Canned responses so the app runs with zero API keys |
| `tests/` | Vitest suite (client in jsdom, server in node) |

## Prerequisites

- Node.js 20 or newer
- npm

Optional, and only needed for real (non-mock) scans:

- An OpenAI API key
- A [Browserless](https://browserless.io) token for the headless browser

## Install

```bash
git clone <your-fork-url> muse-form-audit
cd muse-form-audit

# frontend
npm install

# backend
cd server && npm install && cd ..
```

## Environment setup

```bash
cp .env.example .env
```

`.env.example` documents every variable the app reads and separates
server-only secrets from public `VITE_` variables. The distinction matters:
**Vite inlines every `VITE_`-prefixed variable into the browser bundle**, so
anything with that prefix is published. Keys and tokens must stay unprefixed.

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

The backend exposes exactly these:

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/health` | Liveness, plus whether OpenAI and the browser are configured |
| `POST` | `/api/scan` | Starts an asynchronous scan job, returns a `jobId` |
| `GET` | `/api/report/:jobId` | Polls one job: status, progress, and results when finished |
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
without an OpenAI key or a browser token. Progress updates over the WebSocket,
the per-form report, and the PDF export all work.

How it is wired:

- It is a **client-side** toggle. `DevModeContext` stores it in
  `localStorage` under the key `muse-form-audit-dev-mode`, and it defaults to
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

Turn Dev Mode off to run a real scan, which requires `OPENAI_API_KEY` and
`BROWSERLESS_TOKEN`.

## Security: the server has no authentication

Read this before you deploy anything.

**The scanner backend is unauthenticated by default.** There is no login, no
API key check, and no per-user quota. Anyone who can reach the server can
submit scan requests, and every real scan spends *your* OpenAI and Browserless
credits. An exposed instance is a bill waiting to happen.

Until the auth layer lands, run it one of these ways:

- Locally, bound to loopback (the default `HOST=127.0.0.1`).
- Behind a reverse proxy that enforces authentication.
- Inside a private network with no public ingress.

Other controls that *are* in place:

- **SSRF guard** (`server/middleware/urlGuard.js`) — target URLs must be
  `http:` or `https:`; hostnames are DNS-resolved and rejected if they land in
  a private or reserved range, including the cloud metadata address
  `169.254.169.254`; `localhost` and `*.localhost` are rejected; redirects are
  capped and **re-validated at every hop** so an open redirect can't be used as
  a bypass; responses have a size cap and requests have a timeout. Set
  `ALLOW_PRIVATE_TARGETS=true` to deliberately scan localhost during
  development — metadata endpoints stay blocked regardless.
- **Rate limiting** — enabled in all environments, not just production, with a
  tighter limit on the expensive `/api/scan` path: **5 requests per 300 s per
  IP** for scans, 100 per 900 s for the rest of `/api`, and 30 per 60 s for
  `/health`. All four windows are configurable in `.env`.
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
npm test            # 66 tests, one pass
npm run test:watch  # watch mode
```

One Vitest config runs two projects: `tests/client` in jsdom and
`tests/server` in node. Both run from the root install, so there is nothing to
install inside `server/`.

The suite is hermetic — no network, no DNS, and no running server. `dns.lookup`
is mocked and `fetch` is stubbed, so it passes with port 3001 closed.

It is not broad coverage, and does not try to be. It concentrates on the two
places where a silent regression would be expensive: the SSRF guard
(`server/middleware/urlGuard.js`, 24 tests), and regression cover for bugs that
were already found and fixed once — the PDF executive summary reading the wrong
field, polling that never stops, and mock results rendering without a mock
label.

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

- Scan jobs are held in memory. There is no database and no persistence.
- The crawler loads pages through a remote Browserless browser via
  `puppeteer.connect()`. Redirects followed *inside* that remote browser are
  not re-validated by the URL guard. That is safe while the browser is remote,
  but anyone switching to a local `puppeteer.launch()` must add per-hop
  validation inside the browser.
- `npm audit` reports open advisories in both dependency trees. Every one needs
  a major-version bump, so none have been applied; see
  `.agents/tasks/housekeeping-report.md` for the triage.

## License

MIT. See [LICENSE](./LICENSE).
