import type { FastifyBaseLogger } from 'fastify';
import { RateLimitError, TransientError } from '@core/index.js';
import type { BookMetadata } from '@core/metadata/types.js';
import { normalizeProductionType } from '@core/metadata/production-type.js';
import { pickPrimarySeries } from '@shared/pick-primary-series.js';
import type { ProductionType } from '@shared/schemas/book.js';
import { getErrorMessage } from '../../utils/error-message.js';
import type { MetadataService } from '../metadata.service.js';
import type { AddBookItem } from './add-book.js';

/**
 * Whether the resolved match or the caller owns the row's identity. `adopt` is the import-list rule:
 * a shelf item's title/author are user data and the provider's are canonical. `pin` is the Series
 * card's: the card's library pool is keyed on `books.seriesName`, so a row created under the
 * provider's series name is not on the card the operator was looking at, and its member stays
 * `+ Add` forever. Enrichment fills-if-empty, so a pinned row still gets the canonical title later.
 */
export type IdentityPolicy = 'pin' | 'adopt';

/**
 * What a bulk caller actually holds before the provider is asked: its own identity plus the raw
 * side hints a list item may carry. Deliberately NOT an `AddBookItem` — a seed has a bare
 * `author?: string` where the write item requires an `authors: { name }[]`, and it is the resolve
 * step that turns one into the other.
 */
export interface AddBookSeed {
  title: string;
  author?: string | undefined;
  asin?: string | undefined;
  /** A lookup hint only — the resolver falls through to these when `asin` misses; never persisted. */
  alternateAsins?: string[] | undefined;
  isbn?: string | undefined;
  coverUrl?: string | undefined;
  description?: string | undefined;
  seriesName?: string | undefined;
  seriesPosition?: number | undefined;
}

export interface AddBookResolveDeps {
  /** Optional because `ImportListService.metadata` is: an unconfigured provider creates raw rows. */
  resolver?: Pick<MetadataService, 'resolveBook'> | undefined;
}

/** The row the write item will be built from: caller identity and resolved enrichment, merged. */
interface ResolvedRow {
  title: string;
  authorName?: string | undefined;
  coverUrl?: string | undefined;
  subtitle?: string | undefined;
  description?: string | undefined;
  publisher?: string | undefined;
  seriesName?: string | undefined;
  seriesPosition?: number | undefined;
  narrators?: string[] | undefined;
  duration?: number | undefined;
  publishedDate?: string | undefined;
  genres?: string[] | undefined;
  asin?: string | undefined;
  isbn?: string | undefined;
  productionType?: ProductionType | undefined;
}

/**
 * Kept verbatim: the import-list operator log contract is asserted on this text, and the `adopt`
 * policy has exactly one caller.
 */
const IDENTITY_ADOPTED = 'Import-list metadata disagrees with raw provider fields; adopting resolved metadata';

/**
 * Debug, not warn, unlike its adopt twin: under `pin` a provider title routinely carries a subtitle
 * or series tail the card's does not, so a disagreement is the ordinary case rather than a surprise.
 */
const IDENTITY_PINNED = 'Resolved metadata disagrees with the requested identity; pinning the caller identity';

/**
 * The `resolve: 'required'` arm's whole job: ask the provider, merge the answer with the caller's
 * identity under its policy, and hand back the write item the shared pipeline decides and creates
 * from. Nothing here reads or writes the library.
 */
export async function buildResolvedItem(
  deps: AddBookResolveDeps,
  seed: AddBookSeed,
  identity: IdentityPolicy,
  importListId: number | undefined,
  log: FastifyBaseLogger,
): Promise<AddBookItem> {
  const { match, enrichmentStatus } = await resolveMatch(deps, seed, identity, log);
  const row = buildRow(seed, match, identity);
  return {
    title: row.title,
    authors: row.authorName ? [{ name: row.authorName }] : [],
    narrators: row.narrators,
    subtitle: row.subtitle,
    description: row.description,
    publisher: row.publisher,
    coverUrl: row.coverUrl,
    asin: row.asin,
    isbn: row.isbn,
    seriesName: row.seriesName,
    seriesPosition: row.seriesPosition,
    duration: row.duration,
    publishedDate: row.publishedDate,
    genres: row.genres,
    productionType: row.productionType,
    status: 'wanted',
    // Key-absent, not `undefined`: only a genuine no-match may narrow the enrichment state, and a
    // provider failure must leave whatever default the create primitive applies.
    ...(enrichmentStatus && { enrichmentStatus }),
    ...(importListId !== undefined && { importListId }),
  };
}

/** Preserve `failed` for a genuine no-match only; a provider that failed is not evidence of one. */
async function resolveMatch(
  deps: AddBookResolveDeps,
  seed: AddBookSeed,
  identity: IdentityPolicy,
  log: FastifyBaseLogger,
): Promise<{ match: BookMetadata | null; enrichmentStatus: 'failed' | undefined }> {
  if (!deps.resolver) return { match: null, enrichmentStatus: undefined };
  try {
    const match = await deps.resolver.resolveBook({
      asin: seed.asin,
      title: seed.title,
      author: seed.author,
      // Key-absent, not `undefined`: a seed with no alternates must reach the resolver with exactly
      // the object it receives today, the same reason `enrichmentStatus` is spread above.
      ...(seed.alternateAsins !== undefined && { alternateAsins: seed.alternateAsins }),
    });
    if (match) {
      logIdentityMismatch(seed, match, identity, log);
      return { match, enrichmentStatus: undefined };
    }
    // A genuine no-match becomes failed so the one-hour search retry can recover it.
    return { match: null, enrichmentStatus: 'failed' };
  } catch (error: unknown) {
    if (error instanceof RateLimitError) {
      // Provider failures stay pending; they are not evidence of no match.
      log.warn({ title: seed.title, provider: error.provider, retryAfterMs: error.retryAfterMs }, 'Metadata resolution rate limited; leaving book pending');
      return { match: null, enrichmentStatus: undefined };
    }
    if (error instanceof TransientError) {
      log.warn({ title: seed.title, provider: error.provider }, 'Metadata resolution hit a transient provider error; leaving book pending');
      return { match: null, enrichmentStatus: undefined };
    }
    log.warn({ title: seed.title, error: getErrorMessage(error) }, 'Metadata enrichment failed');
    return { match: null, enrichmentStatus: undefined };
  }
}

function logIdentityMismatch(
  seed: AddBookSeed,
  match: BookMetadata,
  identity: IdentityPolicy,
  log: FastifyBaseLogger,
): void {
  const metadataAuthor = match.authors[0]?.name;
  const titleDiffers = !!seed.title && seed.title.toLowerCase() !== match.title.toLowerCase();
  const authorDiffers = !!seed.author && !!metadataAuthor && seed.author.toLowerCase() !== metadataAuthor.toLowerCase();
  if (!titleDiffers && !authorDiffers) return;
  const payload = {
    asin: match.asin ?? seed.asin,
    listTitle: seed.title,
    metadataTitle: match.title,
    listAuthor: seed.author,
    metadataAuthor,
  };
  if (identity === 'adopt') log.warn(payload, IDENTITY_ADOPTED);
  else log.debug(payload, IDENTITY_PINNED);
}

/**
 * Identity comes from the policy; every other field is the resolved match, with the caller's raw
 * hints preferred where it supplied one. With no match the row is the caller's own fields.
 */
function buildRow(seed: AddBookSeed, match: BookMetadata | null, identity: IdentityPolicy): ResolvedRow {
  if (!match) {
    return {
      title: seed.title,
      authorName: seed.author,
      coverUrl: seed.coverUrl,
      description: seed.description,
      seriesName: seed.seriesName,
      seriesPosition: seed.seriesPosition,
      asin: seed.asin,
      isbn: seed.isbn,
    };
  }
  return {
    ...resolveIdentity(seed, match, identity),
    coverUrl: seed.coverUrl ?? match.coverUrl,
    subtitle: match.subtitle,
    description: seed.description ?? match.description,
    publisher: match.publisher,
    narrators: match.narrators,
    duration: match.duration,
    publishedDate: match.publishedDate,
    genres: match.genres,
    // Search fallback may replace a print/Kindle ASIN with the resolved audiobook ASIN.
    asin: match.asin ?? seed.asin,
    isbn: seed.isbn ?? match.isbn,
    // Persist only actual format signal; undefined preserves the DB default (#1731).
    productionType: match.formatType ? normalizeProductionType(match.formatType) : undefined,
  };
}

function resolveIdentity(
  seed: AddBookSeed,
  match: BookMetadata,
  identity: IdentityPolicy,
): Pick<ResolvedRow, 'title' | 'authorName' | 'seriesName' | 'seriesPosition'> {
  if (identity === 'pin') {
    return {
      title: seed.title,
      authorName: seed.author,
      seriesName: seed.seriesName,
      seriesPosition: seed.seriesPosition,
    };
  }
  const primarySeries = pickPrimarySeries(match);
  return {
    title: match.title,
    authorName: match.authors[0]?.name,
    seriesName: primarySeries?.name,
    seriesPosition: primarySeries?.position,
  };
}
