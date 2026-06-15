import { describe, it, expect } from 'vitest';
import { ADAPTER_FACTORIES } from './registry.js';
import { connectorTypeSchema, connectorSettingsSchemas, type ConnectorSettings } from '../../shared/schemas/connector.js';
import { connectors } from '../../db/schema.js';

describe('Connector ADAPTER_FACTORIES', () => {
  const types = connectorTypeSchema.options;

  const configs: Record<string, ConnectorSettings> = {
    audiobookshelf: { baseUrl: 'http://abs.test', apiKey: 'key', libraryId: 'lib-1' },
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
  });
});
