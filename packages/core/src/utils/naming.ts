/** Allowed token names for folder/file naming templates. */
export const ALLOWED_TOKENS = ['author', 'title', 'series', 'seriesPosition', 'year', 'narrator'] as const;

export type TokenName = (typeof ALLOWED_TOKENS)[number];

/** Characters illegal on Windows/Linux/macOS filesystems. */
const ILLEGAL_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

/** Max length for a single path segment (filesystem limit). */
const MAX_SEGMENT_LENGTH = 255;

/** Sanitize a string for use as a filesystem path segment. */
export function sanitizePath(segment: string): string {
  let result = segment
    .replace(ILLEGAL_CHARS, '')
    .replace(/\.+$/, '') // trailing dots (Windows)
    .trim();

  // Truncate to filesystem limit
  if (result.length > MAX_SEGMENT_LENGTH) {
    result = result.slice(0, MAX_SEGMENT_LENGTH).trim();
  }

  return result || 'Unknown';
}

/**
 * Render a naming template with token values.
 *
 * Supports:
 * - `{token}` — simple replacement
 * - `{token?text}` — conditional: renders `text` only if token has a value
 * - `{token:00}` — zero-pad format specifier (digit count = specifier length)
 */
export function renderTemplate(
  template: string,
  tokens: Record<string, string | number | undefined | null>,
): string {
  // Process the template in a single pass using regex
  const rendered = template.replace(
    /\{(\w+)(?::(\d+))?(?:\?([^}]*))?\}/g,
    (_match, name: string, padSpec: string | undefined, conditional: string | undefined) => {
      const raw = tokens[name];
      const hasValue = raw !== undefined && raw !== null && raw !== '';

      // Conditional block: {token?text} — render value + text only if token has value
      if (conditional !== undefined) {
        return hasValue ? String(raw) + conditional : '';
      }

      if (!hasValue) return '';

      let value = String(raw);

      // Format specifier: {seriesPosition:00} → zero-pad
      if (padSpec) {
        const num = Number(value);
        if (!isNaN(num)) {
          value = String(num).padStart(padSpec.length, '0');
        }
      }

      return value;
    },
  );

  // Split by /, sanitize non-empty segments, filter empties
  return rendered
    .split('/')
    .map((seg) => seg.trim())
    .filter((s) => s.length > 0)
    .map((s) => sanitizePath(s))
    .join('/');
}

export interface TemplateParseResult {
  /** Token names found in the template. */
  tokens: string[];
  /** Errors that must be fixed. */
  errors: string[];
  /** Warnings (non-blocking). */
  warnings: string[];
}

/**
 * Parse and validate a naming template.
 *
 * Returns found tokens, errors (e.g. missing {title}, unknown tokens),
 * and warnings (e.g. missing {author}).
 */
export function parseTemplate(template: string): TemplateParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const tokens: string[] = [];
  const allowedSet = new Set<string>(ALLOWED_TOKENS);

  // Extract all token names from {token}, {token:spec}, {token?text}
  const tokenPattern = /\{(\w+)(?::\d+)?(?:\?[^}]*)?\}/g;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(template)) !== null) {
    const name = match[1];
    if (!tokens.includes(name)) {
      tokens.push(name);
    }
    if (!allowedSet.has(name)) {
      errors.push(`Unknown token: {${name}}`);
    }
  }

  if (!tokens.includes('title')) {
    errors.push('Template must include {title}');
  }

  if (!tokens.includes('author')) {
    warnings.push('Consider including {author} for better organization');
  }

  return { tokens, errors, warnings };
}
