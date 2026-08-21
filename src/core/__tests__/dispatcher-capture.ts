/**
 * Capture the undici dispatcher a proxied call constructed, and count the `close()` production ran
 * on it (#2539).
 *
 * Only the `*.dispatcher-routing.test.ts` seam can do this: the suites that rewire
 * `fetchWithOptionalDispatcher` down to `globalThis.fetch` never see a dispatcher at all, while a
 * mocked helper receives the real instance on `init.dispatcher`.
 */

import { vi, type Mock, type MockInstance } from 'vitest';
import type { Dispatcher } from 'undici';

export interface DispatcherCapture {
  dispatcher?: Dispatcher;
  close?: MockInstance<() => Promise<void>>;
  /** How many times production called `close()` on the captured dispatcher. */
  closeCalls(): number;
}

/**
 * Installs `respond` as the mocked helper's implementation and spies the first dispatcher it sees.
 *
 * The spy is stubbed rather than called through: undici's `DispatcherBase.close()` promise wrapper
 * re-enters `this.close(cb)`, so calling through records two hits for one production call and the
 * count would stop meaning what it says.
 */
export function captureDispatcher(
  mockHelper: Mock,
  respond: (init: RequestInit & { dispatcher?: Dispatcher }) => Promise<Response>,
  options: { closeRejects?: boolean } = {},
): DispatcherCapture {
  const capture: DispatcherCapture = { closeCalls: () => capture.close?.mock.calls.length ?? 0 };

  mockHelper.mockImplementation(async (_url: string, init: RequestInit & { dispatcher?: Dispatcher }) => {
    if (init.dispatcher && !capture.dispatcher) {
      capture.dispatcher = init.dispatcher;
      const spy = vi.spyOn(init.dispatcher, 'close');
      if (options.closeRejects) spy.mockRejectedValue(new Error('close failed'));
      else spy.mockResolvedValue(undefined);
      capture.close = spy;
    }
    return respond(init);
  });

  return capture;
}

/**
 * A responder that announces once the request is genuinely in flight and then hangs until its
 * signal aborts. Guarding on `signal.aborted` before subscribing is load-bearing: an `abort` event
 * never re-fires, so an already-aborted signal would hang to the suite timeout instead.
 */
export function respondInFlightUntilAborted(): {
  onTheWire: Promise<void>;
  respond: (init: RequestInit & { dispatcher?: Dispatcher }) => Promise<Response>;
} {
  let announce!: () => void;
  const onTheWire = new Promise<void>((resolve) => { announce = resolve; });

  return {
    onTheWire,
    respond: (init) => {
      announce();
      return new Promise((_resolve, reject) => {
        const signal = init.signal!;
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  };
}
