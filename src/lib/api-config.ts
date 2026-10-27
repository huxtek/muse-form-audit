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
    HEALTH: '/health'
  }
};

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
