/** Must match the served favicon's stroke or recoloring becomes a no-op. */
export const AMBER_STROKE = '#d97706';
/** Fixed badge color; badge text remains free-form. */
export const VIOLET_STROKE = '#8b5cf6';

export function normalizeBadge(raw: string | null | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/** Prefixes the base title once and leaves it unchanged when the badge is unset. */
export function applyTitlePrefix(badge: string | null | undefined, baseTitle: string): string {
  const b = normalizeBadge(badge);
  if (!b) return baseTitle;
  const prefix = `[${b}] `;
  return baseTitle.startsWith(prefix) ? baseTitle : `${prefix}${baseTitle}`;
}

/** Percent-encodes the SVG because a bare `#` becomes a data-URI fragment separator. */
export function recolorFaviconDataUri(svgSource: string, color: string = VIOLET_STROKE): string {
  const recolored = svgSource.split(AMBER_STROKE).join(color);
  return `data:image/svg+xml,${encodeURIComponent(recolored)}`;
}

export interface BadgeEffect {
  title: string;
  faviconHref: string;
}

export function computeBadgeEffect(
  badge: string | null | undefined,
  baseTitle: string,
  svgSource: string,
): BadgeEffect | null {
  const b = normalizeBadge(badge);
  if (!b) return null;
  return {
    title: applyTitlePrefix(b, baseTitle),
    faviconHref: recolorFaviconDataUri(svgSource),
  };
}
