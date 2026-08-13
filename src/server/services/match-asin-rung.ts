import type { FastifyBaseLogger } from 'fastify';
import type { BookMetadata } from '@core/metadata/index.js';
import { canonicalizeAsin, isAudibleAsin } from '@shared/asin.js';
import { readOpfMetadata } from '../utils/opf-reader.js';
import { serializeError } from '../utils/serialize-error.js';
import type { TagSearchOutcome } from './tag-search-planner.js';

/** The two identity sources a book carries on disk, in probe order. */
export type AsinRungSource = 'asin-opf' | 'asin-tag';

export interface AsinRungDeps {
  metadataService: { getBook(id: string): Promise<BookMetadata | null> };
  log: FastifyBaseLogger;
}

interface AsinCandidate {
  asin: string;
  source: AsinRungSource;
}

/**
 * Ordered, deduplicated identification candidates. The sidecar wins over the embedded tag because
 * it is the one the operator's own tooling curates; an equal canonical value from the second source
 * is dropped so a book costs at most one provider call per distinct ASIN it actually carries.
 *
 * `readOpfMetadata` is contractually never-throwing; a violation propagates so the caller's per-book
 * catch degrades that book alone.
 */
async function collectCandidates(
  log: FastifyBaseLogger,
  path: string,
  tagAsin: string | undefined,
): Promise<AsinCandidate[]> {
  const opf = await readOpfMetadata(path, log);
  const raw: { source: AsinRungSource; value: string | null | undefined }[] = [
    { source: 'asin-opf', value: opf?.asin },
    { source: 'asin-tag', value: tagAsin },
  ];

  const candidates: AsinCandidate[] = [];
  const seen = new Set<string>();
  for (const { source, value } of raw) {
    const canonical = canonicalizeAsin(value);
    if (canonical === null) continue;
    if (!isAudibleAsin(canonical)) {
      log.debug({ path, source, asin: canonical }, 'ASIN identification candidate rejected — not a full-string Audible ASIN');
      continue;
    }
    if (seen.has(canonical)) {
      log.debug({ path, source, asin: canonical }, 'ASIN identification candidate skipped — duplicate of an earlier source');
      continue;
    }
    seen.add(canonical);
    candidates.push({ asin: canonical, source });
    log.debug({ path, source, asin: canonical }, 'ASIN identification candidate found');
  }
  return candidates;
}

/** Resolve one candidate. Misses and provider failures are ordinary fall-throughs, not errors. */
async function probe(deps: AsinRungDeps, path: string, candidate: AsinCandidate): Promise<TagSearchOutcome | null> {
  const { log } = deps;
  const { asin, source } = candidate;
  try {
    const found = await deps.metadataService.getBook(asin);
    if (!found) {
      log.debug({ path, source, asin }, 'ASIN identification rung missed — falling through');
      return null;
    }
    log.debug({ path, source, asin, title: found.title }, 'ASIN identification rung resolved');
    return {
      scored: [{ meta: found, score: 1.0 }],
      attempt: { title: found.title, author: found.authors[0]?.name ?? '', source, maxConfidence: 'high' },
    };
  } catch (error: unknown) {
    // In practice the throttle gate turns provider failures into a null; this is defence in depth.
    log.debug({ error: serializeError(error), path, source, asin }, 'ASIN identification rung errored — falling through');
    return null;
  }
}

/**
 * Identify a book by an exact ASIN it already carries, before any text search runs. A curated title
 * that has diverged from the catalog's ("The Gunslinger" vs "Dark Tower I") is unmatchable by text
 * and exactly what this rung exists to survive, so the title-similarity floor is deliberately not
 * applied to its result. `null` means no usable ASIN resolved and the caller should fall through.
 */
export async function runAsinIdentificationRung(
  deps: AsinRungDeps,
  path: string,
  tagAsin: string | undefined,
): Promise<TagSearchOutcome | null> {
  for (const candidate of await collectCandidates(deps.log, path, tagAsin)) {
    const outcome = await probe(deps, path, candidate);
    if (outcome) return outcome;
  }
  return null;
}
