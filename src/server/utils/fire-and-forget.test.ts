import { describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { fireAndForget } from './fire-and-forget.js';

function createMockLog(): FastifyBaseLogger {
  return { warn: vi.fn() } as unknown as FastifyBaseLogger;
}

describe('fireAndForget', () => {
  it('executes the promise without blocking the caller', async () => {
    let resolved = false;
    const promise = new Promise<void>((resolve) => {
      setTimeout(() => { resolved = true; resolve(); }, 10);
    });
    const log = createMockLog();

    fireAndForget(promise, log, 'test');

    // Caller returns immediately — resolved is still false
    expect(resolved).toBe(false);

    // But the promise eventually completes
    await promise;
    expect(resolved).toBe(true);
  });

  it('catches and logs rejections at warn level with context', async () => {
    const error = new Error('notification failed');
    const promise = Promise.reject(error);
    const log = createMockLog();

    fireAndForget(promise, log, 'send grab notification');

    // Wait for the rejection to be caught
    await new Promise((r) => setTimeout(r, 10));

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ message: error.message, type: 'Error' }) }),
      'send grab notification',
    );
  });

  it('does not re-throw the error', () => {
    const log = createMockLog();

    // This should not throw
    expect(() => {
      fireAndForget(Promise.reject(new Error('fail')), log, 'ctx');
    }).not.toThrow();
  });

  it('does not affect the caller return value', () => {
    const log = createMockLog();
    const result = fireAndForget(Promise.resolve(), log, 'ctx');
    expect(result).toBeUndefined();
  });
});
