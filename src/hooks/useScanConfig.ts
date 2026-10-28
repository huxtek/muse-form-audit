import { useEffect, useState } from 'react';

import { DEFAULT_SCAN_CONFIG, fetchScanConfig, type ScanConfig } from '@/lib/scan-config';

/**
 * Asks the API what it is willing to do, once per mount.
 *
 * Starts from the fail-open default so the first render never flashes a
 * "scanning is disabled" message at someone on a perfectly working
 * deployment.
 */
export const useScanConfig = (): ScanConfig => {
  const [config, setConfig] = useState<ScanConfig>(DEFAULT_SCAN_CONFIG);

  useEffect(() => {
    let cancelled = false;

    fetchScanConfig().then((result) => {
      if (!cancelled) {
        setConfig(result);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return config;
};
