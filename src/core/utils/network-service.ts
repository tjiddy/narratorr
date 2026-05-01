/**
 * Canonical home for outbound-network helpers. Consolidates timeout/redirect
 * detection (fetchWithTimeout) and SSRF-block enforcement (block-policy
 * predicates + DNS-rebinding-resistant dispatcher) plus the single undici
 * `fetch` export used by callers that attach a `dispatcher` option.
 *
 * Why the dual-undici export matters:
 * Node 24's bundled fetch and the `undici` npm package both expose a
 * `Dispatcher` class, but they are *different classes* — a dispatcher built
 * with `import { ProxyAgent } from 'undici'` does NOT pass the bundled
 * fetch's instanceof/shape checks (undici 8 tightened this). Passing such
 * a dispatcher to `globalThis.fetch` fails with `UND_ERR_INVALID_ARG`
 * (`invalid onRequestStart method`). The fix: import `fetch` from `undici`
 * and use that whenever a `dispatcher` is in play, so both sides come from
 * the same package version.
 *
 * SSRF block policy (resolveAndValidate / validatingLookup / createSsrfSafeDispatcher)
 * is the SSRF-block contract used by attacker-influenced fetches (cover art,
 * indexer-supplied URLs). Rules:
 *   - RFC 1918 (10/8, 172.16/12, 192.168/16)
 *   - CGNAT (100.64/10 — RFC 6598; AWS Lambda VPC NAT)
 *   - Loopback (127/8, ::1)
 *   - Link-local (169.254/16 — covers AWS/Alibaba metadata; fe80::/10)
 *   - Unspecified (0.0.0.0, ::)
 *   - IPv6 unique-local (fc00::/7, covers fd00::/8)
 *   - IPv6 multicast (ff00::/8)
 *   - IPv4-mapped IPv6 forms of any blocked IPv4 address (e.g., ::ffff:169.254.169.254)
 *   - Hostname allowlist for known cloud-metadata names (belt-and-suspenders).
 *
 * Distinct from auth's `isPrivateIp` — that helper answers "is this client
 * on the LAN, allow auth bypass?", which is intentionally narrower than
 * "is this destination unsafe to fetch?".
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent, fetch as undiciFetchImpl } from 'undici';
import type { LookupFunction } from 'node:net';
import { mapNetworkError } from './map-network-error.js';

/**
 * Re-export of undici's `fetch`. Callers attaching a `dispatcher` MUST use
 * this binding (not `globalThis.fetch`) so both fetch and dispatcher come
 * from the same `undici` package instance.
 */
export const undiciFetch = undiciFetchImpl;

/**
 * Fetch with an automatic timeout via AbortSignal.timeout().
 * Replaces manual AbortController + setTimeout boilerplate.
 *
 * 3xx responses are detected and thrown as descriptive Errors before returning
 * to callers. All download-client and notifier test() paths surface error.message
 * via their existing try/catch, so no caller changes are needed.
 *
 * Network-level errors (ECONNREFUSED, ENOTFOUND, timeouts) are mapped to
 * actionable messages via mapNetworkError.
 */
export async function fetchWithTimeout(
  url: string | URL,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
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
  const cleaned = ip.split('%')[0].toLowerCase();

  const mapped = cleaned.match(IPV4_MAPPED_PATTERN);
  if (mapped) return isBlockedIpv4(mapped[1]);

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

/**
 * Resolve a hostname (or accept an IP literal) and validate every answer
 * against the SSRF block policy. Throws if the hostname is in the cloud-metadata
 * allowlist, the IP literal is blocked, or any DNS answer is blocked.
 *
 * Used both as a pre-flight check before invoking fetch (early refusal +
 * testability via `vi.mock('node:dns/promises')`) and inside the dispatcher's
 * `connect.lookup` hook (defense against DNS rebinding).
 */
export async function resolveAndValidate(hostname: string): Promise<string[]> {
  const normalized = normalizeHostname(hostname);
  if (isBlockedHostname(normalized)) {
    throw new Error(`Refused: hostname ${normalized} is in the blocked cloud-metadata list`);
  }
  if (isIpLiteral(normalized)) {
    if (isBlockedFetchAddress(normalized)) {
      throw new Error(`Refused: address ${normalized} is in the blocked range`);
    }
    return [normalized];
  }
  const answers = await dnsLookup(normalized, { all: true, family: 0 });
  if (answers.length === 0) {
    throw new Error(`Refused: DNS returned no answers for ${normalized}`);
  }
  for (const answer of answers) {
    if (isBlockedFetchAddress(answer.address)) {
      throw new Error(
        `Refused: hostname ${normalized} resolves to blocked address ${answer.address}`,
      );
    }
  }
  return answers.map((a) => a.address);
}

/**
 * Socket-bound DNS validation for the undici Agent's connect path. Resolves
 * every A/AAAA answer for the destination hostname, refuses if any answer
 * fails the block policy, and returns one of the validated answers to the
 * connecting socket. This binds validation to the same resolution the socket
 * connects to, defeating DNS rebinding.
 *
 * Exported so its rebinding-protection behavior is directly testable —
 * fetch-stubbed service tests can't exercise the dispatcher path.
 */
export const validatingLookup: LookupFunction = (hostname, _options, callback) => {
  const normalized = normalizeHostname(hostname);
  if (isBlockedHostname(normalized)) {
    callback(
      new Error(`Refused: hostname ${normalized} is in the blocked cloud-metadata list`) as NodeJS.ErrnoException,
      '',
      0,
    );
    return;
  }
  if (isIpLiteral(normalized)) {
    if (isBlockedFetchAddress(normalized)) {
      callback(
        new Error(`Refused: address ${normalized} is in the blocked range`) as NodeJS.ErrnoException,
        '',
        0,
      );
      return;
    }
    callback(null, normalized, normalized.includes(':') ? 6 : 4);
    return;
  }
  dnsLookup(normalized, { all: true, family: 0 })
    .then((answers) => {
      if (answers.length === 0) {
        callback(
          new Error(`Refused: DNS returned no answers for ${normalized}`) as NodeJS.ErrnoException,
          '',
          0,
        );
        return;
      }
      for (const answer of answers) {
        if (isBlockedFetchAddress(answer.address)) {
          callback(
            new Error(
              `Refused: hostname ${normalized} resolves to blocked address ${answer.address}`,
            ) as NodeJS.ErrnoException,
            '',
            0,
          );
          return;
        }
      }
      const chosen = answers[0];
      callback(null, chosen.address, chosen.family);
    })
    .catch((err: unknown) => {
      callback(err as NodeJS.ErrnoException, '', 0);
    });
};

/**
 * Create an undici Agent whose socket lookup re-runs the SSRF block policy
 * for every connect. Reused across redirect hops — every hop gets re-validated
 * because each hop opens a new socket.
 */
export function createSsrfSafeDispatcher(): Agent {
  return new Agent({
    connect: {
      lookup: validatingLookup,
    },
  });
}
