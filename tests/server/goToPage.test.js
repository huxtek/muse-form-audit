import { beforeEach, describe, expect, it } from 'vitest';

/*
 * Inference and the behaviour probe read their switches at import time, and
 * neither is what this file is about: both are covered by their own tests and
 * both would need a real DOM here.
 */
process.env.INFER_FORM_GROUPS = 'false';
process.env.PROBE_FORM_BEHAVIOUR = 'false';

const { CrawlerTools } = await import('../../server/tools.js');
const { measureReadiness } = await import('../../server/lib/pageReadiness.js');
const { CRAWLER_USER_AGENT } = await import('../../server/lib/userAgent.js');

/**
 * `goToPage` decides whether there is a page worth scanning, and every one of
 * those decisions was checked only by running the real thing against a live
 * site. The file sat at 5% covered while carrying:
 *
 *   - a navigation timeout that must keep a page that did render (united.com
 *     reported zero forms for a complete 2.4MB document because this threw
 *     the page away)
 *   - the same timeout that must fail loudly when nothing rendered
 *   - a refusal status, and a challenge page served with 200
 *   - any other navigation error, which must be labelled unreadable rather
 *     than passed off as a page with no forms
 *
 * The page here is a double. `evaluate` dispatches on what the function it is
 * given asks for, which is the only way to answer several different browser
 * questions from one fake.
 */
const timeoutError = () => {
  const error = new Error('Navigation timeout of 45000 ms exceeded');
  error.name = 'TimeoutError';

  return error;
};

const USABLE = {
  hasBody: true,
  elements: 3284,
  fields: 11,
  textLength: 1507,
  title: 'United Airlines'
};

const BLANK = { hasBody: true, elements: 4, fields: 0, textLength: 0, title: '' };

const HTML = '<html><body><form><input name="a"></form></body></html>';

const fakePage = ({ goto, content = HTML, readiness = USABLE, headers = {} } = {}) => {
  const calls = { userAgents: [], waitedForFields: 0, closed: false };

  return {
    calls,
    setViewport: async () => {},
    viewport: () => ({ width: 1280, height: 720 }),
    // Read on the timeout path, where there is no response to ask.
    url: () => 'https://example.com/',
    setUserAgent: async (value) => calls.userAgents.push(value),
    on: () => {},
    goto,
    content: async () => content,
    waitForSelector: async () => {
      calls.waitedForFields += 1;

      return {};
    },
    evaluate: async (fn) => {
      if (fn === measureReadiness) return readiness;

      const asks = String(fn);

      if (asks.includes('scrollHeight')) return 720;
      if (asks.includes('pageSize')) return { pageSize: { width: 1280, height: 720 }, forms: [] };
      if (asks.includes('a[href]')) return [];
      if (asks.includes("querySelectorAll('form')")) return 1;

      return null;
    },
    screenshot: async () => Buffer.from([0]),
    close: async () => {
      calls.closed = true;
    },
    headers
  };
};

const respondWith = (status, headers = {}) => ({
  status: () => status,
  url: () => 'https://example.com/',
  headers: () => headers
});

let tools;
let page;

const useTools = (pageDouble) => {
  page = pageDouble;
  tools = new CrawlerTools();
  tools.initBrowser = async () => {};
  tools.browser = { newPage: async () => page };

  return tools;
};

beforeEach(() => {
  page = null;
  tools = null;
});

describe('a navigation that timed out', () => {
  it('keeps a page that rendered anyway', async () => {
    // united.com: the document was complete when the wait expired.
    const crawler = useTools(
      fakePage({
        goto: async () => {
          throw timeoutError();
        },
        readiness: USABLE
      })
    );

    const result = await crawler.goToPage('https://www.united.com/');

    expect(result.html).toBe(HTML);
    expect(result.navigationTimedOut).toBe(true);
    expect(result.unreadable).toBeUndefined();
  });

  it('reports no status rather than inventing one', async () => {
    const crawler = useTools(
      fakePage({
        goto: async () => {
          throw timeoutError();
        }
      })
    );

    expect((await crawler.goToPage('https://www.united.com/')).status).toBeNull();
  });

  it('fails loudly when nothing rendered', async () => {
    const crawler = useTools(
      fakePage({
        goto: async () => {
          throw timeoutError();
        },
        readiness: BLANK
      })
    );

    const error = await crawler.goToPage('https://slow.example/').catch((e) => e);

    expect(error.pageAccess).toMatchObject({ kind: 'nav-timeout' });
    expect(error.message).toMatch(/never saw them/);
  });

  it('closes the page it gave up on', async () => {
    const crawler = useTools(
      fakePage({
        goto: async () => {
          throw timeoutError();
        },
        readiness: BLANK
      })
    );

    await crawler.goToPage('https://slow.example/').catch(() => {});

    expect(page.calls.closed).toBe(true);
  });
});

describe('a page that refused the request', () => {
  it('raises the refusal instead of serialising the refusal page', async () => {
    // aa.com answers 403 from Akamai with an Access Denied body.
    const crawler = useTools(
      fakePage({
        goto: async () => respondWith(403, { 'set-cookie': ['ak_bmsc=1'] }),
        content: '<html><body><h1>Access Denied</h1>Reference #18.b651</body></html>'
      })
    );

    const error = await crawler.goToPage('https://www.aa.com/').catch((e) => e);

    expect(error.pageAccess).toMatchObject({ kind: 'bot-protected', status: 403 });
  });

  it('catches a challenge served with a success status', async () => {
    // amazon.com answers HTTP 202 with one.
    const crawler = useTools(
      fakePage({
        goto: async () => respondWith(202, { 'set-cookie': ['__cf_bm=x'] }),
        content: '<html><head><title>Robot Check</title></head><body>Just a moment...</body></html>'
      })
    );

    const error = await crawler.goToPage('https://www.amazon.com/').catch((e) => e);

    expect(error.pageAccess).toMatchObject({ kind: 'bot-protected', status: 202 });
  });
});

describe('any other navigation failure', () => {
  it('is labelled unreadable rather than returned as an empty page', async () => {
    /*
     * The flag a single-page caller checks. Without it the empty HTML read as
     * a page with no forms, which is how "Scan completed - no forms found"
     * came to be said about pages that were never read.
     */
    const crawler = useTools(
      fakePage({
        goto: async () => {
          throw new Error('net::ERR_CONNECTION_RESET');
        }
      })
    );

    const result = await crawler.goToPage('https://broken.example/');

    expect(result).toMatchObject({ html: '', unreadable: true });
    expect(result.error).toMatch(/ERR_CONNECTION_RESET/);
  });

  it('does not swallow a refusal into that same shape', async () => {
    const crawler = useTools(
      fakePage({
        goto: async () => respondWith(403, { 'set-cookie': ['ak_bmsc=1'] }),
        content: '<html><body>Access Denied Reference #1</body></html>'
      })
    );

    await expect(crawler.goToPage('https://www.aa.com/')).rejects.toThrow();
  });
});

describe('a page that loaded', () => {
  it('returns the markup and the status', async () => {
    const crawler = useTools(fakePage({ goto: async () => respondWith(200) }));

    const result = await crawler.goToPage('https://example.com/');

    expect(result.html).toBe(HTML);
    expect(result.status).toBe(200);
    expect(result.navigationTimedOut).toBe(false);
  });

  it('waits for a field to appear before reading the markup', async () => {
    // What replaced a fixed two-second sleep once navigation stopped at
    // domcontentloaded.
    const crawler = useTools(fakePage({ goto: async () => respondWith(200) }));

    await crawler.goToPage('https://example.com/');

    expect(page.calls.waitedForFields).toBe(1);
  });

  it('identifies itself as the crawler, the same as the pre-flight does', async () => {
    // The split identity that had google.com/travel/flights redirect the
    // pre-flight to its unsupported-browser page.
    const crawler = useTools(fakePage({ goto: async () => respondWith(200) }));

    await crawler.goToPage('https://example.com/');

    expect(page.calls.userAgents).toContain(CRAWLER_USER_AGENT);
  });
});
