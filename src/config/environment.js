/**
 * Environment configuration for Muse Form Audit
 *
 * The API base URL is read from VITE_API_BASE_URL and falls back to the local
 * scanner backend. Nothing secret belongs in here: every VITE_* variable is
 * inlined into the public JavaScript bundle at build time.
 */

const DEFAULT_API_BASE_URL = 'http://localhost:3001';

const getEnvironmentConfig = () => {
  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || DEFAULT_API_BASE_URL;
  const isDevelopment = import.meta.env.DEV === true;

  return {
    environment: isDevelopment ? 'development' : 'production',
    apiBaseUrl,
    isDevelopment,
    isProduction: !isDevelopment
  };
};

export const config = getEnvironmentConfig();

export default config;
