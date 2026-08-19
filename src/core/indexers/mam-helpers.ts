/** Parse MAM's JSON or double-encoded name maps, returning their joined values. */
export function parseDoubleEncodedNames(raw: string | undefined): string | undefined {
  if (!raw) return undefined;

  try {
    const firstParse: unknown = JSON.parse(raw);
    if (typeof firstParse !== 'string') {
      if (firstParse && typeof firstParse === 'object') {
        const values = Object.values(firstParse as Record<string, string>);
        return values.length > 0 ? values.join(', ') : undefined;
      }
      return undefined;
    }

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

/** Unknown VIP status must not qualify a VIP-only torrent as freeleech. */
export function isMamFreeleech(
  item: {
    free?: boolean | null | undefined;
    personal_freeleech?: boolean | null | undefined;
    fl_vip?: boolean | null | undefined;
  },
  isVip: boolean | undefined,
): boolean {
  return !!(item.free || item.personal_freeleech || (item.fl_vip && isVip));
}

// MAM renders English-locale numbers: ',' groups thousands, '.' is the decimal point.
// Provider-scoped by design — not a locale-aware parser.
const ENGLISH_GROUPED = /^\d{1,3}(?:,\d{3})*(?:\.\d+)?$/;

/**
 * Only honour a comma in a well-formed grouping position: stripping a decimal comma ("1,5")
 * would rescale by 1000, and the size gates fail open, so no size beats a wrong size.
 * Comma-free tokens skip this entirely and keep their exact pre-#2316 parse.
 */
export function normalizeGrouping(token: string): string | undefined {
  if (!token.includes(',')) return token;
  return ENGLISH_GROUPED.test(token) ? token.replace(/,/g, '') : undefined;
}

/** Parse MAM binary-unit sizes; numbers pass through and invalid or zero values are absent. */
export function parseMamSize(raw: string | number | undefined): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'number') return raw || undefined;

  const parts = raw.trim().split(' ');
  if (parts.length !== 2) return undefined;

  const normalized = normalizeGrouping(parts[0]!);
  if (normalized === undefined) return undefined;

  const num = parseFloat(normalized);
  if (!num || !isFinite(num)) return undefined;

  const multipliers: Record<string, number> = {
    KIB: 1024,
    MIB: 1024 * 1024,
    GIB: 1024 * 1024 * 1024,
    TIB: 1024 * 1024 * 1024 * 1024,
  };

  const multiplier = multipliers[parts[1]!.toUpperCase()];
  if (!multiplier) return undefined;

  return Math.round(num * multiplier);
}
