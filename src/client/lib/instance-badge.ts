// Pure (DOM-free) logic for the instance badge (#1842).
//
// When `INSTANCE_BADGE` is set (e.g. 'dev'), the dev instance recolors its favicon and
// prefixes the tab title so it is distinguishable from prod at a glance. Everything here
// is pure so it unit-tests without a DOM; the DOM wiring lives in `apply-instance-badge.ts`.

/** Amber stroke on the served favicon (`src/client/public/favicon.svg`). */
export const AMBER_STROKE = '#d97706';
/** Violet stroke used for the `dev` badge era (only the color is fixed; the badge string is free-form). */
export const VIOLET_STROKE = '#8b5cf6';

/** Trim a raw badge value; treat empty/whitespace-only as unset (`undefined`). */
export function normalizeBadge(raw: string | null | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Prefix a base title with `[badge] `. Idempotent — re-applying an already-prefixed title
 * does not double the prefix. Returns the base title unchanged when the badge is unset.
 */
export function applyTitlePrefix(badge: string | null | undefined, baseTitle: string): string {
  const b = normalizeBadge(badge);
  if (!b) return baseTitle;
  const prefix = `[${b}] `;
  return baseTitle.startsWith(prefix) ? baseTitle : `${prefix}${baseTitle}`;
}

/**
 * Recolor the favicon SVG source (amber → `color`) and return an SVG data URI.
 * The whole document is percent-encoded via `encodeURIComponent`, so the `#` in the color
 * becomes `%23` — a bare `#` in a `data:image/svg+xml,...` URL is parsed as the fragment
 * separator and breaks the icon (prior art: `src/client/index.css:224` encodes `#` as `%23`).
 */
export function recolorFaviconDataUri(svgSource: string, color: string = VIOLET_STROKE): string {
  const recolored = svgSource.split(AMBER_STROKE).join(color);
  return `data:image/svg+xml,${encodeURIComponent(recolored)}`;
}

/** Result of computing the badge effect: the values to write to `document.title` and the icon `href`. */
export interface BadgeEffect {
  title: string;
  faviconHref: string;
}

/**
 * Compute the title + favicon href for a badge, or `null` when the badge is unset (the no-op /
 * identity case). Callers apply both fields together so a mid-computation failure never leaves a
 * partial mutation.
 */
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
