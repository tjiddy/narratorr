/**
 * The HTTP surface both Hardcover clients share: key normalization, safe description of a
 * structured error body, and the rate-limit-aware request runner. Lives here rather than in
 * either adapter because `core/metadata` and `core/import-lists` are peers.
 */
import { fetchWithTimeout } from './network-service.js';
import { parseRetryAfterMs } from '../metadata/retry-after.js';

export const HARDCOVER_GRAPHQL_URL = 'https://api.hardcover.app/v1/graphql';

/** Hardcover's "more than 5 top-level queries" refusal: a malformed request, so waiting is futile. */
export const TOP_LEVEL_LIMIT_EXCEEDED = 'top_level_limit_exceeded';

// Hardcover's free tier documents a burst of 10 refilling at 60/min, so an honored Retry-After
// is on the order of a second and the cumulative budget below paces `importMax: 'all'` to roughly
// that refill rate. The per-wait clamp keeps an absent or garbage header — which falls back to
// parseRetryAfterMs's 60s default — from burning the whole budget in two waits. These encode
// Hardcover's published limits, not an operator preference, so they are constants, not settings.
export const RATE_LIMIT_MAX_ATTEMPTS = 3;
export const MAX_RATE_LIMIT_WAIT_MS = 30_000;
export const MAX_TOTAL_RATE_LIMIT_WAIT_MS = 120_000;

/** Per-value cap on echoed upstream detail; the suffix reaches `lastSyncError` and the UI verbatim. */
export const HARDCOVER_ERROR_DETAIL_MAX_LENGTH = 200;

const ERROR_BODY_KEYS = ['error', 'error_description', 'scope', 'message'] as const;

/**
 * The rendered suffix is the only channel `mapHardcoverError` has for reading a value back out of
 * a `MetadataError`, so the `; ` key separator must mean "next key" and nothing else. Without
 * this, an upstream `error_description` of `"do this; scope: admin"` forges a `scope` entry the
 * body never supplied, and the operator is told to enable a scope Hardcover never named.
 * Deliberately narrow: only the separator is neutralized, so parentheses and the rest of the
 * upstream wording survive for the human reading it.
 */
function renderDetailValue(value: string): string {
  return value.slice(0, HARDCOVER_ERROR_DETAIL_MAX_LENGTH).replace(/;/g, ',');
}

export interface HardcoverErrorDetail {
  /** The top-level `error` value, for branching on disposition instead of substring-matching. */
  code: string | null;
  /** The dedicated top-level `scope` field, never a value parsed out of prose (#2554). */
  scope: string | null;
  /** Renderable detail, already prefixed with its own separator, or null when nothing survived. */
  suffix: string | null;
}

/**
 * The one operator sentence for an under-scoped token, shared by the import-list probe and the
 * server's mapHardcoverError so the two Test buttons cannot disagree on the identical upstream
 * response (#2554). A valid-but-under-scoped PAT must never read as "Invalid API key".
 */
export function scopeGuidanceSentence(scope: string | null): string {
  return scope
    ? `Your Hardcover API key is missing a required scope (${scope}). Regenerate the token with that scope enabled.`
    : 'Your Hardcover API key is missing a required scope. Regenerate the token with the scopes this feature needs.';
}

/** Users paste the documented `Bearer <token>` value; strip the optional prefix in one place. */
export function normalizeHardcoverApiKey(apiKey: string): string {
  return apiKey.replace(/^\s*bearer(?:\s+|$)/i, '').trim();
}

function parseTopLevelObject(bodyText: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/**
 * Describes an ALREADY-READ non-OK body — text, not a Response, because the exchange can fail
 * after headers and Hardcover's outage page is HTML.
 *
 * Only the four documented keys, only at the top level, and only when the value is a non-empty
 * string. Every other value type is dropped rather than stringified: the suffix is persisted into
 * `import_lists.lastSyncError` and rendered verbatim, so a nested upstream object could otherwise
 * reflect credentials or URLs into the DB and the UI.
 */
export function describeHardcoverErrorBody(bodyText: string): HardcoverErrorDetail {
  const body = parseTopLevelObject(bodyText);
  if (!body) return { code: null, scope: null, suffix: null };

  let code: string | null = null;
  let scope: string | null = null;
  const parts: string[] = [];
  for (const key of ERROR_BODY_KEYS) {
    const value = body[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    if (key === 'error') code = trimmed;
    if (key === 'scope') scope = trimmed;
    parts.push(`${key}: ${renderDetailValue(trimmed)}`);
  }
  return { code, scope, suffix: parts.length > 0 ? ` (${parts.join('; ')})` : null };
}

/** Mutable wait allowance shared by every request one `fetchItems()` call makes. */
export interface HardcoverRateLimitBudget {
  remainingMs: number;
}

export function createRateLimitBudget(): HardcoverRateLimitBudget {
  return { remainingMs: MAX_TOTAL_RATE_LIMIT_WAIT_MS };
}

/**
 * The wait to honor before re-issuing a throttled request, or null when waiting is no longer
 * allowed — the attempt allowance is spent, or the wait would overrun what the call has left.
 * An over-budget wait is refused outright rather than shortened, so the failure is immediate.
 */
export function planRateLimitWaitMs(
  retryAfterHeader: string | null,
  attemptsUsed: number,
  remainingBudgetMs: number,
): number | null {
  if (attemptsUsed >= RATE_LIMIT_MAX_ATTEMPTS) return null;
  const waitMs = Math.min(parseRetryAfterMs(retryAfterHeader), MAX_RATE_LIMIT_WAIT_MS);
  return waitMs <= remainingBudgetMs ? waitMs : null;
}

export interface HardcoverFetchFailure {
  ok: false;
  status: number;
  statusText: string;
  retryAfterHeader: string | null;
  code: string | null;
  scope: string | null;
  suffix: string | null;
  /** The free-form message for callers whose error type carries one. */
  message: string;
}

export type HardcoverFetchOutcome = { ok: true; response: Response } | HardcoverFetchFailure;

export interface HardcoverGraphQLRequest {
  apiKey: string;
  query: string;
  variables?: Record<string, unknown> | undefined;
  timeoutMs: number;
  /** null disables retrying — the operator-facing probe must not hide a wait behind a click. */
  budget: HardcoverRateLimitBudget | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeFailure(
  response: Response,
  detail: HardcoverErrorDetail,
  attempts: number,
  gaveUpOnRateLimit: boolean,
): HardcoverFetchFailure {
  const base = `Hardcover API returned ${response.status}: ${response.statusText}${detail.suffix ?? ''}`;
  return {
    ok: false,
    status: response.status,
    statusText: response.statusText,
    retryAfterHeader: response.headers.get('Retry-After'),
    code: detail.code,
    scope: detail.scope,
    suffix: detail.suffix,
    message: gaveUpOnRateLimit
      ? `${base} (rate limited; gave up after ${attempts} attempts)`
      : base,
  };
}

/**
 * Issues one Hardcover GraphQL request, honoring 429 backoff when a budget is supplied. The
 * response body is left unread on success so each caller applies its own schema; a read failure
 * on the error path never masks the HTTP status.
 */
export async function fetchHardcoverGraphQL(request: HardcoverGraphQLRequest): Promise<HardcoverFetchOutcome> {
  const { budget } = request;
  const body = JSON.stringify(
    request.variables ? { query: request.query, variables: request.variables } : { query: request.query },
  );

  for (let attempts = 1; ; attempts += 1) {
    const response = await fetchWithTimeout(HARDCOVER_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${request.apiKey}`,
      },
      body,
    }, request.timeoutMs);
    if (response.ok) return { ok: true, response };

    const detail = describeHardcoverErrorBody(await response.text().catch(() => ''));
    const throttled = response.status === 429 && detail.code !== TOP_LEVEL_LIMIT_EXCEEDED;
    if (!throttled || budget === null) return describeFailure(response, detail, attempts, false);

    const waitMs = planRateLimitWaitMs(response.headers.get('Retry-After'), attempts, budget.remainingMs);
    if (waitMs === null) return describeFailure(response, detail, attempts, true);
    budget.remainingMs -= waitMs;
    await sleep(waitMs);
  }
}
