import { describe, it, expect, vi } from 'vitest';
import { warnIfAuthBypassWithUser, warnIfReverseProxyMisconfigured } from './boot-warnings.js';
import { createMockLogger, inject } from './__tests__/helpers.js';
import type { AuthService } from './services/auth.service.js';
import type { FastifyBaseLogger } from 'fastify';

function warnCalls(log: FastifyBaseLogger): unknown[][] {
  return (log.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls;
}

function makeAuth(hasUser: boolean) {
  return inject<Pick<AuthService, 'hasUser'>>({
    hasUser: vi.fn().mockResolvedValue(hasUser),
  });
}

describe('warnIfAuthBypassWithUser (#742)', () => {
  it('emits a warn-level log mentioning AUTH_BYPASS when bypass=true and a user exists', async () => {
    const log = inject<FastifyBaseLogger>(createMockLogger());
    await warnIfAuthBypassWithUser(true, makeAuth(true), log);

    expect(log.warn).toHaveBeenCalledTimes(1);
    const message = (log.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as string;
    expect(message).toContain('AUTH_BYPASS');
    expect(message).toMatch(/disabled/i);
  });

  it('does not warn when AUTH_BYPASS is false (even with a user)', async () => {
    const log = inject<FastifyBaseLogger>(createMockLogger());
    await warnIfAuthBypassWithUser(false, makeAuth(true), log);

    expect(log.warn).not.toHaveBeenCalled();
  });

  it('does not warn when AUTH_BYPASS is true but no user is seeded', async () => {
    const log = inject<FastifyBaseLogger>(createMockLogger());
    await warnIfAuthBypassWithUser(true, makeAuth(false), log);

    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('warnIfReverseProxyMisconfigured (#1174)', () => {
  it('warns about the Secure attribute when forms-auth is active and trustedProxies is false', async () => {
    const log = inject<FastifyBaseLogger>(createMockLogger());
    await warnIfReverseProxyMisconfigured('forms', false, false, log);

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(warnCalls(log)[0]![0] as string).toMatch(/Secure attribute/i);
  });

  it('warns about local bypass when localBypass is enabled and trustedProxies is false', async () => {
    const log = inject<FastifyBaseLogger>(createMockLogger());
    await warnIfReverseProxyMisconfigured('none', true, false, log);

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(warnCalls(log)[0]![0] as string).toMatch(/local/i);
  });

  it('emits two distinct warnings when forms-auth and localBypass are both active', async () => {
    const log = inject<FastifyBaseLogger>(createMockLogger());
    await warnIfReverseProxyMisconfigured('forms', true, false, log);

    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(warnCalls(log)[0]![0] as string).toMatch(/Secure attribute/i);
    expect(warnCalls(log)[1]![0] as string).toMatch(/local/i);
  });

  it('does not warn when TRUSTED_PROXIES is set, even with forms-auth and localBypass', async () => {
    const log = inject<FastifyBaseLogger>(createMockLogger());
    await warnIfReverseProxyMisconfigured('forms', true, ['10.0.0.0/8'], log);

    expect(log.warn).not.toHaveBeenCalled();
  });

  it('does not warn for basic auth with localBypass disabled', async () => {
    const log = inject<FastifyBaseLogger>(createMockLogger());
    await warnIfReverseProxyMisconfigured('basic', false, false, log);

    expect(log.warn).not.toHaveBeenCalled();
  });

  it('does not warn for none auth with localBypass disabled', async () => {
    const log = inject<FastifyBaseLogger>(createMockLogger());
    await warnIfReverseProxyMisconfigured('none', false, false, log);

    expect(log.warn).not.toHaveBeenCalled();
  });
});
