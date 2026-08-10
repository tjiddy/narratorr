import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

import { execFile } from 'node:child_process';
import { writeTagsWithMutagen, verifyRequestedKeys } from './mutagen-tag-writer.js';
import { MUTAGEN_PROGRAM } from '@core/utils/mutagen-program.js';
import type { MutagenRequest } from './mutagen-tag-payload.js';

const REQUEST: MutagenRequest = {
  path: '/books/book.m4b',
  format: 'mp4',
  ops: [
    { key: '©nam', kind: 'text', value: 'Words of Radiance' },
    { key: '----:com.apple.iTunes:ASIN', kind: 'freeform', value: 'B00ABCDEFG' },
  ],
  cover: null,
};

/** Captured stdin payloads, in call order — the tag values must never reach argv. */
let stdinWrites: string[] = [];

/**
 * The raw `execFile` callback shape, not `promisify`'s object form: this consumer destructures
 * (error, stdout, stderr) positionally. Handing it the object form would make JSON.parse see
 * "[object Object]" and read as a protocol failure rather than a mock bug.
 */
function armHelper(outcome: { stdout?: string; error?: Error }): void {
  (execFile as unknown as Mock).mockImplementation(
    (_bin: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
      queueMicrotask(() => {
        if (outcome.error) cb(outcome.error, '', 'boom');
        else cb(null, outcome.stdout ?? '', '');
      });
      return {
        stdin: {
          on: vi.fn(),
          end: (data: string) => { stdinWrites.push(data); },
        },
      };
    },
  );
}

function helperResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ok: true,
    sizeBefore: 1000,
    sizeAfter: 1200,
    verified: { '©nam': 'Words of Radiance', '----:com.apple.iTunes:ASIN': 'B00ABCDEFG' },
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  stdinWrites = [];
});

describe('writeTagsWithMutagen — invocation contract', () => {
  it('runs the fixed program with the resolved interpreter', async () => {
    armHelper({ stdout: helperResponse() });

    await writeTagsWithMutagen('/usr/bin/python3', REQUEST);

    const [bin, args] = (execFile as unknown as Mock).mock.calls[0]!;
    expect(bin).toBe('/usr/bin/python3');
    expect(args).toEqual(['-c', MUTAGEN_PROGRAM]);
  });

  it('delivers the payload on stdin and never on argv (AC16)', async () => {
    const withDescription: MutagenRequest = {
      ...REQUEST,
      ops: [{ key: 'desc', kind: 'text', value: 'a secret-looking description' }],
    };
    armHelper({ stdout: JSON.stringify({ ok: true, verified: { desc: 'a secret-looking description' } }) });

    await writeTagsWithMutagen('/usr/bin/python3', withDescription);

    expect(stdinWrites).toHaveLength(1);
    expect(JSON.parse(stdinWrites[0]!)).toEqual(withDescription);
    const args = (execFile as unknown as Mock).mock.calls[0]![1] as string[];
    expect(args.join(' ')).not.toContain('a secret-looking description');
  });

  it('spawns with a sanitized env plus the Python hardening extras (AC16)', async () => {
    process.env.NARRATORR_SECRET_KEY = 'sentinel-secret';
    try {
      armHelper({ stdout: helperResponse() });

      await writeTagsWithMutagen('/usr/bin/python3', REQUEST);

      const opts = (execFile as unknown as Mock).mock.calls[0]![2] as { env: Record<string, string> };
      expect(opts.env).not.toHaveProperty('NARRATORR_SECRET_KEY');
      expect(opts.env).not.toHaveProperty('DATABASE_URL');
      expect(opts.env).toHaveProperty('PATH');
      expect(opts.env.PYTHONDONTWRITEBYTECODE).toBe('1');
      expect(opts.env.PYTHONIOENCODING).toBe('utf-8');
    } finally {
      delete process.env.NARRATORR_SECRET_KEY;
    }
  });
});

describe('writeTagsWithMutagen — success predicate (D2/AC12)', () => {
  it('succeeds when every requested key reads back with its exact value', async () => {
    armHelper({ stdout: helperResponse() });

    expect(await writeTagsWithMutagen('/usr/bin/python3', REQUEST)).toEqual({
      ok: true, sizeBefore: 1000, sizeAfter: 1200,
    });
  });

  it('succeeds when the file SHRANK — size is reported, never adjudicated', async () => {
    armHelper({ stdout: helperResponse({ sizeBefore: 5_000_000, sizeAfter: 3_000_000 }) });

    const result = await writeTagsWithMutagen('/usr/bin/python3', REQUEST);

    expect(result.ok).toBe(true);
    expect(result.sizeAfter).toBeLessThan(result.sizeBefore!);
  });

  it('fails when a requested key is missing from verified, even though the file grew', async () => {
    armHelper({
      stdout: helperResponse({
        sizeBefore: 1000, sizeAfter: 9_000_000,
        verified: { '©nam': 'Words of Radiance' },
      }),
    });

    const result = await writeTagsWithMutagen('/usr/bin/python3', REQUEST);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('----:com.apple.iTunes:ASIN');
  });

  it('fails when a requested key reads back with a different value', async () => {
    armHelper({
      stdout: helperResponse({ verified: { '©nam': 'Wrong Title', '----:com.apple.iTunes:ASIN': 'B00ABCDEFG' } }),
    });

    const result = await writeTagsWithMutagen('/usr/bin/python3', REQUEST);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('©nam');
  });

  it('fails when the helper reports ok:false on exit code 0', async () => {
    armHelper({ stdout: JSON.stringify({ ok: false, error: 'MP4MetadataValueError: not an integer' }) });

    expect(await writeTagsWithMutagen('/usr/bin/python3', REQUEST)).toEqual({
      ok: false, reason: 'MP4MetadataValueError: not an integer',
    });
  });

  it('fails without throwing when the helper exits non-zero', async () => {
    armHelper({ error: Object.assign(new Error('Command failed: SIGKILL'), { code: null }) });

    const result = await writeTagsWithMutagen('/usr/bin/python3', REQUEST);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Command failed');
  });

  it('fails without throwing when the helper writes malformed JSON', async () => {
    armHelper({ stdout: 'Traceback (most recent call last): ...' });

    const result = await writeTagsWithMutagen('/usr/bin/python3', REQUEST);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('unparseable output');
  });
});

describe('verifyRequestedKeys — cover art', () => {
  const withCover: MutagenRequest = { ...REQUEST, ops: [], cover: { path: '/c.jpg', mime: 'image/jpeg' } };

  it('passes when the helper reports a stored cover byte length', () => {
    expect(verifyRequestedKeys(withCover, { __cover__: '2048' })).toBeNull();
  });

  it.each([
    ['absent', {}],
    ['zero bytes', { __cover__: '0' }],
  ])('fails when the stored cover is %s', (_name, verified) => {
    expect(verifyRequestedKeys(withCover, verified)).toContain('cover art');
  });

  it('ignores the cover key when no cover was requested', () => {
    expect(verifyRequestedKeys({ ...REQUEST, ops: [] }, {})).toBeNull();
  });

  it('names every missing key, not just the first', () => {
    const failure = verifyRequestedKeys(REQUEST, {});
    expect(failure).toContain('©nam');
    expect(failure).toContain('----:com.apple.iTunes:ASIN');
  });
});
