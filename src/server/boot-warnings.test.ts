import { describe, it, expect, vi } from 'vitest';
import { warnIfAuthBypassWithUser } from './boot-warnings.js';
import { createMockLogger, inject } from './__tests__/helpers.js';
import type { AuthService } from './services/auth.service.js';
import type { FastifyBaseLogger } from 'fastify';

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
