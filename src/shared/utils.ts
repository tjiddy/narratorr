/**
 * Shared utility functions available to both client and server.
 * Server-side code should use this instead of duplicating logic.
 */

/**
 * Normalize a string to a URL-friendly slug for duplicate detection.
 * This is the canonical implementation — server-side code imports from here via src/core/utils/parse.ts.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}
