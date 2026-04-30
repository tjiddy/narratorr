import { mapNetworkError } from './map-network-error.js';
import {
  createSsrfSafeDispatcher,
  resolveAndValidate,
} from './blocked-fetch-address.js';
import { readBodyWithCap } from './read-body-with-cap.js';
import { RESPONSE_CAP_NOTIFIER } from './response-caps.js';

/**
 * Options for the hardened wrapper. `allowPrivateNetwork` and `maxBodyBytes`
 * are wrapper-internal — they are stripped before delegating to `fetch()`.
 */
export type FetchWithTimeoutOptions = RequestInit & {
  /**
   * When `false` (default), the wrapper pre-flights the destination hostname
   * against the SSRF block policy and attaches an Undici dispatcher that
   * re-validates at socket time (DNS rebinding defense). When `true`, both
   * checks are skipped — only the five download-client RPC adapters
   * (qBittorrent, SABnzbd, NZBGet, Transmission, Deluge) opt in, since they
   * legitimately target localhost / Docker service names / RFC 1918 hosts.
   */
  allowPrivateNetwork?: boolean;
  /**
   * Streaming body cap. Defaults to `RESPONSE_CAP_NOTIFIER` (64 KiB) — most
   * notifier APIs return small acknowledgements. Callers expecting larger
   * payloads (metadata, NZB artifact, RPC) MUST pass the appropriate named
   * constant from `response-caps.ts`. Cap-exceeded surfaces as a thrown error;
   * partial bodies are never returned.
   */
  maxBodyBytes?: number;
};

/**
 * Fetch with timeout, manual redirect rejection, SSRF preflight + dispatcher
 * (unless `allowPrivateNetwork`), and a streamed response-size cap.
 *
 * Returns a freshly-constructed `Response(buffer, { status, statusText, headers })`
 * so callers can still call `.text()`, `.json()`, or `.arrayBuffer()` after the
 * cap-buffered read.
 *
 * 3xx responses are detected and thrown as descriptive Errors before returning
 * to callers — same contract as before. Network-level errors (ECONNREFUSED,
 * ENOTFOUND, timeouts) are mapped to actionable messages via `mapNetworkError`.
 */
export async function fetchWithTimeout(
  url: string | URL,
  options: FetchWithTimeoutOptions,
  timeoutMs: number,
): Promise<Response> {
  const {
    allowPrivateNetwork = false,
    maxBodyBytes = RESPONSE_CAP_NOTIFIER,
    ...fetchInit
  } = options;

  let dispatcher: unknown;
  if (!allowPrivateNetwork) {
    const target = new URL(url instanceof URL ? url.href : url);
    // Throws SsrfRefusedError on policy violation — caller sees a typed refusal
    // distinct from network/timeout failures.
    await resolveAndValidate(target.hostname);
    dispatcher = createSsrfSafeDispatcher();
  }

  let response: Response;
  try {
    const init: RequestInit & { dispatcher?: unknown } = {
      ...fetchInit,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (dispatcher) init.dispatcher = dispatcher;

    response = await fetch(url, init);
  } catch (error: unknown) {
    throw mapNetworkError(error);
  }

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('Location');
    const target = location ? `to ${location} ` : '';
    // Drain the redirect body so the socket can be released
    await response.body?.cancel().catch(() => { /* best-effort */ });
    throw new Error(
      `Server redirected ${target}— an auth proxy may be intercepting requests. ` +
        `Use the service's internal address or whitelist this endpoint in your proxy config.`,
    );
  }

  // Cap and reconstruct so callers' .text()/.json()/.arrayBuffer() still work.
  // Copy into a fresh ArrayBuffer — Buffer/Uint8Array hit `BodyInit` strictness
  // in @types/node 24, but ArrayBuffer is unambiguous.
  const buffer = await readBodyWithCap(response, maxBodyBytes);
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
  return new Response(arrayBuffer, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
