import type { FastifyBaseLogger } from 'fastify';
import type { ChapterRuntimeOutcome } from '@core/index.js';
import type { DurationConfidenceResult } from './match-job.helpers.js';
import { serializeError } from '../utils/serialize-error.js';

/**
 * Chapter-runtime corroboration (#1942) — the ONE stateful owner of the lazy
 * second-opinion lookup that kills the scalar-vs-chapters false-positive class.
 *
 * Background: `isDurationVerified` compares the scanned file runtime against the
 * provider's `runtimeLengthMin` SCALAR. For a small but real slice of the catalog
 * (measured: 1 of 227 library ASINs, Fablehaven Book 1 / `B00CXXEX8W`, Δ879s)
 * that scalar understates the edition's OWN chapter table by minutes, so a
 * pristine, correct file gets flagged `Duration mismatch`. The chapter table
 * (`GET /books/{asin}/chapters`) is the strictly more authoritative runtime.
 *
 * Because the class is rare (0.4%), the fix must be LAZY: an eager per-book
 * chapters fetch would cost ~230 requests per scan to rescue one book. So the
 * scalar check runs first and the chapter lookup fires only where the scalar
 * check would otherwise flag.
 *
 * Everything stateful lives here rather than in `MetadataService`/`MatchJobService`
 * (both at their `max-lines` budget) or in the provider (a core adapter parses;
 * it must own no cache and no throttle — and it *cannot* bound throttle
 * acquisitions, because the service acquires the throttle before calling it).
 * The collaborators are injected, following `metadata-fix-match.ts` /
 * `metadata-resolve-book.ts`.
 */

/** Collaborators the corroborator borrows from {@link MetadataService}. */
export interface ChapterCorroborationDeps {
  provider: { readonly name: string; getChapterRuntime(asin: string): Promise<ChapterRuntimeOutcome> };
  log: FastifyBaseLogger;
  acquireThrottle(): Promise<void>;
  isRateLimited(providerName: string): boolean;
  getRateLimitRemainingMs(providerName: string): number;
  setRateLimited(providerName: string, durationMs: number): void;
}

export interface ChapterCorroborator {
  /**
   * The edition's chapter-table runtime in SECONDS, or `undefined` when there is
   * no usable one. Never throws and never rejects.
   */
  getChapterRuntimeSeconds(asin: string): Promise<number | undefined>;
}

/**
 * Trust gate (D3). Audnexus publishes `isAccurate` as its own trust flag for the
 * chapter table; without honoring it, provider-declared-INACCURATE chapter data
 * could clear a genuine mismatch — a true-positive loss, the one thing this
 * feature must not trade away. A runtime is usable only when the provider
 * vouches for it AND the value is a finite positive number of milliseconds.
 *
 * Applied to the requested edition's COMPLETE record only (the adapter's `ok`);
 * a record that fails this gate is still an authoritative statement about the
 * edition, so it settles as a definitive "no usable runtime".
 */
function usableChapterSeconds(outcome: { runtimeLengthMs: number | null | undefined; isAccurate: boolean | null | undefined }): number | undefined {
  if (outcome.isAccurate !== true) return undefined;
  const ms = outcome.runtimeLengthMs;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return undefined;
  // ms → SECONDS: the shared duration band is entirely seconds-based
  // (`book-duration-minutes-vs-quality-seconds`).
  return ms / 1000;
}

/**
 * Build a corroborator bound to ONE {@link MetadataService} instance.
 *
 * The cache and the in-flight map are instance state, deliberately NOT module
 * globals: each `MetadataService` is constructed with one immutable region, so an
 * ASIN-only key is correct WITHIN an instance and would silently collide across
 * regions if the maps were shared (a `uk` edition's chapter runtime answering a
 * `us` lookup).
 *
 * **Cache policy — a closed allowlist of authoritative edition verdicts.** Only a
 * verdict *about this edition* settles:
 *
 * | Adapter outcome | Cached |
 * |---|---|
 * | `ok` (the requested edition's complete record) → usable seconds, or a trust-fail "none" | yes |
 * | `not_found` (documented HTTP 400/404 — Audnexus asserts the ASIN is absent) | yes |
 * | `invalid_record` (a 200 that is not this edition's complete record) | no |
 * | `rate_limited` / `transient_failure` | no |
 *
 * Everything not in the allowlist is transient by default, so there is no third
 * state and no gap: a transient outcome re-requests next time and a later success
 * promotes. What settles is the DERIVED verdict (`seconds | none`), never raw
 * fields — so no wrong-edition body and no error envelope can ever enter the cache.
 *
 * **Concurrency.** Match jobs resolve up to five books at once through one shared
 * `MetadataService`, so same-ASIN lookups are single-flight with the throttle
 * acquisition INSIDE the coalesced operation: exactly one throttle acquisition and
 * one HTTP request per settle. Entries are evicted on settle (the
 * `book-admission.ts` mechanic), so coalescing is concurrency-only — a transient
 * outcome shared with waiters leaves no cache entry behind.
 */
export function createChapterCorroborator(deps: ChapterCorroborationDeps): ChapterCorroborator {
  /** Settled DEFINITIVE verdicts. Presence of the key — not the value — means "settled". */
  const settled = new Map<string, number | undefined>();
  const inFlight = new Map<string, Promise<number | undefined>>();

  async function classify(asin: string): Promise<number | undefined> {
    const outcome = await deps.provider.getChapterRuntime(asin);
    switch (outcome.kind) {
      case 'ok': {
        const seconds = usableChapterSeconds(outcome);
        settled.set(asin, seconds);
        deps.log.debug(
          { asin, runtimeLengthMs: outcome.runtimeLengthMs, isAccurate: outcome.isAccurate, chapterSeconds: seconds },
          seconds === undefined
            ? 'Chapter runtime not usable (trust gate) — settled'
            : 'Chapter runtime resolved — settled',
        );
        return seconds;
      }
      case 'not_found':
        settled.set(asin, undefined);
        deps.log.debug({ asin }, 'Chapter runtime unavailable for ASIN (documented 400/404) — settled');
        return undefined;
      case 'rate_limited':
        // Feed the FINITE window back into the shared provider-wide gate so the
        // immediately subsequent Audnexus call short-circuits instead of piling on.
        deps.setRateLimited(deps.provider.name, outcome.retryAfterMs);
        return undefined;
      case 'invalid_record':
        deps.log.debug({ asin, reason: outcome.reason }, 'Chapter response was not this edition\'s complete record — not settled');
        return undefined;
      case 'transient_failure':
        deps.log.debug({ asin, message: outcome.message }, 'Chapter lookup failed transiently — not settled');
        return undefined;
    }
  }

  async function lookup(asin: string): Promise<number | undefined> {
    try {
      if (deps.isRateLimited(deps.provider.name)) {
        deps.log.debug(
          { asin, remainingMs: deps.getRateLimitRemainingMs(deps.provider.name) },
          'Chapter lookup skipped — provider rate limited',
        );
        return undefined;
      }
      // Inside the coalesced op, so waiters cost neither a throttle slot nor a request.
      await deps.acquireThrottle();
      return await classify(asin);
    } catch (error: unknown) {
      // The adapter never throws, but a corroboration failure must never escape
      // into `matchSingleBook`'s catch (where it would become `confidence: 'none'`).
      deps.log.debug({ error: serializeError(error), asin }, 'Chapter corroboration failed — falling back to the scalar verdict');
      return undefined;
    }
  }

  return {
    async getChapterRuntimeSeconds(asin: string): Promise<number | undefined> {
      if (settled.has(asin)) return settled.get(asin);

      const existing = inFlight.get(asin);
      if (existing) return existing;

      const promise = lookup(asin);
      inFlight.set(asin, promise);
      try {
        return await promise;
      } finally {
        if (inFlight.get(asin) === promise) inFlight.delete(asin);
      }
    },
  };
}

/** Inputs to {@link corroborateDurationVerdict}. */
export interface CorroborateDurationArgs {
  /** The verdict the SYNC scalar check already produced. */
  verdict: DurationConfidenceResult;
  /** The chosen top candidate's ASIN — the chapter lookup key. */
  asin: string | undefined;
  /** Candidate folder path, for the debug trail. */
  path: string;
  log: FastifyBaseLogger;
  lookupChapterSeconds(asin: string): Promise<number | undefined>;
  /** Re-run the SAME sync helper, now with the chapter runtime as a second reference. */
  recheck(chapterSeconds: number): DurationConfidenceResult;
}

export interface CorroboratedDuration {
  verdict: DurationConfidenceResult;
  /** The usable chapter runtime in SECONDS, when one was fetched and consulted. */
  chapterSeconds?: number;
}

/**
 * The lazy trigger. Given an already-computed scalar duration verdict, fetch the
 * edition's chapter runtime and re-check — but ONLY when it can change anything.
 *
 * Fires only for `reasonKind: 'duration-mismatch'` with a non-empty ASIN. A
 * scalar-VERIFIED match, an ambiguity-class review (`no-duration-data`), and a
 * missing-duration review all issue ZERO fetches; a qualifying mismatch issues
 * exactly one (deduped further by the corroborator's cache + single-flight).
 *
 * Suppress-only: the re-check runs the same helper with an extra corroborating
 * reference, so it can only ever promote a would-be mismatch to `high`. It never
 * demotes a scalar-verified match, and a file out of band against BOTH references
 * flags exactly as it does today.
 *
 * Degrades silently to the scalar verdict on any failure — a corroboration error
 * must not reach `matchSingleBook`'s catch, where it would become
 * `confidence: 'none'` and lose the match entirely.
 */
export async function corroborateDurationVerdict(args: CorroborateDurationArgs): Promise<CorroboratedDuration> {
  const { verdict, path, log } = args;
  if (verdict.reasonKind !== 'duration-mismatch') return { verdict };

  const asin = args.asin?.trim();
  if (!asin) {
    log.debug({ path }, 'Duration mismatch with no ASIN — skipping chapter corroboration');
    return { verdict };
  }

  let chapterSeconds: number | undefined;
  try {
    chapterSeconds = await args.lookupChapterSeconds(asin);
  } catch (error: unknown) {
    log.debug({ error: serializeError(error), path, asin }, 'Chapter corroboration failed — keeping the scalar duration verdict');
    return { verdict };
  }
  if (chapterSeconds === undefined) return { verdict };

  const rechecked = args.recheck(chapterSeconds);
  log.debug(
    { path, asin, chapterSeconds, promoted: rechecked.reasonKind !== 'duration-mismatch' },
    'Chapter-runtime corroboration applied to a would-be duration mismatch',
  );
  return { verdict: rechecked, chapterSeconds };
}
