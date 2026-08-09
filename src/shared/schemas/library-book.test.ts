import { describe, it, expect } from 'vitest';
import { libraryBookListItemSchema } from './library-book.js';

describe('libraryBookListItemSchema editionLabel optionality (#1712)', () => {
  const base = {
    id: 1,
    title: 'Dark Matter',
    coverUrl: null,
    status: 'imported' as const,
    seriesName: null,
    seriesPosition: null,
    authors: [{ name: 'Blake Crouch' }],
    narrators: [{ name: 'Jon Lindstrom' }],
    audioTotalSize: null,
    size: null,
    audioFileFormat: null,
    audioDuration: null,
    duration: null,
    path: null,
    audioFileCount: null,
    lastGrabGuid: null,
    lastGrabInfoHash: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  it('accepts the key being absent', () => {
    const parsed = libraryBookListItemSchema.parse({ ...base });
    expect(parsed.editionLabel).toBeUndefined();
  });

  it('accepts an explicit null', () => {
    const parsed = libraryBookListItemSchema.parse({ ...base, editionLabel: null });
    expect(parsed.editionLabel).toBeNull();
  });

  it('accepts a string label', () => {
    const parsed = libraryBookListItemSchema.parse({ ...base, editionLabel: 'Full Cast' });
    expect(parsed.editionLabel).toBe('Full Cast');
  });
});
