import { describe, it, expect, beforeEach, vi } from 'vitest';
import { applyInstanceBadge } from './apply-instance-badge.js';
import { AMBER_STROKE } from './instance-badge.js';

const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="1.5">' +
  '<path d="M3 18v-6a9 9 0 0 1 18 0v6" /></svg>';

function setupDom(withIconLink = true): Document {
  document.head.innerHTML = '';
  document.title = 'Narratorr';
  if (withIconLink) {
    const link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/svg+xml';
    link.href = 'https://app.test/favicon.svg';
    document.head.appendChild(link);
  }
  return document;
}

function iconHref(doc: Document): string | undefined {
  return doc.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href;
}

describe('applyInstanceBadge', () => {
  beforeEach(() => {
    setupDom();
  });

  it('recolors the favicon and prefixes the title when a badge is set', async () => {
    const doc = setupDom();
    await applyInstanceBadge({
      getStatus: async () => ({ version: '0.1.0', status: 'ok', instanceBadge: 'dev' }),
      fetchSvg: async () => FAVICON_SVG,
      doc,
    });

    expect(doc.title).toBe('[dev] Narratorr');
    const href = iconHref(doc)!;
    expect(href.startsWith('data:image/svg+xml,')).toBe(true);
    expect(href).toContain('%238b5cf6');
    expect(decodeURIComponent(href)).not.toContain(AMBER_STROKE);
  });

  it('is a no-op when the badge is unset', async () => {
    const doc = setupDom();
    const fetchSvg = vi.fn(async () => FAVICON_SVG);
    await applyInstanceBadge({
      getStatus: async () => ({ version: '0.1.0', status: 'ok' }),
      fetchSvg,
      doc,
    });

    expect(doc.title).toBe('Narratorr');
    expect(iconHref(doc)).toBe('https://app.test/favicon.svg');
    expect(fetchSvg).not.toHaveBeenCalled(); // no favicon fetch when there is no badge
  });

  it('leaves favicon + title untouched when the status fetch rejects', async () => {
    const doc = setupDom();
    await expect(
      applyInstanceBadge({
        getStatus: async () => {
          throw new Error('network down');
        },
        fetchSvg: async () => FAVICON_SVG,
        doc,
      }),
    ).resolves.toBeUndefined();

    expect(doc.title).toBe('Narratorr');
    expect(iconHref(doc)).toBe('https://app.test/favicon.svg');
  });

  it('leaves favicon + title untouched when the SVG source is unavailable', async () => {
    const doc = setupDom();
    await applyInstanceBadge({
      getStatus: async () => ({ version: '0.1.0', status: 'ok', instanceBadge: 'dev' }),
      fetchSvg: async () => {
        throw new Error('404');
      },
      doc,
    });

    expect(doc.title).toBe('Narratorr'); // no partial mutation — title untouched too
    expect(iconHref(doc)).toBe('https://app.test/favicon.svg');
  });

  it('is a no-op when the <link rel="icon"> element is missing', async () => {
    const doc = setupDom(false);
    const fetchSvg = vi.fn(async () => FAVICON_SVG);
    await applyInstanceBadge({
      getStatus: async () => ({ version: '0.1.0', status: 'ok', instanceBadge: 'dev' }),
      fetchSvg,
      doc,
    });

    expect(doc.title).toBe('Narratorr'); // title untouched when the icon link is absent
    expect(iconHref(doc)).toBeUndefined();
    expect(fetchSvg).not.toHaveBeenCalled();
  });
});
