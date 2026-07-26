import { z } from 'zod';

// ============================================================================
// Companion ebook schemas
// ============================================================================

/**
 * Canonical stored statuses for `companion_ebooks.status`.
 *
 * Companion-domain vocabulary, and a superset of `src/core/epub/`'s validation
 * union: `none` and `ambiguous` are *discovery* outcomes the EPUB validator
 * never produces. This tuple is the single source for the Zod enum, the Drizzle
 * column metadata, the schema-DB alignment test, and the DB-level
 * `ck_companion_ebooks_status_domain` CHECK (whose literal list is generated
 * from it) — there is no second place for the vocabulary to drift.
 *
 * This module must not import from `src/core/**` or `src/server/**`
 * (eslint.config.js shared-layer boundary).
 */
export const COMPANION_EBOOK_STATUSES = [
  'available', 'none', 'ambiguous', 'invalid', 'drm_protected',
] as const;

export const companionEbookStatusSchema = z.enum(COMPANION_EBOOK_STATUSES);

export type CompanionEbookStatus = z.infer<typeof companionEbookStatusSchema>;
