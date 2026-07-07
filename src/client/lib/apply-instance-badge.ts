// Boot-time DOM effect for the instance badge (#1842).
//
// Fetches the public `/api/system/status` payload, and when an `instanceBadge` is set,
// recolors the live `<link rel="icon">` and prefixes `document.title`. Pure logic lives
// in `instance-badge.ts`; this is the only DOM-coupled piece.
//
// Non-fatal by contract: a failed status fetch, an unavailable favicon SVG source, or a
// missing `<link rel="icon">` element each degrade to a no-op — the existing favicon and
// title are left untouched, with no unhandled rejection and no partial mutation.

import { systemApi, type SystemStatus } from './api/system.js';
import { computeBadgeEffect, normalizeBadge } from './instance-badge.js';

interface BadgeDeps {
  /** Fetch the public system status payload (badge lives on `instanceBadge`). */
  getStatus: () => Promise<SystemStatus>;
  /** Fetch the SVG source text for a favicon URL. */
  fetchSvg: (url: string) => Promise<string>;
  /** DOM document to mutate (injectable for tests). */
  doc: Document;
}

const defaultDeps: BadgeDeps = {
  getStatus: () => systemApi.getSystemStatus(),
  fetchSvg: async (url) => {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`Failed to fetch favicon source: HTTP ${res.status}`);
    return res.text();
  },
  doc: typeof document !== 'undefined' ? document : (undefined as unknown as Document),
};

/**
 * Apply the instance badge to the favicon + title. Always resolves (never rejects);
 * any failure leaves the existing favicon and title untouched.
 */
export async function applyInstanceBadge(overrides: Partial<BadgeDeps> = {}): Promise<void> {
  const deps = { ...defaultDeps, ...overrides };
  try {
    const status = await deps.getStatus();
    const badge = normalizeBadge(status.instanceBadge);
    if (!badge) return; // unset → no-op

    const link = deps.doc.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) return; // missing icon link → leave favicon + title untouched

    // Read the current favicon URL before fetching its source, so URL_BASE prefixes and
    // any prior href are respected. An unavailable source throws → caught below (no-op).
    const svgSource = await deps.fetchSvg(link.href);

    // Compute both mutations up front, then apply together — no partial mutation on failure.
    const effect = computeBadgeEffect(badge, deps.doc.title, svgSource);
    if (!effect) return;

    link.href = effect.faviconHref;
    deps.doc.title = effect.title;
  } catch {
    // Non-fatal: badge is a cosmetic enhancement, never block boot on it.
  }
}
