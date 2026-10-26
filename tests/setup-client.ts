import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

/**
 * The suite must be hermetic: nothing here may touch the network, and no test
 * may depend on a running backend. `fetch` and `WebSocket` are the only two
 * ways the client reaches out, so both are replaced with throwing stubs by
 * default. A test that needs either must install its own stub explicitly.
 */
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Unexpected network call: tests must stub fetch');
    })
  );

  class OfflineWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readyState = OfflineWebSocket.CONNECTING;
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;

    send() {}

    close() {
      this.readyState = OfflineWebSocket.CLOSED;
    }
  }

  vi.stubGlobal('WebSocket', OfflineWebSocket);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
