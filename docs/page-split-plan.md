# Planned: split `/` and `/scan` into separate pages

Deferred until after the demo. Written down now so the reasoning survives.

## Why

`/` and `/scan` currently render the same element, so they show identical
content. The landing page is selling the idea; the scan page should not be.
Someone who reaches `/scan` has either submitted a URL or followed a link, so
they already know roughly what this is. The pitch is wasted space at best and
noise at worst.

## Target shape

| | `/` | `/scan` |
| --- | --- | --- |
| Headline | Can an AI agent fill in your form? | Which form should I look at? |
| Scan form | yes | yes (same component) |
| Illustration + "What you get" panel | yes | no |
| Three outcome cards | yes | no |
| Report | no | yes |
| Sample report entry | panel button | nothing — see note |

The scan page would otherwise look sparse with only a field on it, so it needs
a little furniture: a way back to the home page, and probably a short line
about what it needs (a page URL that contains a form). Decide the rest when
the page is on screen.

## The constraint that drives the work

Two distinct page components **remount** on navigation. Measured with a probe:
`/` -> `/scan` with `<HomePage/>` and `<ScanPage/>` gave **2 mounts and the
scan state gone**. React Router reconciles by element type, so today's
same-element-at-both-paths arrangement survives the navigation; two different
components do not, and the scan dies the instant we navigate to show it.

So the split is blocked on hoisting the scan lifecycle above `<Routes>`. That
is the actual work. The page split itself is cosmetic by comparison.

## Proposed structure

- `src/contexts/ScanContext.tsx` — job, target, `isStarting`, start, polling,
  the WebSocket. Mounted above `<Routes>`, so a running scan does not care
  which page is on screen.
- `src/components/ScanForm.tsx` — the `<form>`: URL field, options in
  `<details>`, submit button. **One component, used by both pages.**
- `src/components/ScanResults.tsx` — everything that renders a report.
  `/scan` only.
- `src/pages/Index.tsx` — landing copy, `ScanForm`, illustration and panel,
  outcome cards.
- `src/pages/Scan.tsx` — its own headline, `ScanForm`, `ScanResults`.

### `ScanForm` must be shared, not copied

This is the part to get right. That form is the agent-facing contract that
went from 42/100 to 90/100 over four commits: a real `<form>` with a working
`action`, labels, fieldsets, native inputs rather than Radix, a stable
accessible name on the switch, `aria-describedby` on the field. Two copies
will drift, and a self-audit would then pass on one page while failing on the
other without naming which.

## Do it in two commits

1. Hoist the state into `ScanContext` and extract `ScanForm`. No visual
   change, every existing test still green.
2. Split the pages and write the new copy.

If something breaks, the bisect says whether it was the refactor or the
redesign.

## Falls out for free

`AIAgentDiscovery` is hardcoded to `page="home"` in `Index`, so an agent
reading `/scan` is currently told to "enter a website URL in the input field"
even when a report is on screen. Two real pages means `page="scan"` with its
own instructions. Worth fixing precisely because misdescribing a page to an
agent is the failure this product exists to find.

## Also outstanding

Polling continues after Back until the job reaches a terminal state. It writes
state nothing reads, and it means Forward can show a finished report, so it
was left alone. Revisit if jobs ever get persisted.
