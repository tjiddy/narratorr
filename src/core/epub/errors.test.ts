import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { classifyEpubReadError } from './errors.js';
import {
  createCountingStream,
  isCapExceededError,
  EPUB_CAP_EXCEEDED_CODE,
} from './counting-stream.js';

const ARCHIVE_READ = { archiveRead: true } as const;
const NOT_ARCHIVE_READ = { archiveRead: false } as const;

function coded(code: unknown): Error {
  return Object.assign(new Error('boom'), { code });
}

describe('classifyEpubReadError — arm 2, the non-Error domain', () => {
  // Without the Error guard, these values resemble uncoded decoder failures.
  const values: Array<[label: string, value: unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['a string', 'boom'],
    ['a number', 0],
    ['a symbol', Symbol('x')],
    ['a function', () => {}],
    ['a plain object', {}],
  ];

  it.each(values)('classifies %s as throw', (_label, value) => {
    expect(classifyEpubReadError(value, ARCHIVE_READ)).toBe('throw');
  });
});

describe('classifyEpubReadError — arm 3, provenance', () => {
  it('classifies any Error from an unmarked provenance as throw', () => {
    expect(classifyEpubReadError(new Error('boom'), NOT_ARCHIVE_READ)).toBe('throw');
    expect(classifyEpubReadError(coded('Z_DATA_ERROR'), NOT_ARCHIVE_READ)).toBe('throw');
  });
});

describe('classifyEpubReadError — arm 4, the excluded subclasses', () => {
  // These indicate a code defect or hostile value, not a corrupt archive.
  const subclasses: Array<[label: string, make: () => Error]> = [
    ['TypeError', () => new TypeError('boom')],
    ['RangeError', () => new RangeError('boom')],
    ['ReferenceError', () => new ReferenceError('boom')],
  ];

  it.each(subclasses)('classifies an uncoded %s as throw', (_label, make) => {
    expect(classifyEpubReadError(make(), ARCHIVE_READ)).toBe('throw');
  });

  it.each(subclasses)('classifies a zlib-coded %s as throw', (_label, make) => {
    expect(classifyEpubReadError(Object.assign(make(), { code: 'Z_DATA_ERROR' }), ARCHIVE_READ)).toBe(
      'throw',
    );
  });
});

describe('classifyEpubReadError — arm 5, code shape', () => {
  // Include undocumented errnos so the test rejects a finite errno allowlist.
  const errnos = [
    'EACCES',
    'EIO',
    'ESTALE',
    'EMFILE',
    'ENOENT',
    'ENOTDIR',
    'ETIMEDOUT',
    'ENODEV',
    'EREMOTEIO',
  ];

  it.each(errnos)('classifies errno %s as throw', (code) => {
    expect(classifyEpubReadError(coded(code), ARCHIVE_READ)).toBe('throw');
  });

  it('classifies a present string code that is neither errno- nor zlib-shaped as throw', () => {
    expect(classifyEpubReadError(coded('ERR_STREAM_PREMATURE_CLOSE'), ARCHIVE_READ)).toBe('throw');
  });

  it('classifies an ordinary Error wearing the cap-breach code string as throw', () => {
    const impostor = coded(EPUB_CAP_EXCEEDED_CODE);
    expect(isCapExceededError(impostor)).toBe(false);
    expect(classifyEpubReadError(impostor, ARCHIVE_READ)).toBe('throw');
  });

  it('classifies a present non-string code as throw', () => {
    expect(classifyEpubReadError(coded(12), ARCHIVE_READ)).toBe('throw');
    expect(classifyEpubReadError(coded(Symbol('x')), ARCHIVE_READ)).toBe('throw');
  });

  it('does not let the errno shape shadow the zlib allowance', () => {
    expect(/^E[A-Z0-9]+$/.test('ERR_ZLIB_BINDING_CLOSED')).toBe(false);
  });
});

describe('classifyEpubReadError — arm 6, decoder failures', () => {
  const decoderRows: Array<[label: string, value: Error]> = [
    ['a zlib Z_ code', coded('Z_DATA_ERROR')],
    ['a zlib ERR_ZLIB_ code', coded('ERR_ZLIB_BINDING_CLOSED')],
    ['an uncoded plain Error', new Error('boom')],
    ['code: undefined', coded(undefined)],
    ['code: null', coded(null)],
  ];

  it.each(decoderRows)('classifies %s as decoder-failure', (_label, value) => {
    expect(classifyEpubReadError(value, ARCHIVE_READ)).toBe('decoder-failure');
  });

  it('requires archive-read provenance for every decoder row', () => {
    const labels = decoderRows.map(([, value]) => classifyEpubReadError(value, NOT_ARCHIVE_READ));
    expect(labels).toEqual(['throw', 'throw', 'throw', 'throw', 'throw']);
  });
});

describe('cap-breach identity across modules', () => {
  async function breach(): Promise<unknown> {
    const stream = createCountingStream(1);
    try {
      await pipeline(Readable.from([Buffer.alloc(4)]), stream, async (out) => {
        for await (const _chunk of out as AsyncIterable<Buffer>) {
          // drain
        }
      });
      return null;
    } catch (error) {
      return error;
    }
  }

  it('classifies a real transform-raised breach as cap-exceeded, with or without provenance', async () => {
    const error = await breach();

    expect(isCapExceededError(error)).toBe(true);
    // Cap identity precedes provenance.
    expect(classifyEpubReadError(error, ARCHIVE_READ)).toBe('cap-exceeded');
    expect(classifyEpubReadError(error, NOT_ARCHIVE_READ)).toBe('cap-exceeded');
  });

  it('does not reach cap-exceeded by accident', async () => {
    expect(classifyEpubReadError(new Error('boom'), ARCHIVE_READ)).toBe('decoder-failure');
    expect(classifyEpubReadError(coded(EPUB_CAP_EXCEEDED_CODE), ARCHIVE_READ)).toBe('throw');
  });
});

describe('classifyEpubReadError — the provenance argument is not omittable', () => {
  it('does not compile without an explicit provenance decision', () => {
    // @ts-expect-error - provenance is a required second argument
    const label = classifyEpubReadError(new Error('boom'));
    expect(label).toBe('throw');
  });
});
