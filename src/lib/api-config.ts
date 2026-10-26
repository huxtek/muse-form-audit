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
    HEALTH: '/health'
  }
};

export const getWebSocketUrl = (): string => {
  return API_CONFIG.WS_URL;
};
