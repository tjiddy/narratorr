import { describe, it } from 'vitest';

describe('GET /api/import-jobs', () => {
  describe('happy path', () => {
    it.todo('returns import jobs with book title and coverUrl');
    it.todo('returns primaryAuthorName hydrated via bookAuthors + authors join');
    it.todo('returns parsed phaseHistory array from JSON column');
    it.todo('filters by status query param');
  });

  describe('edge cases', () => {
    it.todo('returns empty array when no import jobs exist');
    it.todo('returns job with null bookId gracefully (book deleted after queue)');
    it.todo('returns job with no author (book has no bookAuthors rows)');
  });

  describe('response shape', () => {
    it.todo('matches { id, bookId, type, status, phase, phaseHistory, createdAt, updatedAt, startedAt, completedAt, book }');
  });
});
