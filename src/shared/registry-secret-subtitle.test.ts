import { describe, it, expect } from 'vitest';
import { INDEXER_REGISTRY } from './indexer-registry.js';
import { DOWNLOAD_CLIENT_REGISTRY } from './download-client-registry.js';
import { NOTIFIER_REGISTRY } from './notifier-registry.js';
import { IMPORT_LIST_REGISTRY } from './import-list-registry.js';
import { extractHostname } from './registry-utils.js';
import { getSecretFieldNames, type SecretEntity } from '../server/utils/secret-codec.js';

/**
 * #1403 — Structural guard against `viewSubtitle` echoing a masked secret.
 *
 * GET responses mask every registered secret field to the sentinel `'********'`
 * (see secret-codec `maskFields`). A `viewSubtitle` that reads a secret field
 * directly therefore renders `********` verbatim on the settings card. This was
 * the newznab/torznab bug (`apiUrl` is secret) and, before #1356, the ntfy bug.
 *
 * This sweep pins the entire class: for every registered entity type across all
 * four registries, building a settings object whose secret fields are all masked
 * must never produce a subtitle containing the 8-asterisk sentinel. New secret
 * fields or new subtitle implementations that reintroduce the bug fail here.
 */

// The sentinel literal is module-private in secret-codec.ts; inline it here,
// consistent with secret-codec.test.ts usage.
const SENTINEL = '********';
const SENTINEL_PATTERN = /\*{8}/;

type SubtitleRegistry = Record<string, { viewSubtitle: (s: Record<string, unknown>) => string }>;

const REGISTRIES: Array<{ entity: SecretEntity; registry: SubtitleRegistry }> = [
  { entity: 'indexer', registry: INDEXER_REGISTRY },
  { entity: 'downloadClient', registry: DOWNLOAD_CLIENT_REGISTRY },
  { entity: 'notifier', registry: NOTIFIER_REGISTRY },
  { entity: 'importList', registry: IMPORT_LIST_REGISTRY },
];

describe('#1403 registry-wide secret-subtitle sweep', () => {
  for (const { entity, registry } of REGISTRIES) {
    describe(`${entity} registry`, () => {
      const secretFields = getSecretFieldNames(entity);

      for (const [type, meta] of Object.entries(registry)) {
        it(`${type}: viewSubtitle never renders a masked secret`, () => {
          // Every secret field masked; all other fields unset/default.
          const settings: Record<string, unknown> = {};
          for (const field of secretFields) settings[field] = SENTINEL;

          const subtitle = meta.viewSubtitle(settings);
          expect(subtitle).not.toMatch(SENTINEL_PATTERN);
        });
      }
    });
  }

  it('pins webhook’s incidental safety: a masked secret URL falls back to its label', () => {
    // The webhook subtitle reads `url`, which IS a secret field. It degrades
    // safely only because the sentinel is an unparseable URL — pin that here.
    expect(extractHostname(SENTINEL, 'Webhook')).toBe('Webhook');
    expect(NOTIFIER_REGISTRY.webhook.viewSubtitle({ url: SENTINEL })).toBe('Webhook');
  });
});
