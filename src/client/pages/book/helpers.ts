import { formatDurationMinutes, formatYear } from '@/lib/format';
import { bookStatusConfig } from '@/lib/status';
import type { BookWithAuthor } from '@/lib/api';
import { requireDefined } from '@shared/utils/assert.js';
import { pickPrimarySeries } from '@shared/pick-primary-series.js';

export interface MetadataBook {
  subtitle?: string | undefined;
  description?: string | undefined;
  coverUrl?: string | undefined;
  duration?: number | undefined;
  genres?: string[] | undefined;
  narrators?: string[] | undefined;
  publisher?: string | undefined;
  publishedDate?: string | undefined;
  series?: { name: string; position?: number | undefined }[] | undefined;
  seriesPrimary?: { name: string; position?: number | undefined } | undefined;
}

/**
 * The RAW resolved value of each clearable field, plus `seriesPosition` — "what
 * does the operator actually see" (#2069 AC18).
 *
 * `undefined` means "resolves to nothing": either nothing is stored and the
 * provider has none, or the field carries a tombstone.
 */
export interface DisplayedFields {
  seriesName: string | undefined;
  seriesPosition: number | undefined;
  subtitle: string | undefined;
  description: string | undefined;
  publisher: string | undefined;
  publishedDate: string | undefined;
  genres: string[] | undefined;
}

/**
 * ONE decision, in one place: what the header shows and what the Edit Metadata
 * modal pre-fills and diffs against must not be able to disagree (#2069 AC18/AC25).
 *
 * Order of application:
 *
 *  1. **Tombstoned → resolves to nothing.** An explicit clear stays cleared
 *     everywhere until the operator sets a new value; the provider fallback must
 *     not resurrect it.
 *  2. **Otherwise → today's exact per-field operator, unchanged.** `||` for
 *     `description`, `seriesName`, `publisher`, `publishedDate`, `subtitle` (so a
 *     stored empty string still falls through to the provider value, as it does
 *     today); `??` for `genres` (so a stored `[]` deliberately OVERRIDES the
 *     provider list) and for `seriesPosition`; `pickPrimarySeries` for the series
 *     ref (#1088/#1097 — `series[0]` on Audible can be a broader universe entry).
 *
 * The `||`/`??` asymmetry is preserved by construction, not re-derived: a uniform
 * operator would change behavior on exactly the `''` and `[]` cases.
 *
 * `seriesPosition` keeps the #1927 AC10 pair rule — it resolves only when the name
 * does — and since #2152 carries its OWN tombstone on top of it: an operator who
 * clears just the Position gets "in the series, unnumbered", so the header renders
 * the series with no `#n` and the provider number does not resurrect. The two
 * gates are independent and compose; neither replaces the other.
 *
 * `coverUrl`, `duration`, and `narratorNames` are NOT part of this decision — none
 * of them is clearable — and stay inside `mergeBookData`.
 */
export function resolveDisplayedFields(
  libraryBook: BookWithAuthor,
  metadataBook?: MetadataBook | null | undefined,
): DisplayedFields {
  const cleared = new Set<string>(libraryBook.userClearedFields ?? []);
  const primaryMetaSeries = pickPrimarySeries(metadataBook);
  const seriesName = orProvider(cleared, 'seriesName', libraryBook.seriesName, primaryMetaSeries?.name);

  return {
    seriesName,
    // Pair rule (the name must resolve) AND the position's own tombstone (#2152).
    seriesPosition: seriesName && !cleared.has('seriesPosition')
      ? (libraryBook.seriesPosition ?? primaryMetaSeries?.position)
      : undefined,
    subtitle: orProvider(cleared, 'subtitle', libraryBook.subtitle, metadataBook?.subtitle),
    description: orProvider(cleared, 'description', libraryBook.description, metadataBook?.description),
    publisher: orProvider(cleared, 'publisher', libraryBook.publisher, metadataBook?.publisher),
    publishedDate: orProvider(cleared, 'publishedDate', libraryBook.publishedDate, metadataBook?.publishedDate),
    // `??`, not `||`: a stored `[]` is a deliberate override that must NOT fall
    // through to the provider list.
    genres: cleared.has('genres') ? undefined : (libraryBook.genres ?? metadataBook?.genres),
  };
}

/**
 * The `||` arm shared by the five string fields: tombstoned resolves to nothing,
 * otherwise a stored empty string still defers to the provider value — today's
 * exact behavior, preserved by construction.
 */
function orProvider(
  cleared: ReadonlySet<string>,
  field: string,
  stored: string | null | undefined,
  provider: string | undefined,
): string | undefined {
  if (cleared.has(field)) return undefined;
  return stored || provider;
}

// eslint-disable-next-line complexity -- flat data coalescing across two sources, no nesting
export function mergeBookData(libraryBook: BookWithAuthor, metadataBook?: MetadataBook | null | undefined) {
  const displayed = resolveDisplayedFields(libraryBook, metadataBook);
  const coverUrl = libraryBook.coverUrl || metadataBook?.coverUrl;
  const duration = formatDurationMinutes(libraryBook.duration ?? metadataBook?.duration);
  const year = formatYear(displayed.publishedDate);
  const status = requireDefined(
    bookStatusConfig[libraryBook.status],
    `mergeBookData: bookStatusConfig missing entry for "${libraryBook.status}"`,
  );
  const narratorNames = (libraryBook.narrators.length > 0 ? libraryBook.narrators.map((n) => n.name).join(', ') : null) || metadataBook?.narrators?.join(', ');

  const metaDots: string[] = [];
  if (displayed.seriesName) {
    metaDots.push(`${displayed.seriesName}${displayed.seriesPosition != null ? ` #${displayed.seriesPosition}` : ''}`);
  }
  if (duration) metaDots.push(duration);
  if (year) metaDots.push(year);
  if (displayed.publisher) metaDots.push(displayed.publisher);

  return {
    description: displayed.description,
    coverUrl,
    genres: displayed.genres,
    narratorNames,
    metaDots,
    statusLabel: status.label,
    statusDotClass: status.dotClass,
    statusBarClass: status.barClass,
    subtitle: displayed.subtitle,
    // The FULL author list — co-authored books credit everyone, each name linkable
    // by its own ASIN (the narrator line got the plural treatment long ago; this
    // matches it).
    authors: libraryBook.authors.map((a) => ({ name: a.name, asin: a.asin })),
  };
}
