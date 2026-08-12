// Cosmetic boot effect: failures must leave the favicon and title unchanged.

import { systemApi, type SystemStatus } from './api/system.js';
import { computeBadgeEffect, normalizeBadge } from './instance-badge.js';

interface BadgeDeps {
  getStatus: () => Promise<SystemStatus>;
  fetchSvg: (url: string) => Promise<string>;
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

/** Best-effort and atomic: failures leave the favicon and title unchanged. */
export async function applyInstanceBadge(overrides: Partial<BadgeDeps> = {}): Promise<void> {
  const deps = { ...defaultDeps, ...overrides };
  try {
    const status = await deps.getStatus();
    const badge = normalizeBadge(status.instanceBadge);
    if (!badge) return;

    const link = deps.doc.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) return;

    // Read the live href so URL_BASE prefixes and prior overrides are preserved.
    const svgSource = await deps.fetchSvg(link.href);

    // Compute both values before mutating the DOM.
    const effect = computeBadgeEffect(badge, deps.doc.title, svgSource);
    if (!effect) return;

    link.href = effect.faviconHref;
    deps.doc.title = effect.title;
  } catch {
    // Cosmetic only; never block boot on badge failures.
  }
}
