/**
 * One way to say "the user cancelled", recognisable across the layers that
 * each have to treat it differently from a failure.
 *
 * A cancelled scan is not a failed scan, and the difference matters at three
 * places that would otherwise do exactly the wrong thing: the model provider
 * would retry it for a minute, the analyser would fall back to rule-based
 * scoring and return a report nobody asked for, and the agent would show the
 * user an error. All three are correct responses to a real failure.
 */
const CANCELLED = Symbol('scanCancelled');

export class ScanCancelledError extends Error {
  constructor(message = 'Scan cancelled') {
    super(message);
    this.name = 'ScanCancelledError';
    this[CANCELLED] = true;
  }
}

/**
 * True for a cancellation, however far it has been rethrown.
 *
 * A symbol rather than a name or message check: `error.name` survives being
 * wrapped by well-behaved code and nothing else, and the provider wraps
 * transport errors in new Error objects with rewritten messages.
 */
export const isCancellation = (error) => Boolean(error?.[CANCELLED]);

/** Throws if this scan has already been cancelled. */
export const throwIfCancelled = (signal) => {
  if (signal?.aborted) {
    throw new ScanCancelledError();
  }
};

/**
 * A delay that ends the moment the scan is cancelled.
 *
 * Model retries are spaced two seconds apart, and a cancel pressed during
 * one of those gaps should take effect now rather than when the gap happens
 * to end.
 */
export const cancellableDelay = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ScanCancelledError());

      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(new ScanCancelledError());
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
