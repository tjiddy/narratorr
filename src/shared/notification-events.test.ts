import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  NOTIFICATION_EVENTS,
  EVENT_LABELS,
  formatEventMessage,
  type NotificationEvent,
  type EventPayload,
} from './notification-events.js';

describe('notification-events (leaf module)', () => {
  describe('leaf module invariant', () => {
    it('has zero imports from src/shared/schemas/ or src/shared/notifier-registry', () => {
      const source = fs.readFileSync(
        path.resolve(__dirname, 'notification-events.ts'),
        'utf-8',
      );
      const importLines = source
        .split('\n')
        .filter((line) => /^import\s/.test(line));
      for (const line of importLines) {
        expect(line).not.toMatch(/schemas\//);
        expect(line).not.toMatch(/notifier-registry/);
      }
    });
  });

  describe('NOTIFICATION_EVENTS tuple', () => {
    it('contains all 5 expected event types', () => {
      expect(NOTIFICATION_EVENTS).toHaveLength(5);
      expect([...NOTIFICATION_EVENTS].sort()).toEqual([
        'on_download_complete',
        'on_failure',
        'on_grab',
        'on_health_issue',
        'on_import',
      ]);
    });
  });

  describe('EVENT_LABELS', () => {
    it('has an entry for every NOTIFICATION_EVENTS value', () => {
      for (const event of NOTIFICATION_EVENTS) {
        expect(EVENT_LABELS[event]).toBeDefined();
      }
    });

    it('has no extra keys beyond NOTIFICATION_EVENTS values', () => {
      const labelKeys = Object.keys(EVENT_LABELS).sort();
      expect(labelKeys).toEqual([...NOTIFICATION_EVENTS].sort());
    });

    it('every label is a non-empty string', () => {
      for (const event of NOTIFICATION_EVENTS) {
        expect(EVENT_LABELS[event]).toBeTypeOf('string');
        expect(EVENT_LABELS[event]!.length).toBeGreaterThan(0);
      }
    });
  });

  describe('formatEventMessage', () => {
    const makePayload = (overrides: Partial<EventPayload> = {}): EventPayload => ({
      event: 'on_grab' as NotificationEvent,
      ...overrides,
    });

    it('on_grab with book info includes title and author', () => {
      const result = formatEventMessage('on_grab', makePayload({
        book: { title: 'Dune', author: 'Frank Herbert' },
      }));
      expect(result).toBe('Grabbed: Dune by Frank Herbert');
    });

    it('on_grab without book info returns generic message', () => {
      const result = formatEventMessage('on_grab', makePayload());
      expect(result).toBe('Release grabbed');
    });

    it('on_download_complete with book info includes title', () => {
      const result = formatEventMessage('on_download_complete', makePayload({
        book: { title: 'Foundation' },
      }));
      expect(result).toBe('Download complete: Foundation');
    });

    it('on_download_complete without book info returns generic message', () => {
      const result = formatEventMessage('on_download_complete', makePayload());
      expect(result).toBe('Download complete');
    });

    it('on_import with book info includes title', () => {
      const result = formatEventMessage('on_import', makePayload({
        book: { title: 'Neuromancer', author: 'William Gibson' },
      }));
      expect(result).toBe('Imported: Neuromancer by William Gibson');
    });

    it('on_import without book info returns generic message', () => {
      const result = formatEventMessage('on_import', makePayload());
      expect(result).toBe('Import complete');
    });

    it('on_failure with error payload includes message and stage', () => {
      const result = formatEventMessage('on_failure', makePayload({
        error: { message: 'Connection refused', stage: 'download' },
      }));
      expect(result).toBe('Failure: Connection refused (download)');
    });

    it('on_failure without error payload returns generic message', () => {
      const result = formatEventMessage('on_failure', makePayload());
      expect(result).toBe('Failure occurred');
    });

    it('on_failure with error but no stage omits parenthetical', () => {
      const result = formatEventMessage('on_failure', makePayload({
        error: { message: 'Timeout' },
      }));
      expect(result).toBe('Failure: Timeout');
    });

    it('on_health_issue with health payload includes check name and state transition', () => {
      const result = formatEventMessage('on_health_issue', makePayload({
        health: {
          checkName: 'IndexerCheck',
          previousState: 'healthy',
          currentState: 'error',
          message: 'Indexer unreachable',
        },
      }));
      expect(result).toBe('Health issue: IndexerCheck changed from healthy → error: Indexer unreachable');
    });

    it('on_health_issue without health payload returns generic message', () => {
      const result = formatEventMessage('on_health_issue', makePayload());
      expect(result).toBe('Health issue detected');
    });

    it('on_health_issue with health but no message omits trailing text', () => {
      const result = formatEventMessage('on_health_issue', makePayload({
        health: {
          checkName: 'DiskCheck',
          previousState: 'warning',
          currentState: 'healthy',
        },
      }));
      expect(result).toBe('Health issue: DiskCheck changed from warning → healthy');
    });
  });

  describe('schema-registry alignment', () => {
    it('notificationEventSchema.options matches NOTIFICATION_EVENTS exactly', async () => {
      // Import dynamically to avoid pulling schema deps into this test
      const { notificationEventSchema } = await import('./schemas/notifier.js');
      expect([...notificationEventSchema.options].sort()).toEqual([...NOTIFICATION_EVENTS].sort());
    });
  });
});
