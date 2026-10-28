/**
 * API Configuration
 * Uses centralized environment configuration
 */

import config from '@/config/environment';

const getApiBaseUrl = (): string => {
  return config.apiBaseUrl;
};

const getWebSocketBaseUrl = (): string => {
  // Convert HTTPS API URL to WSS WebSocket URL
  const wsUrl = config.apiBaseUrl.replace('https://', 'wss://').replace('http://', 'ws://');
  return wsUrl;
};

export const API_CONFIG = {
  BASE_URL: getApiBaseUrl(),
  WS_URL: getWebSocketBaseUrl(),
  ENDPOINTS: {
    SCAN: '/api/scan',
    REPORT: '/api/report',
    JOBS: '/api/jobs',
    SCREENSHOT: '/api/screenshot',
    PAGE_MAP: '/api/page-map',
    CONFIG: '/api/config',
    HEALTH: '/health'
  }
};

/**
 * What the deployed server will and will not do.
 *
 * Read at runtime rather than compiled in. Vite inlines every VITE_ variable
 * into the bundle at build time, so a build-time flag would make "turn real
 * scans on" mean "rebuild and redeploy the front end" -- the last thing to be
 * doing minutes before a demo. Asking the server instead makes it a restart.
 */
export const getConfigUrl = (): string =>
  `${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.CONFIG}`;

export const getWebSocketUrl = (): string => {
  return API_CONFIG.WS_URL;
};

/**
 * URL of a captured form screenshot. The bytes are served from their own
 * endpoint rather than inlined in the scan results, so polling stays small.
 */
export const getScreenshotUrl = (jobId: string, visualIndex: number): string =>
  `${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.SCREENSHOT}/${encodeURIComponent(jobId)}/${visualIndex}`;

/** URL of the whole-page map for one scanned page. */
export const getPageMapUrl = (jobId: string, pageIndex: number): string =>
  `${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.PAGE_MAP}/${encodeURIComponent(jobId)}/${pageIndex}`;

/**
 * Where the scan form posts.
 *
 * The form declares this as a real `action`, so an agent can see where the
 * submission goes and a native submit actually starts a scan and returns the
 * job id. The endpoint accepts form-encoded bodies for exactly this reason:
 * declaring an action that 400s would be markup that lies to the agent we are
 * trying to help.
 */
export const getScanUrl = (): string =>
  `${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.SCAN}`;
