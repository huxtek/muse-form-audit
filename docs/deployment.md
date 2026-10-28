# Deployment

Two pieces, two places.

| | where | why |
| --- | --- | --- |
| UI (`dist/`) | Netlify, `huxtek.netlify.app` | static bundle; a CDN absorbs traffic and there is no origin to attack |
| API (`server/`) | Render free web service, `huxtek-api.onrender.com` | needs a persistent process |

The API cannot be serverless. `server/server.js` keeps jobs in a plain
in-memory `Map`, so a scan started in one invocation is invisible to the poll
that follows if that lands elsewhere, and the WebSocket server is attached to
the HTTP server. Both need one long-lived process.

It does **not** need Docker or Chrome. `server/tools.js` calls
`puppeteer.connect()` against Browserless over a WebSocket rather than
`puppeteer.launch()`, so the browser is a remote service and this is a plain
Node app. That is why `render.yaml` uses Render's native Node runtime: fewer
moving parts, and the build is reproducible on a machine with no Docker.

## Free-tier limits worth knowing

- **Spin-down after 15 minutes idle**, ~1 minute to wake. HTTP requests and
  WebSocket messages both count as traffic. **Wake the service a few minutes
  before demoing**, or the first visitor waits a minute and concludes it is
  broken.
- **750 instance-hours per month per workspace.** A month is ~730 hours, so
  keeping it awake around the clock consumes essentially the whole allowance.
  Do not add a keep-alive pinger.
- **5GB bandwidth per month** (reduced from 100GB in April 2026). JSON is
  negligible; `/api/screenshot` serves PNGs, so that is where it goes.
- **512MB RAM.** Measured at 70MB resident on boot. `SCREENSHOT_STORE_MAX_BYTES`
  is set to 60MB rather than its 150MB default to keep headroom.
- **In-memory jobs are lost on spin-down.** Harmless by design: `/scan` is
  keyed on the scanned URL, not a job id, so a cold load shows the prefilled
  form rather than a broken report.
- Without a card on file, exceeding limits **suspends** the service rather
  than billing.

## First deploy

### 1. API on Render

1. Render dashboard → **New** → **Blueprint**, point it at
   `github.com/huxtek/muse-form-audit`. It reads `render.yaml`.
2. It will prompt for the two secrets marked `sync: false`:
   - `BROWSERLESS_TOKEN`
   - `MODEL_API_KEY`
   Paste them in the dashboard. They are stored encrypted and are not in the
   repo.
3. Deploy. Health check is `GET /health`.
4. Confirm:
   ```
   curl https://huxtek-api.onrender.com/health
   curl https://huxtek-api.onrender.com/api/config
   ```
   `/api/config` should report `"realScansEnabled": false`.

### 2. UI on Netlify

1. Netlify → **Add new site** → **Import from Git** → the same repo. It reads
   `netlify.toml`: build `npm run build`, publish `dist`.
2. Rename the site to `huxtek` so it serves `huxtek.netlify.app`. This must
   match `ALLOWED_ORIGINS` in `render.yaml` or the browser's calls fail CORS.
3. Deploy, then open `https://huxtek.netlify.app/scan?url=demo`. The sample
   report should load end to end.

`VITE_API_BASE_URL` is set in `netlify.toml`, not in the dashboard, so the
value that gets compiled in is visible in the repo. Nothing secret may go
there: Vite inlines every `VITE_` variable into the published JavaScript.

## Turning real scans on for the demo

One setting, server-side:

```
Render dashboard -> huxtek-api -> Environment -> ENABLE_REAL_SCANS = true -> Save
```

A rolling restart takes about 30 seconds. **No UI rebuild and no Netlify
deploy.** The browser reads `/api/config` at runtime and the demo-mode notice
disappears on next load.

To turn it off again, set it back to `false`.

Why it is built this way, and not as a `VITE_` flag:

- `/api/scan` is public and callable directly, so hiding the control in the UI
  would not prevent a real scan. The API has to refuse it, and it does, with
  `403 REAL_SCANS_DISABLED`.
- Vite inlines its variables at build time. A build-time flag would make
  "enable real scans" mean "rebuild and redeploy the front end", which is not
  something to be doing minutes before presenting.

Mock scans are never gated. They read fixtures, reach no third party and cost
nothing, so `/api/demo` works regardless.

## What is exposed, and what guards it

The API is **unauthenticated**. Anyone who finds the URL can call it. With
`ENABLE_REAL_SCANS=false` the only thing they can reach is the bundled sample,
which costs nothing. With it on, they can ask the service to fetch arbitrary
public URLs using a real browser, and that traffic is attributable to your
Browserless account.

What stands in the way:

- `server/middleware/urlGuard.js` resolves every hostname and rejects private,
  loopback, link-local and reserved ranges, blocks cloud metadata endpoints
  unconditionally, refuses embedded credentials and non-HTTP schemes, blocks a
  list of service ports, and re-validates every redirect hop so an open
  redirect cannot bypass the checks.
- Rate limits: 3 scans per 5 minutes and 60 `/api` requests per 15 minutes per
  IP. In-process, so they reset on restart.
- `trust proxy` is `1`, correct for exactly one proxy in front. Adding a second
  (a CDN in front of Render, say) would make the limiter key on the wrong
  address — either everyone shares one bucket or the limits become spoofable.

There is no global ceiling, only per-IP, so a distributed script would walk
past the limits. The hard stop is the provider-side cap on the Muse account.

## Verifying a change before deploying

```
bash .agents/tasks/verify-render-build.sh
```

Stages only git-tracked files into a temp directory, runs `npm ci --omit=dev`
and `npm start` with Render's environment and no `.env`, then checks the health
endpoint, the 0.0.0.0 bind, the demo gate, the CORS allowlist, resident memory
and the log for leaked secrets.

It earns its keep: on first run it caught `server/lib/jobRetention.js` being
untracked, which would have deployed a tree missing a module and crashed the
service on boot with `ERR_MODULE_NOT_FOUND`.
