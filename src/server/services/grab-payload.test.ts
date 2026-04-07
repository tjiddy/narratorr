import { describe, it } from 'vitest';

describe('buildGrabPayload', () => {
  describe('base field mapping', () => {
    it.todo('maps downloadUrl, title, protocol, indexerId, size, seeders from SearchResult');
    it.todo('forwards bookId argument (not from SearchResult)');
    it.todo('does not include guid in base output');
  });

  describe('override merging', () => {
    it.todo('includes skipDuplicateCheck when provided as override');
    it.todo('includes source when provided as override');
    it.todo('includes guid only when explicitly provided as override');
    it.todo('omits undefined optional fields from SearchResult');
  });

  describe('type contract', () => {
    it.todo('returns exact shape matching downloadOrchestrator.grab() param type');
  });
});
