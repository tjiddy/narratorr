import { describe, it, expect, vi } from 'vitest';
import { mockDbChain } from './helpers.js';

describe('mockDbChain', () => {
  describe('core chain behavior', () => {
    it('returns the chain when calling any Drizzle method', () => {
      const chain = mockDbChain();
      const result = chain.where('x');
      expect(result).toBe(chain);
    });

    it('supports arbitrary method ordering', () => {
      const chain = mockDbChain();
      const result = chain.limit(10).where('x').orderBy('y');
      expect(result).toBe(chain);
    });

    it('supports same method called multiple times', () => {
      const chain = mockDbChain();
      const result = chain.where('a').where('b');
      expect(result).toBe(chain);
    });

    it('resolves to configured result when awaited', async () => {
      const data = [{ id: 1, title: 'Test' }];
      const chain = mockDbChain(data);
      const result = await chain;
      expect(result).toBe(data);
    });

    it('resolves to configured result with no chain methods called', async () => {
      const data = [{ id: 1 }];
      const result = await mockDbChain(data);
      expect(result).toBe(data);
    });

    it('defaults to empty array when no result argument provided', async () => {
      const result = await mockDbChain();
      expect(result).toEqual([]);
    });
  });

  describe('Proxy auto-discovery', () => {
    it('auto-generates stubs for previously unsupported methods', () => {
      const chain = mockDbChain();
      // These methods were never in the old hard-coded list
      const result = chain.having('x').onConflictDoNothing().distinct();
      expect(result).toBe(chain);
    });

    it('returns the same vi.fn() instance on repeat property access', () => {
      const chain = mockDbChain();
      const first = chain.where;
      const second = chain.where;
      expect(first).toBe(second);
    });

    it('returns promise protocol handlers for then/catch/finally, not chainable stubs', () => {
      const chain = mockDbChain();
      expect(typeof chain.then).toBe('function');
      expect(typeof chain.catch).toBe('function');
      expect(typeof chain.finally).toBe('function');
      // These should NOT be vi.fn() stubs
      expect(chain.then).not.toHaveProperty('mock');
      expect(chain.catch).not.toHaveProperty('mock');
      expect(chain.finally).not.toHaveProperty('mock');
    });

    it('returns undefined for Symbol property access', () => {
      const chain = mockDbChain();
      expect(chain[Symbol.toPrimitive]).toBeUndefined();
      expect(chain[Symbol.iterator]).toBeUndefined();
    });
  });

  describe('argument capture', () => {
    it('captures arguments passed to where() via mock.calls', () => {
      const chain = mockDbChain();
      chain.where('id = ?', 42);
      expect(chain.where).toHaveBeenCalledWith('id = ?', 42);
    });

    it('captures arguments for set(), values(), onConflictDoUpdate()', () => {
      const chain = mockDbChain();
      chain.set({ title: 'New' });
      chain.values({ id: 1 });
      chain.onConflictDoUpdate({ target: 'id' });
      expect(chain.set).toHaveBeenCalledWith({ title: 'New' });
      expect(chain.values).toHaveBeenCalledWith({ id: 1 });
      expect(chain.onConflictDoUpdate).toHaveBeenCalledWith({ target: 'id' });
    });

    it('captures per-call arguments when method is called multiple times', () => {
      const chain = mockDbChain();
      chain.where('a');
      chain.where('b');
      expect(chain.where.mock.calls).toEqual([['a'], ['b']]);
    });
  });

  describe('terminal methods', () => {
    it('get() returns Promise.resolve(result) instead of chain', async () => {
      const data = { id: 1, title: 'Test' };
      const chain = mockDbChain(data);
      const result = await chain.where('x').get();
      expect(result).toBe(data);
    });

    it('all() returns Promise.resolve(result) instead of chain', async () => {
      const data = [{ id: 1 }];
      const chain = mockDbChain(data);
      const result = await chain.all();
      expect(result).toBe(data);
    });

    it('run() returns Promise.resolve(result) instead of chain', async () => {
      const data = { changes: 1 };
      const chain = mockDbChain(data);
      const result = await chain.run();
      expect(result).toBe(data);
    });

    it('execute() returns Promise.resolve(result) instead of chain', async () => {
      const data = [{ id: 1 }];
      const chain = mockDbChain(data);
      const result = await chain.execute();
      expect(result).toBe(data);
    });
  });

  describe('thenable protocol — success path', () => {
    it('then() resolves to configured result', async () => {
      const data = [{ id: 1 }];
      const chain = mockDbChain(data);
      const result = await new Promise(resolve => chain.then(resolve));
      expect(result).toBe(data);
    });

    it('catch() is not invoked on success', async () => {
      const chain = mockDbChain([{ id: 1 }]);
      const catchFn = vi.fn();
      await chain.then(() => {}).catch(catchFn);
      expect(catchFn).not.toHaveBeenCalled();
    });

    it('finally() handler executes on success', async () => {
      const chain = mockDbChain([{ id: 1 }]);
      const finallyFn = vi.fn();
      await chain.then(() => {}).finally(finallyFn);
      expect(finallyFn).toHaveBeenCalled();
    });
  });

  describe('thenable protocol — error path', () => {
    it('rejects with configured error when error option is set', async () => {
      const error = new Error('UNIQUE constraint failed');
      const chain = mockDbChain(undefined, { error });
      await expect(chain).rejects.toThrow('UNIQUE constraint failed');
    });

    it('catch() handler receives the configured error', async () => {
      const error = new Error('fail');
      const chain = mockDbChain(undefined, { error });
      const caught = await chain.catch((e: Error) => e);
      expect(caught).toBe(error);
    });

    it('finally() handler executes on rejection', async () => {
      const error = new Error('fail');
      const chain = mockDbChain(undefined, { error });
      const finallyFn = vi.fn();
      await chain.catch(() => {}).finally(finallyFn);
      expect(finallyFn).toHaveBeenCalled();
    });

    it('existing mockDbChain(data) without error option still resolves', async () => {
      const data = [{ id: 1 }];
      const result = await mockDbChain(data);
      expect(result).toBe(data);
    });
  });

  describe('edge cases', () => {
    it('resolves to null when result is configured as null', async () => {
      const result = await mockDbChain(null);
      expect(result).toBeNull();
    });

    it('resolves to single object when result is not an array', async () => {
      const data = { id: 1, title: 'Test' };
      const result = await mockDbChain(data);
      expect(result).toBe(data);
    });

    it('returns same result on multiple awaits', async () => {
      const data = [{ id: 1 }];
      const chain = mockDbChain(data);
      const first = await chain;
      const second = await chain;
      expect(first).toBe(data);
      expect(second).toBe(data);
    });
  });
});
