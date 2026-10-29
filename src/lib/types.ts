// Types for HuxTek application
// Only keeping types that are used by the AI Scanner functionality

import type { ScanResults } from '@/lib/scan-types';

export interface JobStatus {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'completed_with_errors';
  progress: number;
  message: string;
  results?: ScanResults;
  error?: string;
  startTime?: string;
  endTime?: string;
}
