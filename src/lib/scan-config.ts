import { getConfigUrl } from '@/lib/api-config';

/**
 * What the deployed API will and will not do, asked at runtime.
 *
 * Deliberately not a VITE_ variable. Vite inlines those into the bundle at
 * build time, so a build-time flag would make "turn real scans on" mean
 * "rebuild and redeploy the front end" -- the last thing anyone wants to be
 * doing minutes before a demo. Asking the server makes it a restart.
 *
 * Lives in its own module rather than on `formAPI` so it is reachable in
 * tests that replace the whole api module, and so a failure here cannot take
 * a scan down with it.
 */
export interface ScanConfig {
  /** False on a demo instance, where /api/scan refuses real targets. */
  realScansEnabled: boolean;
}

/**
 * Fails open.
 *
 * If the config call does not answer, the interface assumes real scans are
 * available and offers them. That is the safe direction because the gate is
 * enforced by the API, not here: the worst case is someone presses Scan and
 * gets a clear 403 explaining the instance is in demo mode. Failing closed
 * would be worse -- one flaky request and a working deployment would tell
 * everybody that scanning is switched off.
 */
export const DEFAULT_SCAN_CONFIG: ScanConfig = { realScansEnabled: true };

export const fetchScanConfig = async (): Promise<ScanConfig> => {
  try {
    const response = await fetch(getConfigUrl(), {
      headers: { Accept: 'application/json' }
    });

    if (!response.ok) {
      return DEFAULT_SCAN_CONFIG;
    }

    const payload = await response.json();

    return {
      // Only an explicit false disables it, so a malformed or partial
      // response cannot accidentally hide the product's main action.
      realScansEnabled: payload?.realScansEnabled !== false
    };
  } catch {
    return DEFAULT_SCAN_CONFIG;
  }
};
