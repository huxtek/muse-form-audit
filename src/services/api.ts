import config from '@/config/environment';

const API_BASE_URL = `${config.apiBaseUrl}/api`;

export interface StartScanRequest {
  url: string;
  fullCrawl: boolean;
  devMode: boolean;
}

/**
 * Throws an Error carrying the server's message, with the raw response
 * attached. Callers (and their toasts) depend on the message text, so the
 * precedence is deliberately `message` → `error` → `HTTP <status>`.
 */
const throwResponseError = async (response: Response, fallback: string) => {
  const errorData = await response.json().catch(() => ({ error: fallback }));
  const error = new Error(errorData.message || errorData.error || `HTTP ${response.status}`);
  (error as Error & { response?: unknown }).response = {
    status: response.status,
    data: errorData
  };
  throw error;
};

/**
 * Scanner API client. The single place the UI talks HTTP to the backend.
 *
 * The backend is currently unauthenticated, so no credentials are attached
 * here. This module is the seam for auth when it is added back: add the
 * `Authorization` header to the `headers` object of each method below
 * (`startScan`, `getReport`, `analyzeForm`) and nothing else needs to change.
 */
export const formAPI = {
  /** Kicks off an asynchronous scan job. Returns `{ success, jobId, ... }`. */
  startScan: async ({ url, fullCrawl, devMode }: StartScanRequest) => {
    const response = await fetch(`${API_BASE_URL}/scan`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ url, fullCrawl, devMode })
    });

    if (!response.ok) {
      await throwResponseError(response, 'Scan failed');
    }

    return response.json();
  },

  /** Polls a scan job. Returns the job record including `status` and `results`. */
  getReport: async (jobId: string) => {
    const response = await fetch(`${API_BASE_URL}/report/${jobId}`);

    if (!response.ok) {
      await throwResponseError(response, 'Report fetch failed');
    }

    return response.json();
  },

  /** Synchronous single-page analysis. Available, but not used by the UI today. */
  analyzeForm: async (url: string, options?: unknown, devMode?: boolean) => {
    const response = await fetch(`${API_BASE_URL}/analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        url,
        options,
        devMode: devMode || false
      })
    });

    if (!response.ok) {
      await throwResponseError(response, 'Analysis failed');
    }

    return response.json();
  }
};
