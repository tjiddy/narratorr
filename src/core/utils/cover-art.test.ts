import { describe, it, expect, vi, afterEach } from 'vitest';
import { detectCoverArtSource } from './cover-art.js';

// Mock at the OS boundary (node:child_process) so the env passed to ffprobe is captured.
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';

const mockExecFile = vi.mocked(execFile);

function mockExecFileStdout(stdout: string) {
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
    cb(null, { stdout, stderr: '' });
    return {} as never;
  });
}

afterEach(() => {
  vi.resetAllMocks();
  delete process.env.NARRATORR_SECRET_KEY;
});

describe('detectCoverArtSource', () => {
  it('returns the first file carrying a video stream', async () => {
    mockExecFileStdout('audio\nvideo\n');
    const result = await detectCoverArtSource('/usr/bin/ffmpeg', ['/audio/book.m4b']);
    expect(result).toBe('/audio/book.m4b');
  });

  it('returns null when no file has a video stream', async () => {
    mockExecFileStdout('audio\n');
    const result = await detectCoverArtSource('/usr/bin/ffmpeg', ['/audio/book.mp3']);
    expect(result).toBeNull();
  });

  it('probes ffprobe with a sanitized env (no secret leak, PATH preserved)', async () => {
    process.env.NARRATORR_SECRET_KEY = 'sentinel-secret';
    mockExecFileStdout('audio\nvideo\n');

    await detectCoverArtSource('/usr/bin/ffmpeg', ['/audio/book.m4b']);

    // execFileAsync(ffprobePath, args, { env }) → options is the 3rd positional arg.
    const opts = mockExecFile.mock.calls[0]![2] as { env?: Record<string, string> };
    expect(opts.env).toBeDefined();
    expect(opts.env).not.toHaveProperty('NARRATORR_SECRET_KEY');
    expect(opts.env).toHaveProperty('PATH');
  });
});
