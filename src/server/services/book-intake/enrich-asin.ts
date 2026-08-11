import type { FastifyBaseLogger } from 'fastify';
import { canonicalizeAsin } from '@shared/asin.js';
import { serializeError } from '../../utils/serialize-error.js';
import type { MetadataService } from '../metadata.service.js';
import type { AddBookItem } from './add-book.js';

export interface AsinEnrichmentDeps {
  /** Named for `BookRouteDeps.metadataService`, which is what makes `POST /api/books` satisfy this
   * port structurally. The existing `resolver` port cannot double as it: the route deps carry no
   * field by that name, so widening it would have wired nothing and shipped as a green no-op. */
  metadataService?: Pick<MetadataService, 'getBook'> | undefined;
}

export interface AsinEnrichment {
  item: AddBookItem;
  /** The provider was ASKED, whatever it answered. This — not the ASIN being set — is what strips
   * `providerId` from the create payload: a lookup that found nothing has still spent the one
   * fetch this add is allowed, and forwarding the key would let `resolveCreateInput` repeat it. */
  attempted: boolean;
}

/**
 * The whole lookup precondition, and both narrowings it produces: a port, an author, no usable
 * caller ASIN, and a non-empty provider id. Clauses 3 and 4 reproduce `resolveCreateInput`'s own
 * truthiness checks, so moving the lookup earlier does not change WHICH items get one.
 *
 * The author clause is load-bearing, not defensive: `gatherIncumbentIds`'s exact-title zero-author
 * arm only runs for a candidate with no canonical ASIN, so enriching an authorless item would make
 * the duplicate check see FEWER incumbents than it does today.
 */
function lookupTarget(
  deps: AsinEnrichmentDeps,
  item: AddBookItem,
): { metadataService: Pick<MetadataService, 'getBook'>; providerId: string } | null {
  const { metadataService } = deps;
  const { providerId } = item;
  if (!metadataService || item.authors.length === 0) return null;
  if (canonicalizeAsin(item.asin) !== null) return null;
  if (providerId === undefined || providerId === '') return null;
  return { metadataService, providerId };
}

/**
 * Resolve `providerId → asin` BEFORE the duplicate decision, so the verdict and the row key on one
 * identity (#2249). A provider failure is not evidence of a duplicate: it is logged and the add
 * proceeds on whatever identity the caller supplied.
 */
export async function enrichAsinBeforeDecision(
  deps: AsinEnrichmentDeps,
  item: AddBookItem,
  log: FastifyBaseLogger,
): Promise<AsinEnrichment> {
  const target = lookupTarget(deps, item);
  if (!target) return { item, attempted: false };

  const { providerId } = target;
  try {
    const detail = await target.metadataService.getBook(providerId);
    const asin = detail?.asin;
    // The provider's RAW value: canonicalization already has one home per side —
    // `gatherIncumbentIds` for the decision, `createResolved` for the row.
    if (asin !== undefined && canonicalizeAsin(asin) !== null) {
      log.info({ title: item.title, providerId, asin }, 'Enriched book with ASIN from provider');
      return { item: { ...item, asin }, attempted: true };
    }
  } catch (error: unknown) {
    log.warn({ error: serializeError(error), providerId }, 'ASIN enrichment failed');
  }
  // No signal: leave the caller's own `asin` untouched, so an absent key stays absent and a blank
  // stays blank rather than being overwritten with the provider's blank.
  return { item, attempted: true };
}
