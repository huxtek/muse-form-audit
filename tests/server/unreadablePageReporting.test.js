import { describe, expect, it } from 'vitest';

import { AIAgent } from '../../server/agent.js';

/**
 * Zero characters of HTML must never be reported as a page with no forms.
 *
 * `goToPage` returns empty HTML for a navigation failure so a multi-page
 * crawl can step over one bad page. A single-page scan has nothing to step
 * over, so it carried on, parsed the empty string, found no `<form>`, and
 * reported "Scan completed - no forms found" at 100%. That is the most
 * misleading thing this tool can say: a fact about us, dressed as a finding
 * about the page.
 *
 * united.com read exactly that way -- a real booking form, reported as a
 * clean zero.
 */
const runWith = async (method, pageData) => {
  const updates = [];
  const agent = new AIAgent('job-unreadable', 'https://www.united.com/', false, 'premium', (u) =>
    updates.push(u)
  );

  agent.tools.goToPage = async () => pageData;
  agent.tools.initBrowser = async () => {};
  agent.tools.cleanup = async () => {};
  agent.cleanup = async () => {};

  await agent[method]().catch(() => {});

  return updates;
};

const PER_FORM = 'startPerFormScan';

describe('a page that could not be read', () => {
  it('fails the scan instead of reporting no forms', async () => {
    const updates = await runWith(PER_FORM, {
      html: '',
      links: [],
      unreadable: true,
      error: 'Navigation timeout of 30000 ms exceeded'
    });
    const last = updates.at(-1);

    expect(last.status).toBe('failed');
    expect(updates.map((u) => u.currentStep)).not.toContain('Scan completed - no forms found');
  });

  it('names which side the problem is on', async () => {
    const updates = await runWith(PER_FORM, {
      html: '',
      links: [],
      unreadable: true,
      error: 'Navigation timeout of 30000 ms exceeded'
    });
    const last = updates.at(-1);

    expect(last.errorKind).toBe('unreadable');
    expect(last.currentStep).toBe('Could not read the page');
    // Not "(HTTP null)": there is no status when navigation never completed.
    expect(last.currentStep).not.toMatch(/null/);
  });

  it('passes the underlying navigation error through to the message', async () => {
    const updates = await runWith(PER_FORM, {
      html: '',
      links: [],
      unreadable: true,
      error: 'net::ERR_CONNECTION_RESET'
    });

    expect(updates.at(-1).error).toContain('net::ERR_CONNECTION_RESET');
  });

  it('treats empty HTML as unreadable even without the flag', async () => {
    // Belt and braces: the flag is new, the empty string is the old shape.
    const updates = await runWith(PER_FORM, { html: '', links: [] });

    expect(updates.at(-1).status).toBe('failed');
  });
});

describe('a page that was read and genuinely has no forms', () => {
  it('still reports zero forms as a result', async () => {
    // The honest zero must survive. A readable page with no fields is a
    // finding about the page, and the earlier "Nothing to check" work in
    // the report depends on this path still being reachable.
    const updates = await runWith(PER_FORM, {
      html: '<html><body><h1>About us</h1><p>No forms here.</p></body></html>',
      links: [],
      status: 200
    });
    const last = updates.at(-1);

    expect(last.status).toBe('completed');
    expect(last.currentStep).toBe('Scan completed - no forms found');
  });
});
