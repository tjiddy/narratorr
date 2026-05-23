import { z } from 'zod';
import { createProxyAgent } from './proxy.js';
import { fetchWithOptionalDispatcher, type DispatcherFetchInit } from '../utils/network-service.js';
import { ProxyError, IndexerError } from './errors.js';
import { getErrorMessageWithCause } from '../../shared/error-message.js';
import type { ResolveDownloadContext, WedgeOutcome } from './types.js';
import type { WedgeMode } from '../../shared/schemas/indexer.js';
import { WEDGE_FETCH_TIMEOUT_MS } from '../utils/constants.js';

/** Sentinel prefix used as `SearchResult.downloadUrl` for MAM results — the real torrent is fetched at grab time. */
export const MAM_TORRENT_SENTINEL_PREFIX = 'mam-torrent://';
const MAM_SENTINEL_PATTERN = /^mam-torrent:\/\/(\d+)$/;

export const mamBonusBuyResponseSchema = z.object({
  success: z.boolean().nullish(),
  error: z.string().nullish(),
}).passthrough();

const mamWedgeStatusSchema = z.object({
  wedges: z.number().nullish(),
}).passthrough();

/**
 * Derive the MAM torrent id from the resolve context. Prefers `guid` (when
 * the dispatch path supplied it), else parses the `mam-torrent://{tid}`
 * sentinel emitted by `search()`.
 */
export function parseTorrentIdFromContext(ctx: ResolveDownloadContext): number | undefined {
  if (ctx.guid !== undefined) {
    const n = Number(ctx.guid);
    if (Number.isInteger(n) && n > 0) return n;
  }
  const match = MAM_SENTINEL_PATTERN.exec(ctx.downloadUrl);
  if (match) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return undefined;
}

export function isWedgeFailureOutcome(outcome: WedgeOutcome): boolean {
  return outcome === 'skipped-no-inventory' || outcome === 'skipped-fetch-failed' || outcome === 'failed-spend';
}

export interface WedgeRequestConfig {
  baseUrl: string;
  mamId: string;
  proxyUrl?: string | undefined;
  indexerName: string;
}

async function mamRequest(cfg: WedgeRequestConfig, url: string, method: 'GET' | 'POST', timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const dispatcher = createProxyAgent(cfg.proxyUrl);
  try {
    const fetchOptions: DispatcherFetchInit = {
      method,
      headers: { Cookie: `mam_id=${cfg.mamId}` },
      signal: controller.signal,
      dispatcher,
    };
    let response: Response;
    try {
      response = await fetchWithOptionalDispatcher(url, fetchOptions);
    } catch (error: unknown) {
      if (dispatcher) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw new ProxyError(`Proxy timed out after ${Math.round(timeoutMs / 1000)}s`);
        }
        const msg = getErrorMessageWithCause(error);
        throw new ProxyError(`Proxy connection failed: ${msg}`);
      }
      throw error;
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetch the user's current freeleech-wedge count from `/jsonLoad.php`.
 * Throws IndexerError on shape or transport failure — caller maps to
 * `skipped-fetch-failed` outcome.
 */
export async function fetchCurrentWedges(cfg: WedgeRequestConfig): Promise<number> {
  const url = `${cfg.baseUrl}/jsonLoad.php`;
  const body = await mamRequest(cfg, url, 'GET', WEDGE_FETCH_TIMEOUT_MS);
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (err) {
    throw new IndexerError(cfg.indexerName, 'MAM returned invalid JSON for wedge status', { cause: err instanceof Error ? err : undefined });
  }
  const parsed = mamWedgeStatusSchema.safeParse(raw);
  if (!parsed.success || typeof parsed.data.wedges !== 'number') {
    throw new IndexerError(cfg.indexerName, 'MAM user-status response missing numeric wedges field');
  }
  return parsed.data.wedges;
}

/** POST `/json/bonusBuy.php/{ts}` to spend one wedge on the given torrent id. */
export async function spendWedge(cfg: WedgeRequestConfig, tid: number): Promise<WedgeOutcome> {
  const ts = Math.floor(Date.now() / 1000);
  const url = `${cfg.baseUrl}/json/bonusBuy.php/${ts}?spendtype=personalFL&torrentid=${tid}&timestamp=${ts}`;
  let body: string;
  try {
    body = await mamRequest(cfg, url, 'POST', WEDGE_FETCH_TIMEOUT_MS);
  } catch {
    return 'failed-spend';
  }

  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return 'failed-spend';
  }
  const parsed = mamBonusBuyResponseSchema.safeParse(raw);
  if (!parsed.success) return 'failed-spend';

  if (parsed.data.success === true) return 'spent';
  const error = parsed.data.error ?? '';
  if (error.includes('This Torrent is VIP')) return 'skipped-already-vip';
  if (error.includes('This is already a personal freeleech')) return 'skipped-idempotent';
  return 'failed-spend';
}

/**
 * Decide whether to spend a freeleech wedge. Returns a typed outcome on every
 * non-throwing path.
 */
export async function decideWedgeSpend(
  cfg: WedgeRequestConfig,
  mode: WedgeMode,
  minReserve: number,
  tid: number,
  ctxIsFreeleech: boolean,
): Promise<WedgeOutcome> {
  if (mode === 'never') return 'skipped-mode-never';
  if (ctxIsFreeleech) return 'skipped-already-free';

  let currentWedges: number;
  try {
    currentWedges = await fetchCurrentWedges(cfg);
  } catch {
    return 'skipped-fetch-failed';
  }

  if (currentWedges - minReserve < 1) {
    return 'skipped-no-inventory';
  }

  return spendWedge(cfg, tid);
}
