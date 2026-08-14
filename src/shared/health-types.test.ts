import { describe, it, expect } from 'vitest';
import type { HealthCheckTarget, HealthCheckResult, HealthState } from './health-types.js';

// A type-only module has no runtime surface, so these are compile-time assertions: each arm
// is instantiated positively (deleting an arm reds with TS2322) and cross-arm access plus a
// bogus discriminant are pinned negatively to prove the set is closed.
describe('HealthCheckTarget (#2312)', () => {
  it('accepts every routable target kind', () => {
    const indexer: HealthCheckTarget = { kind: 'indexer', id: 1 };
    const downloadClient: HealthCheckTarget = { kind: 'download-client', id: 2 };
    const notifier: HealthCheckTarget = { kind: 'notifier', id: 3 };
    const settings: HealthCheckTarget = { kind: 'settings', path: 'audio-tools' };
    const route: HealthCheckTarget = { kind: 'route', path: '/activity' };

    expect([indexer, downloadClient, notifier, settings, route].map((t) => t.kind)).toEqual([
      'indexer',
      'download-client',
      'notifier',
      'settings',
      'route',
    ]);
  });

  it('closes the set against an unknown kind', () => {
    // @ts-expect-error 'webhook-target' is not a member of the union
    const bogus: HealthCheckTarget = { kind: 'webhook-target', id: 4 };
    expect(bogus.kind).toBe('webhook-target');
  });

  it('keeps id-bearing and path-bearing arms distinct', () => {
    const notifier: HealthCheckTarget = { kind: 'notifier', id: 3 };
    // @ts-expect-error the notifier arm carries an id, never a path
    expect(notifier.path).toBeUndefined();
  });

  it('carries a state and an optional target on a result', () => {
    const state: HealthState = 'warning';
    const result: HealthCheckResult = { checkName: 'notifier:Email', state, target: { kind: 'notifier', id: 3 } };

    expect(result).toEqual({ checkName: 'notifier:Email', state: 'warning', target: { kind: 'notifier', id: 3 } });
  });
});
