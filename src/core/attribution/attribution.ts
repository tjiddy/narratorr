import { z } from 'zod';
import {
  EARWITNESS_ATTRIBUTION_TIMEOUT_MS,
  EARWITNESS_ATTRIBUTION_MAX_RETRIES,
  EARWITNESS_ATTRIBUTION_DEFAULT_BACKOFF_MS,
  EARWITNESS_ATTRIBUTION_MAX_BACKOFF_MS,
} from '../utils/constants.js';
import { fetchWithTimeout } from '../utils/network-service.js';
import { getErrorMessage } from '../../shared/error-message.js';

/**
 * narratorr-side client for earwitness's locked `POST /api/v1/attribution`
 * contract (v0.2.1). Pure server-side adapter: builds the request, calls
 * earwitness, validates the 200 response, and branches on HTTP STATUS alone.
 *
 * Per the v0.2.1 split, status fully determines handling — never parse the flat
 * `{ error: string }` body for a code:
 *   - 200          → resolved; parse + return `ok` (`attributionPresent:false`
 *                    is a valid scanned-but-no-credit result, not an error).
 *   - 503          → transient; bounded retry honoring `Retry-After`, then
 *                    `transient_failure`.
 *   - 422 / other 4xx → permanent; `permanent_failure` carrying the message,
 *                    never retried.
 *
 * Core adapters do not read narratorr settings or log (see CLAUDE.md): the
 * caller resolves config (sentinel apiKey, baseUrl) and passes credentials,
 * timeout, and an optional abort signal in as explicit inputs.
 */

// String-join target (not `new URL(path, base)`) so a pathful baseUrl like
// https://host/earwitness/ keeps its prefix → .../earwitness/api/v1/attribution.
// Mirrors probeEarwitness's join in src/server/routes/settings.ts.
const EARWITNESS_ATTRIBUTION_PATH = '/api/v1/attribution';

// --- Request schema (only path/expected/requestId are serialized into the body) ---

export const attributionExpectedSchema = z.object({
  title: z.string().optional(),
  authors: z.array(z.string()).optional(),
  narrators: z.array(z.string()).optional(),
});

export const attributionRequestSchema = z.object({
  path: z.string(),
  expected: attributionExpectedSchema.optional(),
  requestId: z.string().optional(),
});

// --- Response schema (locked 200 contract). Nullable provider fields use
// `.nullish()` (external APIs return null — CLAUDE.md), passthrough nested
// objects for provider forward-compat while keeping required fields strict. ---

const singleFieldComparisonSchema = z.object({
  status: z.enum(['match', 'mismatch', 'unknown']),
  expected: z.string().nullish(),
  detected: z.string().nullish(),
  reason: z.string(),
}).passthrough();

const multiFieldComparisonSchema = z.object({
  status: z.enum(['match', 'mismatch', 'partial', 'unknown']),
  expected: z.array(z.string()),
  detected: z.array(z.string()),
  matched: z.array(z.object({ expected: z.string(), detected: z.string() }).passthrough()),
  missingExpected: z.array(z.string()),
  unexpectedDetected: z.array(z.string()),
  reason: z.string(),
}).passthrough();

const detectionSchema = z.object({
  attributionPresent: z.boolean(),
  detected: z.object({
    title: z.string().nullish(),
    authors: z.array(z.string()),
    narrators: z.array(z.string()),
  }).passthrough(),
  evidence: z.object({
    title: z.string().nullish(),
    author: z.string().nullish(),
    narrator: z.string().nullish(),
  }).passthrough(),
  confidence: z.number(), // 0..1 RAW — never thresholded here
}).passthrough();

const comparisonSchema = z.object({
  status: z.enum(['match', 'mismatch', 'partial', 'unknown']),
  fields: z.object({
    title: singleFieldComparisonSchema,
    authors: multiFieldComparisonSchema,
    narrators: multiFieldComparisonSchema,
  }).passthrough(),
}).passthrough();

export const attributionResponseSchema = z.object({
  requestId: z.string().nullish(),
  detection: detectionSchema,
  comparison: comparisonSchema.nullish(),
}).passthrough();

export type AttributionExpected = z.infer<typeof attributionExpectedSchema>;
export type AttributionDetection = z.infer<typeof detectionSchema>;
export type AttributionComparison = z.infer<typeof comparisonSchema>;

/**
 * Discriminated outcome union — carries enough context for the calling service
 * to branch and log. Three kinds only:
 *  - `ok`                 — parsed 200 (comparison present iff `expected` sent).
 *  - `permanent_failure`  — 422/other 4xx, OR a malformed 200 (provider contract
 *                           drift; retrying won't help), carrying `status`.
 *  - `transient_failure`  — exhausted 503, or a transport/timeout/abort error;
 *                           carries the last honored `retryAfterMs` for 503s.
 */
export type AttributionResult =
  | { kind: 'ok'; requestId: string | null; detection: AttributionDetection; comparison?: AttributionComparison }
  | { kind: 'permanent_failure'; status: number; message: string }
  | { kind: 'transient_failure'; message: string; retryAfterMs?: number };

export interface AnalyzeAttributionInput {
  baseUrl: string;
  apiKey: string;
  path: string;
  expected?: AttributionExpected;
  requestId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Build the POST body — `path` always, `expected`/`requestId` omitted (not
 * sent as null/undefined) when not provided. baseUrl/apiKey/timeoutMs never
 * appear in the body. */
function buildRequestBody(input: AnalyzeAttributionInput): z.infer<typeof attributionRequestSchema> {
  const body: z.infer<typeof attributionRequestSchema> = { path: input.path };
  if (input.expected !== undefined) body.expected = input.expected;
  if (input.requestId !== undefined) body.requestId = input.requestId;
  return attributionRequestSchema.parse(body);
}

/** Surface earwitness's flat `{ error: string }` body as a message. Never parses
 * the body for a code — branching is status-only. Falls back to a status-based
 * message when the body is missing/unparseable. */
async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
      return (body as { error: string }).error;
    }
  } catch {
    // non-JSON / empty body — fall through to the status-based message
  }
  return `earwitness returned HTTP ${res.status}`;
}

/** Resolve the next 503 backoff: a present, non-negative numeric `Retry-After`
 * (seconds) clamped to the max; otherwise the fixed default. Guards against
 * `NaN` from a missing/blank/non-numeric header. */
function resolveRetryAfterMs(res: Response): number {
  const header = res.headers.get('Retry-After');
  if (header !== null && header.trim().length > 0) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, EARWITNESS_ATTRIBUTION_MAX_BACKOFF_MS);
    }
  }
  return EARWITNESS_ATTRIBUTION_DEFAULT_BACKOFF_MS;
}

/** Sleep that also resolves early (rejecting) if the caller aborts mid-backoff. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
    }, { once: true });
  });
}

/** Validate a 200 body against the locked contract. Malformed/unexpected-shape
 * payloads become a typed `permanent_failure` (provider contract drift — not
 * retryable), never an unhandled throw. */
async function parseOkResponse(res: Response): Promise<AttributionResult> {
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { kind: 'permanent_failure', status: 200, message: 'Unexpected earwitness response (invalid JSON)' };
  }
  const parsed = attributionResponseSchema.safeParse(json);
  if (!parsed.success) {
    return { kind: 'permanent_failure', status: 200, message: 'Unexpected earwitness response shape' };
  }
  const data = parsed.data;
  const result: AttributionResult = {
    kind: 'ok',
    requestId: data.requestId ?? null,
    detection: data.detection,
  };
  if (data.comparison != null) result.comparison = data.comparison;
  return result;
}

/**
 * POST to `{baseUrl}/api/v1/attribution` with `X-Api-Key`, returning the parsed
 * `AttributionResult` or a typed failure. A dedicated, deterministic (no jitter)
 * bounded retry loop handles 503 — `requestWithRetry` is deliberately NOT reused
 * (its fixed pre-loop delay, built-in jitter, and DownloadClientError wrapping
 * don't fit a per-response `Retry-After` + typed-result contract; see the issue).
 */
export async function analyzeAttribution(input: AnalyzeAttributionInput): Promise<AttributionResult> {
  const { baseUrl, apiKey, timeoutMs = EARWITNESS_ATTRIBUTION_TIMEOUT_MS, signal } = input;
  const url = baseUrl.replace(/\/+$/, '') + EARWITNESS_ATTRIBUTION_PATH;
  const serialized = JSON.stringify(buildRequestBody(input));
  const headers = { 'Content-Type': 'application/json', 'X-Api-Key': apiKey };

  let retryAfterMs: number | undefined;
  let message = 'earwitness service unavailable';

  for (let attempt = 0; attempt <= EARWITNESS_ATTRIBUTION_MAX_RETRIES; attempt++) {
    let res: Response;
    try {
      res = await fetchWithTimeout(url, { method: 'POST', headers, body: serialized }, timeoutMs, signal);
    } catch (error: unknown) {
      // Transport error, timeout, or caller abort — typed failure, no unhandled throw.
      return { kind: 'transient_failure', message: getErrorMessage(error) };
    }

    if (res.status === 200) return parseOkResponse(res);

    if (res.status === 503) {
      message = await readErrorMessage(res);
      retryAfterMs = resolveRetryAfterMs(res);
      if (attempt < EARWITNESS_ATTRIBUTION_MAX_RETRIES) {
        try {
          await sleep(retryAfterMs, signal);
        } catch (error: unknown) {
          return { kind: 'transient_failure', message: getErrorMessage(error), retryAfterMs };
        }
        continue;
      }
      return { kind: 'transient_failure', message, retryAfterMs };
    }

    // 422 / other 4xx — permanent, status-only, message surfaced not parsed.
    return { kind: 'permanent_failure', status: res.status, message: await readErrorMessage(res) };
  }

  // Unreachable (the loop returns on the final 503 attempt) — keeps TS exhaustive.
  return retryAfterMs !== undefined
    ? { kind: 'transient_failure', message, retryAfterMs }
    : { kind: 'transient_failure', message };
}
