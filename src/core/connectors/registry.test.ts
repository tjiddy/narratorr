import { describe, it, expect } from 'vitest';
import { ADAPTER_FACTORIES } from './registry.js';
import { connectorTypeSchema, connectorSettingsSchemas, type ConnectorSettings } from '../../shared/schemas/connector.js';
import { CONNECTOR_REGISTRY, CONNECTOR_TYPES } from '../../shared/connector-registry.js';
import { connectors } from '../../db/schema.js';

describe('Connector ADAPTER_FACTORIES', () => {
  const types = connectorTypeSchema.options;

  const configs: Record<string, ConnectorSettings> = {
    audiobookshelf: { baseUrl: 'http://abs.test', apiKey: 'key', libraryId: 'lib-1' },
    plex: { baseUrl: 'http://plex.test', token: 'tok', sectionId: '1', pathMappings: [], fallbackToFullRefresh: false },
  };

  describe('invariants', () => {
    it('has a factory for every connector type in the Zod enum', () => {
      for (const type of types) {
        expect(ADAPTER_FACTORIES[type], `Missing factory for type: ${type}`).toBeTypeOf('function');
      }
    });

    it('each factory returns an object satisfying the ConnectorAdapter interface', () => {
      for (const type of types) {
        const adapter = ADAPTER_FACTORIES[type](configs[type]!);
        expect(adapter).toHaveProperty('type');
        expect(adapter.test).toBeTypeOf('function');
        expect(adapter.listTargets).toBeTypeOf('function');
        expect(adapter.refreshImport).toBeTypeOf('function');
      }
    });

    it('returns undefined for an unknown connector type (no factory)', () => {
      expect((ADAPTER_FACTORIES as Record<string, unknown>)['unknown']).toBeUndefined();
    });
  });

  describe('schema alignment', () => {
    // SQLite text({enum}) emits no DB CHECK — enum drift between the column and
    // the Zod enum is only caught here. See learnings: drizzle-sqlite-text-enum-no-db-check.
    it('connectors.type enumValues set equals the Zod connector-type enum options', () => {
      const columnEnum = new Set(connectors.type.enumValues);
      const zodEnum = new Set(connectorTypeSchema.options);
      expect(columnEnum).toEqual(zodEnum);
    });

    it('has a settings schema for every connector type', () => {
      for (const type of types) {
        expect(connectorSettingsSchemas[type]).toBeDefined();
      }
    });

    it('strict per-type settings schema rejects unknown keys', () => {
      const result = connectorSettingsSchemas.audiobookshelf.safeParse({
        baseUrl: 'http://abs.test', apiKey: 'key', libraryId: 'lib-1', bogus: 'x',
      });
      expect(result.success).toBe(false);
    });

    it('plex settings schema round-trips a valid object and rejects foreign keys', () => {
      const valid = {
        baseUrl: 'http://plex.test:32400', token: 'tok', sectionId: '1',
        pathMappings: [{ localPath: '/lib', serverPath: '/data' }], fallbackToFullRefresh: true,
      };
      expect(connectorSettingsSchemas.plex.safeParse(valid).success).toBe(true);
      expect(connectorSettingsSchemas.plex.safeParse({ ...valid, apiKey: 'foreign' }).success).toBe(false);
    });

    it('plex settings schema defaults pathMappings/fallbackToFullRefresh when omitted', () => {
      const parsed = connectorSettingsSchemas.plex.safeParse({ baseUrl: 'http://plex.test', token: 'tok', sectionId: '1' });
      expect(parsed.success).toBe(true);
      expect((parsed as { data: { pathMappings: unknown[]; fallbackToFullRefresh: boolean } }).data).toMatchObject({
        pathMappings: [], fallbackToFullRefresh: false,
      });
    });
  });

  describe('registry settingsFields', () => {
    it('CONNECTOR_TYPES includes plex and CONNECTOR_REGISTRY.plex declares settingsFields', () => {
      expect(CONNECTOR_TYPES).toContain('plex');
      expect(CONNECTOR_REGISTRY.plex.settingsFields.length).toBeGreaterThan(0);
    });

    it('every connector type declares settingsFields whose keys exist in defaultSettings', () => {
      for (const type of types) {
        const meta = CONNECTOR_REGISTRY[type];
        expect(meta.settingsFields.length).toBeGreaterThan(0);
        const defaultKeys = new Set(Object.keys(meta.defaultSettings));
        for (const field of meta.settingsFields) {
          expect(defaultKeys, `${type}.${field.key} missing from defaultSettings`).toContain(field.key);
        }
      }
    });

    it('plex declares the path-scoped fields (token/sectionId/pathMappings/fallbackToFullRefresh) that drive field-error routing', () => {
      const keys = CONNECTOR_REGISTRY.plex.settingsFields.map((f) => f.key);
      expect(keys).toEqual(['baseUrl', 'token', 'sectionId', 'pathMappings', 'fallbackToFullRefresh']);
      expect(CONNECTOR_REGISTRY.plex.settingsFields.find((f) => f.key === 'sectionId')?.type).toBe('select');
      expect(CONNECTOR_REGISTRY.plex.settingsFields.find((f) => f.key === 'token')?.secret).toBe(true);
    });
  });
});
