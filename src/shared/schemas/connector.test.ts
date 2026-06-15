import { describe, it, expect } from 'vitest';
import {
  audiobookshelfSettingsSchema,
  plexSettingsSchema,
  createConnectorSchema,
} from './connector.js';

// #1499 — connector baseUrl gained a shared http(s) URL refinement applied to
// BOTH the ABS and Plex settings schemas. It rejects malformed/schemeless/
// non-http(s)/query/hash values and normalizes valid ones (origin + path, no
// trailing slash) at the schema layer, before persistence. No SSRF blocking:
// private/LAN/Docker hosts and IPs are accepted — only scheme/shape constrained.

const absSettings = (baseUrl: string) => ({ baseUrl, apiKey: 'key', libraryId: 'lib-1' });
const plexSettings = (baseUrl: string) => ({ baseUrl, token: 'tok', sectionId: '1' });

const REJECTED: ReadonlyArray<[string, string]> = [
  ['not a url', 'non-URL string'],
  ['localhost:13378', 'scheme-less host:port'],
  ['example.com:8080', 'scheme-less host + port'],
  ['ftp://example.com', 'non-http(s) scheme (ftp)'],
  ['file:///etc/hosts', 'non-http(s) scheme (file)'],
  ['http://host/path?x=1', 'query string present'],
  ['http://host/path#frag', 'fragment present'],
];

describe('connector baseUrl validation (#1499)', () => {
  describe.each([
    ['audiobookshelf', audiobookshelfSettingsSchema, absSettings] as const,
    ['plex', plexSettingsSchema, plexSettings] as const,
  ])('%s settings schema', (_name, schema, make) => {
    describe('rejection', () => {
      it.each(REJECTED)('rejects %s (%s)', (value) => {
        const result = schema.safeParse(make(value));
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues.some((i) => i.path[0] === 'baseUrl')).toBe(true);
        }
      });

      it('rejects the masked secret sentinel on create (not a valid URL)', () => {
        expect(schema.safeParse(make('********')).success).toBe(false);
      });
    });

    describe('acceptance + normalization', () => {
      it('strips a trailing slash', () => {
        const result = schema.safeParse(make('http://example.com/'));
        expect(result.success).toBe(true);
        if (result.success) expect(result.data.baseUrl).toBe('http://example.com');
      });

      it('preserves origin + subpath, strips trailing slash', () => {
        const result = schema.safeParse(make('https://example.com:8443/subpath/'));
        expect(result.success).toBe(true);
        if (result.success) expect(result.data.baseUrl).toBe('https://example.com:8443/subpath');
      });

      it.each([
        'http://192.168.1.10:13378',
        'http://plex.local:32400',
        'https://10.0.0.5',
      ])('accepts private/LAN destination %s (no address blocking)', (value) => {
        expect(schema.safeParse(make(value)).success).toBe(true);
      });
    });
  });
});

describe('createConnectorSchema baseUrl wiring (#1499)', () => {
  it('surfaces a settings.baseUrl-scoped error for a malformed value', () => {
    const result = createConnectorSchema.safeParse({
      name: 'My ABS',
      type: 'audiobookshelf',
      settings: absSettings('not a url'),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (i) => i.path[0] === 'settings' && i.path[1] === 'baseUrl',
      );
      expect(issue).toBeDefined();
    }
  });

  it('persists the normalized baseUrl on a valid create', () => {
    const result = createConnectorSchema.safeParse({
      name: 'My Plex',
      type: 'plex',
      settings: plexSettings('http://plex.local:32400/'),
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data.settings as { baseUrl: string }).baseUrl).toBe('http://plex.local:32400');
    }
  });

  it('rejects a sentinel baseUrl on create', () => {
    const result = createConnectorSchema.safeParse({
      name: 'My ABS',
      type: 'audiobookshelf',
      settings: absSettings('********'),
    });
    expect(result.success).toBe(false);
  });
});
