import { z } from 'zod';

/**
 * Why a book is off limits to every import list.
 *
 * - `deleted` — the operator deleted a list-added book (#2305). Counted as an exclusion.
 * - `added` — a list already added this identity, recorded when it was true so a later rename
 *   cannot make the sync forget it (#2530). Bucketed as an ordinary skip.
 */
export const IMPORT_LIST_EXCLUSION_KINDS = ['deleted', 'added'] as const;

export type ImportListExclusionKind = typeof IMPORT_LIST_EXCLUSION_KINDS[number];

export const importListExclusionKindSchema = z.enum(IMPORT_LIST_EXCLUSION_KINDS);
