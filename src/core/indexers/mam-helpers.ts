/**
 * MAM-specific parsing helpers extracted from myanonamouse.ts to keep the
 * adapter file under the 400-line limit.
 */

/**
 * Parse a double-encoded JSON field from MAM responses.
 * Fields like author_info are JSON strings containing JSON objects.
 * e.g. "{\"123\": \"Brandon Sanderson\"}" → "Brandon Sanderson"
 * Returns undefined on any parse failure.
 */
export function parseDoubleEncodedNames(raw: string | undefined): string | undefined {
  if (!raw) return undefined;

  try {
    const firstParse: unknown = JSON.parse(raw);
    if (typeof firstParse !== 'string') {
      // Already an object from single parse — extract values
      if (firstParse && typeof firstParse === 'object') {
        const values = Object.values(firstParse as Record<string, string>);
        return values.length > 0 ? values.join(', ') : undefined;
      }
      return undefined;
    }

    // Second parse: the string should be a JSON object
    const secondParse: unknown = JSON.parse(firstParse);
    if (secondParse && typeof secondParse === 'object') {
      const values = Object.values(secondParse as Record<string, string>);
      return values.length > 0 ? values.join(', ') : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse a MAM size field (e.g. "881.8 MiB", "1.1 GiB") into bytes.
 * Returns undefined for zero, unparseable strings, or unknown units.
 * Numeric values pass through unchanged (future-proofing).
 * Illustrative captured MAM values: "881.8 MiB", "1.1 GiB", "830.0 MiB".
 */
export function parseMamSize(raw: string | number | undefined): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'number') return raw || undefined;

  const parts = raw.trim().split(' ');
  if (parts.length !== 2) return undefined;

  const num = parseFloat(parts[0]);
  if (!num || !isFinite(num)) return undefined;

  const multipliers: Record<string, number> = {
    KIB: 1024,
    MIB: 1024 * 1024,
    GIB: 1024 * 1024 * 1024,
    TIB: 1024 * 1024 * 1024 * 1024,
  };

  const multiplier = multipliers[parts[1].toUpperCase()];
  if (!multiplier) return undefined;

  return Math.round(num * multiplier);
}
