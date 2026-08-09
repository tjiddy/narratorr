/**
 * Outbound fetch and SSRF policy. npm undici dispatchers must use npm undici's fetch; Node 24's
 * bundled fetch has a different Dispatcher class and rejects them with `UND_ERR_INVALID_ARG`.
 * This destination policy is intentionally broader than auth's LAN-client policy.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent, fetch as undiciFetchImpl } from 'undici';
import type { LookupFunction } from 'node:net';
import { mapNetworkError } from './map-network-error.js';

export { mapNetworkError, redactUrlsFromMessage } from './map-network-error.js';
import { HTTP_DOWNLOAD_TIMEOUT_MS } from './constants.js';

/**
 * npm undici fetch; mandatory whenever a dispatcher comes from that package.
 */
export const undiciFetch = undiciFetchImpl;

export type DispatcherFetchInit = RequestInit & { dispatcher?: unknown };

/**
 * Uses npm undici with a dispatcher so class identity matches; otherwise uses global fetch so MSW
 * interception works. The Response cast bridges equivalent runtime shapes with divergent DOM and
 * package declarations.
 */
export async function fetchWithOptionalDispatcher(
  url: string | URL,
  options: DispatcherFetchInit,
): Promise<Response> {
  if (options.dispatcher !== undefined) {
    const undiciResponse = await undiciFetch(url, options as Parameters<typeof undiciFetch>[1]);
    return undiciResponse as unknown as Response;
  }
  return fetch(url, options);
}

/**
 * Fetches with a mandatory timeout, manual redirect diagnostics, and actionable network errors.
 * A caller signal is composed with—not substituted for—the timeout, so either can abort.
 */
export async function fetchWithTimeout(
  url: string | URL,
  options: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      redirect: 'manual',
      signal: combinedSignal,
    });
  } catch (error: unknown) {
    throw mapNetworkError(error);
  }

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('Location');
    const target = location ? `to ${location} ` : '';
    throw new Error(
      `Server redirected ${target}— an auth proxy may be intercepting requests. ` +
        `Use the service's internal address or whitelist this endpoint in your proxy config.`,
    );
  }

  return response;
}

const BLOCKED_HOSTNAMES = new Set<string>([
  'metadata.google.internal',
]);

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV4_MAPPED_PATTERN = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

export function isBlockedHostname(hostname: string): boolean {
  return BLOCKED_HOSTNAMES.has(hostname.toLowerCase());
}

/**
 * `new URL('http://[::1]/').hostname` returns `[::1]` (with brackets) in Node.
 * Strip the brackets so the unbracketed checks match.
 */
export function normalizeHostname(hostname: string): string {
  if (hostname.length >= 2 && hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

export function isIpLiteral(hostname: string): boolean {
  if (IPV4_PATTERN.test(hostname)) return true;
  return hostname.includes(':');
}

export function isBlockedFetchAddress(ip: string): boolean {
  const cleaned = ip.split('%')[0]!.toLowerCase();

  const mapped = cleaned.match(IPV4_MAPPED_PATTERN);
  if (mapped) return isBlockedIpv4(mapped[1]!);

  if (IPV4_PATTERN.test(cleaned)) return isBlockedIpv4(cleaned);

  return isBlockedIpv6(cleaned);
}

function isBlockedIpv4(ip: string): boolean {
  if (ip === '0.0.0.0') return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('127.')) return true;
  if (ip.startsWith('169.254.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return true;
  return false;
}

function isBlockedIpv6(ip: string): boolean {
  if (ip === '::' || ip === '::1') return true;
  if (/^fe[89ab][0-9a-f]?:/i.test(ip)) return true;
  if (/^f[cd][0-9a-f]{0,2}:/i.test(ip)) return true;
  if (ip.startsWith('ff')) return true;
  return false;
}

function defaultPortForScheme(protocol: string): string {
  return protocol === 'https:' ? '443' : '80';
}

/**
 * Canonical host:port allowlist key: lowercase, default port, no IPv6 brackets. Accepting a parsed
 * URL avoids unbracketed-IPv6 split ambiguity.
 */
export function normalizedHostPortFromUrl(parsed: URL): string {
  const hostname = normalizeHostname(parsed.hostname).toLowerCase();
  const port = parsed.port || defaultPortForScheme(parsed.protocol);
  return `${hostname}:${port}`;
}

export function normalizedHostnameFromUrl(parsed: URL): string {
  return normalizeHostname(parsed.hostname).toLowerCase();
}

/**
 * Private answers require an exact configured host:port match; both fields must be supplied.
 */
export interface ResolveAndValidateOptions {
  lanAllowlist?: Set<string>;
  normalizedHostPort?: string;
}

/**
 * Validates literals and every DNS answer against SSRF policy. An exact LAN host:port allowlist
 * match permits private answers. Preflight gives early refusal; socket lookup repeats validation
 * to resist DNS rebinding.
 */
export async function resolveAndValidate(
  hostname: string,
  opts: ResolveAndValidateOptions = {},
): Promise<string[]> {
  const normalized = normalizeHostname(hostname);
  if (isBlockedHostname(normalized)) {
    throw new Error(`Refused: hostname ${normalized} is in the blocked cloud-metadata list`);
  }
  const allowed = opts.lanAllowlist && opts.normalizedHostPort
    ? opts.lanAllowlist.has(opts.normalizedHostPort)
    : false;
  if (isIpLiteral(normalized)) {
    if (isBlockedFetchAddress(normalized) && !allowed) {
      throw new Error(`Refused: address ${normalized} is in the blocked range`);
    }
    return [normalized];
  }
  const answers = await dnsLookup(normalized, { all: true, family: 0 });
  if (answers.length === 0) {
    throw new Error(`Refused: DNS returned no answers for ${normalized}`);
  }
  for (const answer of answers) {
    if (isBlockedFetchAddress(answer.address) && !allowed) {
      throw new Error(
        `Refused: hostname ${normalized} resolved to ${answers.length} address(es); blocked address ${answer.address} is in the blocked range`,
      );
    }
  }
  return answers.map((a) => a.address);
}

/**
 * Socket-bound validator resolves every address and connects only after all pass, defeating DNS
 * rebinding. Its allowlist is hostname-only because LookupFunction receives no port; preflight
 * enforces exact host:port matching.
 */
export function makeValidatingLookup(hostnameAllowlist?: Set<string>): LookupFunction {
  return (hostname, options, callback) => {
    // Undici requests `{all:true}` and an address array; Node's standalone form expects one address.
    const wantAll = (options as { all?: boolean } | undefined)?.all === true;
    const cbAll = callback as unknown as (
      err: NodeJS.ErrnoException | null,
      addresses: { address: string; family: number }[],
    ) => void;
    const succeed = (address: string, family: number): void => {
      if (wantAll) {
        cbAll(null, [{ address, family }]);
      } else {
        callback(null, address, family);
      }
    };
    const fail = (err: NodeJS.ErrnoException): void => {
      if (wantAll) {
        cbAll(err, []);
      } else {
        callback(err, '', 0);
      }
    };

    const normalized = normalizeHostname(hostname);
    if (isBlockedHostname(normalized)) {
      fail(new Error(`Refused: hostname ${normalized} is in the blocked cloud-metadata list`) as NodeJS.ErrnoException);
      return;
    }
    const allowed = hostnameAllowlist?.has(normalized.toLowerCase()) ?? false;
    if (isIpLiteral(normalized)) {
      if (isBlockedFetchAddress(normalized) && !allowed) {
        fail(new Error(`Refused: address ${normalized} is in the blocked range`) as NodeJS.ErrnoException);
        return;
      }
      succeed(normalized, normalized.includes(':') ? 6 : 4);
      return;
    }
    dnsLookup(normalized, { all: true, family: 0 })
      .then((answers) => {
        if (answers.length === 0) {
          fail(new Error(`Refused: DNS returned no answers for ${normalized}`) as NodeJS.ErrnoException);
          return;
        }
        for (const answer of answers) {
          if (isBlockedFetchAddress(answer.address) && !allowed) {
            fail(new Error(
              `Refused: hostname ${normalized} resolved to ${answers.length} address(es); blocked address ${answer.address} is in the blocked range`,
            ) as NodeJS.ErrnoException);
            return;
          }
        }
        const chosen = answers[0]!;
        succeed(chosen.address, chosen.family);
      })
      .catch((err: unknown) => {
        fail(err as NodeJS.ErrnoException);
      });
  };
}

export const validatingLookup: LookupFunction = makeValidatingLookup();

/**
 * Creates an undici Agent whose socket lookup re-runs the SSRF block policy on every connect.
 * Callers own its lifecycle; the optional hostname allowlist supports LAN indexers.
 */
export function createSsrfSafeDispatcher(hostnameAllowlist?: Set<string>): Agent {
  return new Agent({
    connect: {
      lookup: makeValidatingLookup(hostnameAllowlist),
    },
  });
}

export const MAX_REDIRECTS = 5;

/**
 * Carries an unsupported resolved redirect and its source URL so callers can handle artifacts such
 * as indexer `magnet:` redirects explicitly.
 */
export class UnsupportedRedirectSchemeError extends Error {
  readonly location: string;
  readonly fromUrl: URL;

  constructor(location: string, fromUrl: URL) {
    super(`Redirect to unsupported scheme: ${location.split(':')[0]}:`);
    this.name = 'UnsupportedRedirectSchemeError';
    this.location = location;
    this.fromUrl = fromUrl;
  }
}

export interface FetchWithSsrfRedirectOptions {
  dispatcher?: unknown;
  timeoutMs?: number;
  maxHops?: number;
  /**
   * Identity headers are forwarded on every hop. Credential headers are stripped case-insensitively
   * on cross-origin redirects and restored on same-origin hops relative to the start URL.
   */
  headers?: Record<string, string>;
  /**
   * Exact canonical host:port preflight allowlist for LAN targets. Pair with the dispatcher's
   * hostname-only allowlist for socket-time defense in depth.
   */
  lanAllowlist?: Set<string>;
}

async function resolveRedirectTarget(response: Response, currentUrl: string, parsed: URL): Promise<string> {
  const location = response.headers.get('location');
  if (!location) {
    await response.body?.cancel().catch(() => { /* best-effort */ });
    throw new Error('Redirect with no Location header');
  }
  const nextHref = new URL(location, currentUrl).href;
  await response.body?.cancel().catch(() => { /* best-effort */ });
  if (!nextHref.startsWith('http://') && !nextHref.startsWith('https://')) {
    throw new UnsupportedRedirectSchemeError(nextHref, parsed);
  }
  return nextHref;
}

const CREDENTIAL_HEADER_KEYS = new Set(['authorization', 'cookie', 'proxy-authorization']);

/**
 * Drops credential headers from cross-origin hops without mutating caller input. Surviving key
 * casing and all same-origin headers are preserved.
 */
export function stripCrossOriginCredentialHeaders(
  headers: Record<string, string>,
  isCrossOrigin: boolean,
): Record<string, string> {
  if (!isCrossOrigin) {
    return { ...headers };
  }
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!CREDENTIAL_HEADER_KEYS.has(key.toLowerCase())) {
      filtered[key] = value;
    }
  }
  return filtered;
}

export async function fetchWithSsrfRedirect(
  startUrl: string,
  opts: FetchWithSsrfRedirectOptions = {},
): Promise<Response> {
  const { dispatcher, timeoutMs = HTTP_DOWNLOAD_TIMEOUT_MS, maxHops = MAX_REDIRECTS, lanAllowlist, headers = {} } = opts;
  const startOrigin = new URL(startUrl).origin;
  const visited = new Set<string>();
  let currentUrl = startUrl;

  for (let hop = 0; hop <= maxHops; hop++) {
    if (visited.has(currentUrl)) {
      throw new Error('Redirect loop detected');
    }
    visited.add(currentUrl);

    const parsed = new URL(currentUrl);
    await resolveAndValidate(parsed.hostname, {
      ...(lanAllowlist && { lanAllowlist }),
      normalizedHostPort: normalizedHostPortFromUrl(parsed),
    });

    const fetchOptions: DispatcherFetchInit = {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      dispatcher,
      headers: stripCrossOriginCredentialHeaders(headers, parsed.origin !== startOrigin),
    };

    const response = await fetchWithOptionalDispatcher(currentUrl, fetchOptions);

    if (response.status < 300 || response.status >= 400) {
      return response;
    }

    currentUrl = await resolveRedirectTarget(response, currentUrl, parsed);
  }

  throw new Error('Too many redirects');
}
