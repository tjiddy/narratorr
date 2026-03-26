import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskRegistry, TaskRegistryError } from './task-registry.js';

describe('TaskRegistry', () => {
  let registry: TaskRegistry;

  beforeEach(() => {
    registry = new TaskRegistry();
  });

  describe('registration', () => {
    it('registers cron-based jobs with type cron', () => {
      registry.register('monitor', 'cron', vi.fn(), '*/30 * * * * *');
      const tasks = registry.getAll();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ name: 'monitor', type: 'cron' });
    });

    it('registers setTimeout-based jobs with type timeout', () => {
      registry.register('search', 'timeout', vi.fn());
      const tasks = registry.getAll();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ name: 'search', type: 'timeout' });
    });

    it('registers multiple jobs: monitor, enrichment, import, housekeeping, search, rss, backup', () => {
      registry.register('monitor', 'cron', vi.fn(), '*/30 * * * * *');
      registry.register('enrichment', 'cron', vi.fn(), '*/5 * * * *');
      registry.register('import', 'cron', vi.fn(), '*/1 * * * *');
      registry.register('housekeeping', 'cron', vi.fn(), '0 3 * * 0');
      registry.register('search', 'timeout', vi.fn());
      registry.register('rss', 'timeout', vi.fn());
      registry.register('backup', 'timeout', vi.fn());
      expect(registry.getAll()).toHaveLength(7);
    });
  });

  describe('getAll', () => {
    it('returns metadata with name, type, lastRun, nextRun, running per task', () => {
      registry.register('monitor', 'cron', vi.fn(), '*/30 * * * * *');
      const [task] = registry.getAll();
      expect(task).toEqual({
        name: 'monitor',
        type: 'cron',
        lastRun: null,
        nextRun: expect.any(String),
        running: false,
      });
    });

    it('returns null nextRun for timeout-based jobs without setNextRun', () => {
      registry.register('search', 'timeout', vi.fn());
      const [task] = registry.getAll();
      expect(task.nextRun).toBeNull();
    });

    it('returns setNextRun value for timeout-based jobs when set', () => {
      registry.register('search', 'timeout', vi.fn());
      const next = new Date('2026-03-10T20:00:00Z');
      registry.setNextRun('search', next);
      const [task] = registry.getAll();
      expect(task.nextRun).toBe(next.toISOString());
    });

    it('estimates nextRun correctly for 6-part second-based cron expressions', () => {
      registry.register('monitor', 'cron', vi.fn(), '*/30 * * * * *');
      const [task] = registry.getAll();
      // Should produce a time within 30 seconds from now (not 30 minutes)
      const nextRun = new Date(task.nextRun!);
      const diffMs = nextRun.getTime() - Date.now();
      expect(diffMs).toBeLessThanOrEqual(30 * 1000);
    });
  });

  describe('execution tracking', () => {
    it('updates lastRun after each execution', async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      registry.register('test-job', 'cron', fn, '*/5 * * * *');

      await registry.runTask('test-job');

      const [task] = registry.getAll();
      expect(task.lastRun).not.toBeNull();
    });

    it('sets running to true during execution and false after success', async () => {
      let resolveExecution: () => void;
      const fn = vi.fn().mockReturnValue(new Promise<void>((r) => { resolveExecution = r; }));
      registry.register('test-job', 'cron', fn, '*/5 * * * *');

      const runPromise = registry.runTask('test-job');
      expect(registry.getAll()[0].running).toBe(true);

      resolveExecution!();
      await runPromise;
      expect(registry.getAll()[0].running).toBe(false);
    });

    it('sets running to false after failure', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('boom'));
      registry.register('test-job', 'cron', fn, '*/5 * * * *');

      await expect(registry.runTask('test-job')).rejects.toThrow('boom');
      expect(registry.getAll()[0].running).toBe(false);
    });
  });

  describe('executeTracked (live scheduler)', () => {
    it('executes fn, sets running during execution, updates lastRun after', async () => {
      let resolveExecution: () => void;
      const fn = vi.fn().mockReturnValue(new Promise<void>((r) => { resolveExecution = r; }));
      registry.register('monitor', 'cron', fn, '*/30 * * * * *');

      const promise = registry.executeTracked('monitor');
      expect(registry.getAll()[0].running).toBe(true);

      resolveExecution!();
      await promise;

      const [task] = registry.getAll();
      expect(task.running).toBe(false);
      expect(task.lastRun).not.toBeNull();
      expect(fn).toHaveBeenCalledOnce();
    });

    it('silently skips if task is already running (no error)', async () => {
      let resolveExecution: () => void;
      const fn = vi.fn().mockReturnValue(new Promise<void>((r) => { resolveExecution = r; }));
      registry.register('monitor', 'cron', fn, '*/30 * * * * *');

      const first = registry.executeTracked('monitor');
      // Second call should be a no-op (silently skip)
      await registry.executeTracked('monitor');
      expect(fn).toHaveBeenCalledOnce();

      resolveExecution!();
      await first;
    });

    it('is a no-op for unknown task names', async () => {
      // Should not throw
      await registry.executeTracked('nonexistent');
    });

    it('sets running to false after failure', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('boom'));
      registry.register('monitor', 'cron', fn, '*/30 * * * * *');

      await expect(registry.executeTracked('monitor')).rejects.toThrow('boom');
      expect(registry.getAll()[0].running).toBe(false);
    });
  });

  describe('setNextRun', () => {
    it('updates the next run time for timeout jobs', () => {
      registry.register('search', 'timeout', vi.fn());
      const next = new Date('2026-03-10T21:00:00Z');
      registry.setNextRun('search', next);
      expect(registry.getAll()[0].nextRun).toBe(next.toISOString());
    });

    it('is a no-op for unknown task names', () => {
      registry.setNextRun('nonexistent', new Date());
    });
  });

  describe('runExclusive', () => {
    it('returns the custom function result while using the task concurrency guard', async () => {
      registry.register('discovery', 'timeout', vi.fn());
      const result = await registry.runExclusive('discovery', async () => ({ added: 3, removed: 1 }));
      expect(result).toEqual({ added: 3, removed: 1 });
    });

    it('sets running during execution and clears after', async () => {
      let resolveExecution: (v: string) => void;
      registry.register('discovery', 'timeout', vi.fn());

      const promise = registry.runExclusive('discovery', () => new Promise<string>((r) => { resolveExecution = r; }));
      expect(registry.getAll()[0].running).toBe(true);

      resolveExecution!('done');
      await promise;
      expect(registry.getAll()[0].running).toBe(false);
      expect(registry.getAll()[0].lastRun).not.toBeNull();
    });

    it('throws when task is already running (same guard as runTask)', async () => {
      let resolveExecution: () => void;
      const fn = vi.fn().mockReturnValue(new Promise<void>((r) => { resolveExecution = r; }));
      registry.register('discovery', 'timeout', fn);

      const first = registry.runTask('discovery');
      await expect(registry.runExclusive('discovery', async () => 'nope')).rejects.toThrow(/already running/i);

      resolveExecution!();
      await first;
    });

    it('throws for unknown task name', async () => {
      await expect(registry.runExclusive('nonexistent', async () => 'x')).rejects.toThrow(/not found/i);
    });

    it('clears running flag on failure', async () => {
      registry.register('discovery', 'timeout', vi.fn());
      await expect(registry.runExclusive('discovery', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
      expect(registry.getAll()[0].running).toBe(false);
    });

    it('does not call the registered fn — only the provided fn', async () => {
      const registeredFn = vi.fn();
      registry.register('discovery', 'timeout', registeredFn);
      await registry.runExclusive('discovery', async () => 'custom');
      expect(registeredFn).not.toHaveBeenCalled();
    });
  });

  describe('runTask', () => {
    it('triggers immediate execution of named task', async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      registry.register('monitor', 'cron', fn, '*/30 * * * * *');

      await registry.runTask('monitor');
      expect(fn).toHaveBeenCalledOnce();
    });

    it('throws 404-equivalent error for unknown task name', async () => {
      await expect(registry.runTask('nonexistent')).rejects.toThrow(/not found/i);
    });

    it('returns 409 conflict when task is already running', async () => {
      let resolveExecution: () => void;
      const fn = vi.fn().mockReturnValue(new Promise<void>((r) => { resolveExecution = r; }));
      registry.register('test-job', 'cron', fn, '*/5 * * * *');

      const first = registry.runTask('test-job');
      await expect(registry.runTask('test-job')).rejects.toThrow(/already running/i);

      resolveExecution!();
      await first;
    });

    // #149 — TaskRegistryError typed throws (ERR-1)
    it('throws TaskRegistryError with code NOT_FOUND for unknown task name in runTask()', async () => {
      await expect(registry.runTask('nonexistent')).rejects.toSatisfy(
        (e: unknown) => e instanceof TaskRegistryError && e.code === 'NOT_FOUND',
      );
    });

    it('throws TaskRegistryError with code ALREADY_RUNNING when task is already running in runTask()', async () => {
      let resolve: () => void;
      const fn = vi.fn().mockReturnValue(new Promise<void>((r) => { resolve = r; }));
      registry.register('job', 'cron', fn, '*/5 * * * *');

      const first = registry.runTask('job');
      await expect(registry.runTask('job')).rejects.toSatisfy(
        (e: unknown) => e instanceof TaskRegistryError && e.code === 'ALREADY_RUNNING',
      );
      resolve!();
      await first;
    });

    it('throws TaskRegistryError with code NOT_FOUND for unknown task name in runExclusive()', async () => {
      await expect(registry.runExclusive('nonexistent', async () => 'x')).rejects.toSatisfy(
        (e: unknown) => e instanceof TaskRegistryError && e.code === 'NOT_FOUND',
      );
    });

    it('throws TaskRegistryError with code ALREADY_RUNNING when task is already running in runExclusive()', async () => {
      let resolve: () => void;
      registry.register('job', 'cron', vi.fn().mockReturnValue(new Promise<void>((r) => { resolve = r; })), '*/5 * * * *');

      const first = registry.runTask('job');
      await expect(registry.runExclusive('job', async () => 'x')).rejects.toSatisfy(
        (e: unknown) => e instanceof TaskRegistryError && e.code === 'ALREADY_RUNNING',
      );
      resolve!();
      await first;
    });
  });
});
