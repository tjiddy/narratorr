import { describe, it, expect, vi } from 'vitest';
import { routeRegistry } from './index.js';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/index.js';
import type { Services } from './index.js';

describe('routeRegistry', () => {
  it('contains all 22 route factories', () => {
    // books, bookFiles, search, activity, indexers, downloadClients,
    // settings, metadata, libraryScan, system, update, notifiers, blacklist,
    // auth, remotePathMapping, filesystem, eventHistory, events,
    // recyclingBin, prowlarrCompat, importLists, discover
    expect(routeRegistry).toHaveLength(22);
  });

  it('every entry is a function', () => {
    for (const factory of routeRegistry) {
      expect(typeof factory).toBe('function');
    }
  });
});

describe('registerRoutes', () => {
  it('calls every factory in sequence with app, services, and db', async () => {
    const callOrder: number[] = [];
    const spies = Array.from({ length: routeRegistry.length }, (_, i) =>
      vi.fn().mockImplementation(() => { callOrder.push(i); return Promise.resolve(); }),
    );

    // Snapshot and replace
    const originals = [...routeRegistry];
    for (let i = 0; i < routeRegistry.length; i++) {
      (routeRegistry as unknown[])[i] = spies[i];
    }

    const { registerRoutes } = await import('./index.js');
    const app = { fake: 'app' } as unknown as FastifyInstance;
    const services = { fake: 'services' } as unknown as Services;
    const db = { fake: 'db' } as unknown as Db;

    try {
      await registerRoutes(app, services, db);

      // Every factory called exactly once with correct args
      for (const spy of spies) {
        expect(spy).toHaveBeenCalledOnce();
        expect(spy).toHaveBeenCalledWith(app, services, db);
      }

      // Sequential execution order preserved
      expect(callOrder).toEqual(Array.from({ length: routeRegistry.length }, (_, i) => i));
    } finally {
      for (let i = 0; i < originals.length; i++) {
        (routeRegistry as unknown[])[i] = originals[i];
      }
    }
  });

  it('propagates errors from factories without swallowing', async () => {
    const originals = [...routeRegistry];
    (routeRegistry as unknown[])[0] = vi.fn().mockRejectedValue(new Error('Route boom'));

    const { registerRoutes } = await import('./index.js');

    try {
      await expect(
        registerRoutes({} as FastifyInstance, {} as Services, {} as Db),
      ).rejects.toThrow('Route boom');
    } finally {
      for (let i = 0; i < originals.length; i++) {
        (routeRegistry as unknown[])[i] = originals[i];
      }
    }
  });
});
