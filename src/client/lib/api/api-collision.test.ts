import { describe, it, expect } from 'vitest';
import { api, apiModules } from './index.js';

/** apiModules drives both the barrel and this collision check. */
function findCollisions(modules: { name: string; api: object }[]): string[] {
  const seen = new Map<string, string>();
  const collisions: string[] = [];

  for (const { name, api: mod } of modules) {
    for (const key of Object.keys(mod)) {
      if (seen.has(key)) {
        collisions.push(`"${key}" exported by both ${seen.get(key)} and ${name}`);
      } else {
        seen.set(key, name);
      }
    }
  }

  return collisions;
}

describe('API barrel export collision detection', () => {
  it('no two API modules export the same method name', () => {
    const collisions = findCollisions(apiModules);

    expect(collisions, `API method name collisions found:\n${collisions.join('\n')}`).toEqual([]);
  });

  it('barrel key count equals the sum of per-module key counts (no key lost to overwrite)', () => {
    // A duplicate silently overwrites the earlier key, shrinking the barrel.
    const summedKeys = apiModules.reduce((total, { api: mod }) => total + Object.keys(mod).length, 0);

    expect(Object.keys(api).length).toBe(summedKeys);
  });

  it('detects collision when a synthetic duplicate method name is introduced', () => {
    const modulesWithDuplicate = [
      ...apiModules,
      { name: 'fakeApi', api: { getAuthStatus: () => {} } },
    ];

    const collisions = findCollisions(modulesWithDuplicate);

    expect(collisions.length).toBeGreaterThan(0);
    expect(collisions[0]).toContain('getAuthStatus');
    expect(collisions[0]).toContain('authApi');
    expect(collisions[0]).toContain('fakeApi');
  });
});
