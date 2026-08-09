import { describe, it, expect } from 'vitest';
import { INDEXER_REGISTRY } from './indexer-registry.js';
import { DOWNLOAD_CLIENT_REGISTRY } from './download-client-registry.js';
import { NOTIFIER_REGISTRY } from './notifier-registry.js';
import { IMPORT_LIST_REGISTRY } from './import-list-registry.js';
import { extractHostname } from './registry-utils.js';
import { getSecretFieldNames, type SecretEntity } from '../server/utils/secret-codec.js';

// Reads mask every registered secret as ********; no viewSubtitle may echo it.
// Sweep every registry so new secret fields and formatters fail closed.
// The sentinel is module-private in secret-codec.ts, so this test repeats the literal.
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
          const settings: Record<string, unknown> = {};
          for (const field of secretFields) settings[field] = SENTINEL;

          const subtitle = meta.viewSubtitle(settings);
          expect(subtitle).not.toMatch(SENTINEL_PATTERN);
        });
      }
    });
  }

  it('pins webhook’s incidental safety: a masked secret URL falls back to its label', () => {
    expect(extractHostname(SENTINEL, 'Webhook')).toBe('Webhook');
    expect(NOTIFIER_REGISTRY.webhook.viewSubtitle({ url: SENTINEL })).toBe('Webhook');
  });
});
