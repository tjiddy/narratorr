import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

// Mock node:child_process
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

// Mock node:fs/promises
vi.mock('node:fs/promises', () => ({
  access: vi.fn(),
}));

import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { runPostProcessingScript } from './post-processing-script.js';

const mockExecFile = vi.mocked(execFile);
const mockAccess = vi.mocked(access);

const mockLog = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
} as unknown as FastifyBaseLogger;

const defaultArgs = {
  scriptPath: '/scripts/post-import.sh',
  timeoutSeconds: 300,
  audiobookPath: '/library/Author/Title',
  bookTitle: 'The Way of Kings',
  bookAuthor: 'Brandon Sanderson',
  fileCount: 12,
  log: mockLog,
};

function setupExecFileSuccess() {
  mockAccess.mockResolvedValue(undefined);
  mockExecFile.mockImplementation((_file, _args, _opts, callback) => {
    (callback as (...args: unknown[]) => void)(null, '', '');
    return {} as ReturnType<typeof execFile>;
  });
}

function setupExecFileFailure(error: { code?: string; killed?: boolean; message: string }, stderr = '') {
  mockAccess.mockResolvedValue(undefined);
  mockExecFile.mockImplementation((_file, _args, _opts, callback) => {
    const err = Object.assign(new Error(error.message), error);
    (callback as (...args: unknown[]) => void)(err, '', stderr);
    return {} as ReturnType<typeof execFile>;
  });
}

describe('runPostProcessingScript', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('execution', () => {
    it('calls execFile with the audiobook folder path as first argument', async () => {
      setupExecFileSuccess();
      await runPostProcessingScript(defaultArgs);

      expect(mockExecFile).toHaveBeenCalledWith(
        '/scripts/post-import.sh',
        ['/library/Author/Title'],
        expect.objectContaining({ timeout: 300_000 }),
        expect.any(Function),
      );
    });

    it('passes NARRATORR_BOOK_TITLE env var from book metadata', async () => {
      setupExecFileSuccess();
      await runPostProcessingScript(defaultArgs);

      const opts = mockExecFile.mock.calls[0][2] as { env: Record<string, string> };
      expect(opts.env.NARRATORR_BOOK_TITLE).toBe('The Way of Kings');
    });

    it('passes NARRATORR_BOOK_AUTHOR env var from book metadata', async () => {
      setupExecFileSuccess();
      await runPostProcessingScript(defaultArgs);

      const opts = mockExecFile.mock.calls[0][2] as { env: Record<string, string> };
      expect(opts.env.NARRATORR_BOOK_AUTHOR).toBe('Brandon Sanderson');
    });

    it('passes NARRATORR_IMPORT_PATH env var with library path', async () => {
      setupExecFileSuccess();
      await runPostProcessingScript(defaultArgs);

      const opts = mockExecFile.mock.calls[0][2] as { env: Record<string, string> };
      expect(opts.env.NARRATORR_IMPORT_PATH).toBe('/library/Author/Title');
    });

    it('passes NARRATORR_IMPORT_FILE_COUNT env var as stringified number', async () => {
      setupExecFileSuccess();
      await runPostProcessingScript(defaultArgs);

      const opts = mockExecFile.mock.calls[0][2] as { env: Record<string, string> };
      expect(opts.env.NARRATORR_IMPORT_FILE_COUNT).toBe('12');
    });

    it('sets NARRATORR_BOOK_AUTHOR to empty string when author is null', async () => {
      setupExecFileSuccess();
      await runPostProcessingScript({ ...defaultArgs, bookAuthor: null });

      const opts = mockExecFile.mock.calls[0][2] as { env: Record<string, string> };
      expect(opts.env.NARRATORR_BOOK_AUTHOR).toBe('');
    });

    it('sets timeout from settings postProcessingScriptTimeout', async () => {
      setupExecFileSuccess();
      await runPostProcessingScript({ ...defaultArgs, timeoutSeconds: 60 });

      expect(mockExecFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ timeout: 60_000 }),
        expect.any(Function),
      );
    });
  });

  describe('skip conditions', () => {
    it('skips execution when script path is empty string', async () => {
      await runPostProcessingScript({ ...defaultArgs, scriptPath: '' });
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('skips execution when script path is undefined', async () => {
      await runPostProcessingScript({ ...defaultArgs, scriptPath: undefined as unknown as string });
      expect(mockExecFile).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('returns warning when script exits with non-zero code', async () => {
      setupExecFileFailure({ code: '1', message: 'Command failed: exit code 1' }, 'something went wrong');
      const result = await runPostProcessingScript(defaultArgs);

      expect(result.success).toBe(false);
      expect(result.warning).toContain('something went wrong');
    });

    it('logs warning with stderr content on non-zero exit', async () => {
      setupExecFileFailure({ code: '1', message: 'exit code 1' }, 'stderr output');
      await runPostProcessingScript(defaultArgs);

      expect(mockLog.warn).toHaveBeenCalled();
    });

    it('returns warning when script file does not exist (ENOENT)', async () => {
      mockAccess.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      const result = await runPostProcessingScript(defaultArgs);

      expect(result.success).toBe(false);
      expect(result.warning).toContain('not found');
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('logs warning with script path for missing script file', async () => {
      mockAccess.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      await runPostProcessingScript(defaultArgs);

      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ scriptPath: '/scripts/post-import.sh' }),
        expect.stringContaining('not found'),
      );
    });

    it('returns warning when script times out (error.killed === true)', async () => {
      setupExecFileFailure({ killed: true, message: 'killed' });
      const result = await runPostProcessingScript(defaultArgs);

      expect(result.success).toBe(false);
      expect(result.warning).toContain('timed out');
    });

    it('logs warning with script path and timeout for killed script', async () => {
      setupExecFileFailure({ killed: true, message: 'killed' });
      await runPostProcessingScript(defaultArgs);

      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ scriptPath: '/scripts/post-import.sh', timeoutSeconds: 300 }),
        expect.stringContaining('timed out'),
      );
    });

    it('returns warning on permission denied (EACCES)', async () => {
      mockAccess.mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
      const result = await runPostProcessingScript(defaultArgs);

      expect(result.success).toBe(false);
      expect(result.warning).toContain('EACCES');
    });

    it('returns inaccessible warning with "Unknown error" fallback when access rejects a non-Error value', async () => {
      mockAccess.mockRejectedValue('string-rejection');
      const result = await runPostProcessingScript(defaultArgs);

      expect(result.success).toBe(false);
      expect(result.warning).toBe('Post-processing script inaccessible: /scripts/post-import.sh (Unknown error)');
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ scriptPath: '/scripts/post-import.sh', error: 'string-rejection' }),
        expect.stringContaining('inaccessible'),
      );
    });

    it('returns success on zero exit code', async () => {
      setupExecFileSuccess();
      const result = await runPostProcessingScript(defaultArgs);

      expect(result.success).toBe(true);
      expect(result.warning).toBeUndefined();
    });
  });
});
