import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScriptNotifier } from './script.js';
import type { EventPayload } from './types.js';

// Mock child_process.execFile
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';

const mockExecFile = vi.mocked(execFile);

describe('ScriptNotifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('executes script with correct environment variables', async () => {
    mockExecFile.mockImplementation((_file, _opts, callback) => {
      const cb = callback as (...args: unknown[]) => void;
      cb(null, '', '');
      return {} as ReturnType<typeof execFile>;
    });

    const notifier = new ScriptNotifier({ path: '/scripts/notify.sh' });
    const payload: EventPayload = {
      event: 'on_grab',
      book: { title: 'Dune', author: 'Frank Herbert' },
    };

    const result = await notifier.send('on_grab', payload);

    expect(result.success).toBe(true);
    expect(mockExecFile).toHaveBeenCalledWith(
      '/scripts/notify.sh',
      expect.objectContaining({
        timeout: 30000,
        env: expect.objectContaining({
          NARRATORR_EVENT: 'on_grab',
          NARRATORR_BOOK_TITLE: 'Dune',
          NARRATORR_BOOK_AUTHOR: 'Frank Herbert',
        }),
      }),
      expect.any(Function),
    );
  });

  it('passes event data as JSON on stdin', async () => {
    const mockStdin = { write: vi.fn(), end: vi.fn() };

    mockExecFile.mockImplementation((_file, _opts, callback) => {
      const cb = callback as (...args: unknown[]) => void;
      cb(null, '', '');
      return { stdin: mockStdin } as unknown as ReturnType<typeof execFile>;
    });

    const notifier = new ScriptNotifier({ path: '/scripts/notify.sh' });
    await notifier.send('on_import', {
      event: 'on_import',
      book: { title: 'Dune' },
      import: { libraryPath: '/audiobooks/Dune', fileCount: 5 },
    });

    expect(mockStdin.write).toHaveBeenCalledWith(
      expect.stringContaining('"event":"on_import"'),
    );
    expect(mockStdin.end).toHaveBeenCalled();
  });

  it('returns failure on script error', async () => {
    mockExecFile.mockImplementation((_file, _opts, callback) => {
      const cb = callback as (...args: unknown[]) => void;
      cb(new Error('Script not found'), '', '');
      return {} as ReturnType<typeof execFile>;
    });

    const notifier = new ScriptNotifier({ path: '/scripts/missing.sh' });
    const result = await notifier.send('on_grab', { event: 'on_grab' });

    expect(result.success).toBe(false);
    expect(result.message).toBe('Script not found');
  });

  it('returns timeout message when script is killed', async () => {
    mockExecFile.mockImplementation((_file, _opts, callback) => {
      const cb = callback as (...args: unknown[]) => void;
      const error = new Error('killed') as Error & { killed: boolean };
      error.killed = true;
      cb(error, '', '');
      return {} as ReturnType<typeof execFile>;
    });

    const notifier = new ScriptNotifier({ path: '/scripts/slow.sh', timeout: 5 });
    const result = await notifier.send('on_grab', { event: 'on_grab' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('timed out after 5s');
  });

  it('uses custom timeout in milliseconds', async () => {
    mockExecFile.mockImplementation((_file, _opts, callback) => {
      const cb = callback as (...args: unknown[]) => void;
      cb(null, '', '');
      return {} as ReturnType<typeof execFile>;
    });

    const notifier = new ScriptNotifier({ path: '/scripts/notify.sh', timeout: 60 });
    await notifier.send('on_grab', { event: 'on_grab' });

    expect(mockExecFile).toHaveBeenCalledWith(
      '/scripts/notify.sh',
      expect.objectContaining({ timeout: 60000 }),
      expect.any(Function),
    );
  });

  it('returns success with warning when stderr has output', async () => {
    mockExecFile.mockImplementation((_file, _opts, callback) => {
      const cb = callback as (...args: unknown[]) => void;
      cb(null, '', 'some warning message');
      return {} as ReturnType<typeof execFile>;
    });

    const notifier = new ScriptNotifier({ path: '/scripts/notify.sh' });
    const result = await notifier.send('on_grab', { event: 'on_grab' });

    expect(result.success).toBe(true);
    expect(result.message).toContain('Warning');
  });

  it('test() sends a test payload', async () => {
    mockExecFile.mockImplementation((_file, _opts, callback) => {
      const cb = callback as (...args: unknown[]) => void;
      cb(null, '', '');
      return {} as ReturnType<typeof execFile>;
    });

    const notifier = new ScriptNotifier({ path: '/scripts/notify.sh' });
    const result = await notifier.test();

    expect(result.success).toBe(true);
    expect(mockExecFile).toHaveBeenCalledWith(
      '/scripts/notify.sh',
      expect.objectContaining({
        env: expect.objectContaining({
          NARRATORR_EVENT: 'on_grab',
          NARRATORR_BOOK_TITLE: 'Test Book',
        }),
      }),
      expect.any(Function),
    );
  });

  it('sets upgrade event environment variables', async () => {
    mockExecFile.mockImplementation((_file, _opts, callback) => {
      const cb = callback as (...args: unknown[]) => void;
      cb(null, '', '');
      return {} as ReturnType<typeof execFile>;
    });

    const notifier = new ScriptNotifier({ path: '/scripts/notify.sh' });
    await notifier.send('on_upgrade', {
      event: 'on_upgrade',
      book: { title: 'Dune' },
      upgrade: { previousMbPerHour: 64, newMbPerHour: 128, previousCodec: 'mp3', newCodec: 'aac' },
    });

    expect(mockExecFile).toHaveBeenCalledWith(
      '/scripts/notify.sh',
      expect.objectContaining({
        env: expect.objectContaining({
          NARRATORR_EVENT: 'on_upgrade',
          NARRATORR_UPGRADE_PREV_MBHR: '64',
          NARRATORR_UPGRADE_NEW_MBHR: '128',
          NARRATORR_UPGRADE_PREV_CODEC: 'mp3',
          NARRATORR_UPGRADE_NEW_CODEC: 'aac',
        }),
      }),
      expect.any(Function),
    );
  });

  it('sets health event environment variables', async () => {
    mockExecFile.mockImplementation((_file, _opts, callback) => {
      const cb = callback as (...args: unknown[]) => void;
      cb(null, '', '');
      return {} as ReturnType<typeof execFile>;
    });

    const notifier = new ScriptNotifier({ path: '/scripts/notify.sh' });
    await notifier.send('on_health_issue', {
      event: 'on_health_issue',
      health: { checkName: 'Disk Space', previousState: 'healthy', currentState: 'warning', message: 'Low disk' },
    });

    expect(mockExecFile).toHaveBeenCalledWith(
      '/scripts/notify.sh',
      expect.objectContaining({
        env: expect.objectContaining({
          NARRATORR_EVENT: 'on_health_issue',
          NARRATORR_HEALTH_CHECK: 'Disk Space',
          NARRATORR_HEALTH_PREV_STATE: 'healthy',
          NARRATORR_HEALTH_CURR_STATE: 'warning',
          NARRATORR_HEALTH_MESSAGE: 'Low disk',
        }),
      }),
      expect.any(Function),
    );
  });

  describe('security: execFile instead of exec', () => {
    it('passes script path with shell metacharacters literally to execFile', async () => {
      mockExecFile.mockImplementation((_file, _opts, callback) => {
        const cb = callback as (...args: unknown[]) => void;
        cb(null, '', '');
        return {} as ReturnType<typeof execFile>;
      });

      const dangerousPath = '/scripts/notify.sh; rm -rf /';
      const notifier = new ScriptNotifier({ path: dangerousPath });
      await notifier.send('on_grab', { event: 'on_grab' });

      // execFile passes path as first arg (file to execute), not as shell command
      expect(mockExecFile).toHaveBeenCalledWith(
        dangerousPath,
        expect.any(Object),
        expect.any(Function),
      );
    });
  });

  it('sets failure event environment variables', async () => {
    mockExecFile.mockImplementation((_file, _opts, callback) => {
      const cb = callback as (...args: unknown[]) => void;
      cb(null, '', '');
      return {} as ReturnType<typeof execFile>;
    });

    const notifier = new ScriptNotifier({ path: '/scripts/notify.sh' });
    await notifier.send('on_failure', {
      event: 'on_failure',
      error: { message: 'Import failed', stage: 'import' },
    });

    expect(mockExecFile).toHaveBeenCalledWith(
      '/scripts/notify.sh',
      expect.objectContaining({
        env: expect.objectContaining({
          NARRATORR_EVENT: 'on_failure',
          NARRATORR_ERROR_MESSAGE: 'Import failed',
          NARRATORR_ERROR_STAGE: 'import',
        }),
      }),
      expect.any(Function),
    );
  });
});
