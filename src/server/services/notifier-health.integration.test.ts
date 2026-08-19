import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NotifierService } from './notifier.service.js';
import { HealthCheckService } from './health-check.service.js';
import { notifyImportComplete, recordImportEvent } from '../utils/import-side-effects.js';
import { mockDbChain, createMockDb, createMockLogger, inject, createMockSettingsService } from '../__tests__/helpers.js';
import { createMockDbNotifier } from '../__tests__/factories.js';
import { initializeKey, _resetKey } from '../utils/secret-codec.js';
import { NOTIFIER_WARN_AFTER_CONSECUTIVE_FAILURES } from './notifier-failure-state.js';
import type { FastifyBaseLogger } from 'fastify';
import type { IndexerService } from './indexer.service.js';
import type { DownloadClientService } from './download-client.service.js';
import type { SettingsService } from './settings.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { Db } from '@db/index.js';

vi.mock('nodemailer', () => ({ createTransport: vi.fn() }));
import { createTransport } from 'nodemailer';

const TEST_KEY = Buffer.from('a'.repeat(64), 'hex');
const mockSendMail = vi.fn();

const EMAIL_NOTIFIER = createMockDbNotifier({
  id: 3,
  name: 'Email',
  type: 'email',
  events: ['on_import', 'on_health_issue'],
  settings: { smtpHost: 'smtp.test', fromAddress: 'a@b.com', toAddress: 'c@d.com' },
});

/** The relay-side rejection observed on the live instance: permanent, and only the operator can fix it. */
function recipientRejected(): Error {
  return Object.assign(new Error('554 5.7.1 <c@d.com>: Recipient address rejected'), {
    responseCode: 554,
    code: 'EENVELOPE',
  });
}

function build() {
  const db = createMockDb();
  const log = createMockLogger();
  db.select.mockReturnValue(mockDbChain([EMAIL_NOTIFIER]));

  const clock = { now: 1_700_000_000_000 };
  const notifierService = new NotifierService(db as never, log as never, () => clock.now);

  const health = new HealthCheckService(
    inject<IndexerService>({ getAll: vi.fn().mockResolvedValue([]), test: vi.fn() }),
    inject<DownloadClientService>({ getAll: vi.fn().mockResolvedValue([]), test: vi.fn() }),
    inject<SettingsService>(createMockSettingsService({ processing: {} })),
    notifierService,
    inject<Db>({ select: vi.fn().mockReturnValue(mockDbChain([])) }),
    inject<FastifyBaseLogger>(log),
    {
      fsAccess: vi.fn().mockResolvedValue(undefined),
      fsStatfs: vi.fn().mockResolvedValue({ bavail: 100_000_000, bsize: 4096 }),
      probeFfmpeg: vi.fn().mockResolvedValue('6.1.1'),
      probeMutagen: vi.fn().mockResolvedValue('1.47.0'),
      resolveProxyIp: vi.fn().mockResolvedValue('203.0.113.1'),
    },
  );

  return { db, log, clock, notifierService, health };
}

/** The import's own side effects, exactly as import-side-effects wires them at the call site. */
async function runImport(notifierService: NotifierService, eventHistory: EventHistoryService, log: FastifyBaseLogger) {
  notifyImportComplete({
    notifierService,
    bookTitle: 'Dune',
    authorName: 'Frank Herbert',
    targetPath: '/library/Frank Herbert/Dune',
    fileCount: 12,
    log,
  });
  recordImportEvent({
    eventHistory,
    bookId: 1,
    bookTitle: 'Dune',
    authorName: 'Frank Herbert',
    downloadId: 9,
    bookPath: '/library/Frank Herbert/Dune',
    targetPath: '/library/Frank Herbert/Dune',
    fileCount: 12,
    totalSize: 500,
    log,
  });
  // Let the fire-and-forget notification settle before observing state.
  await new Promise((r) => setImmediate(r));
}

describe('#2312 — a terminally broken notifier surfaces on the health roster', () => {
  beforeEach(() => {
    initializeKey(TEST_KEY);
    vi.mocked(createTransport).mockReturnValue({ sendMail: mockSendMail } as never);
    mockSendMail.mockReset();
  });

  afterEach(() => {
    _resetKey();
  });

  it('the import completes, records its event, and the notifier is reported error with a terminal reason', async () => {
    const { log, notifierService, health } = build();
    mockSendMail.mockRejectedValue(recipientRejected());
    const eventHistory = { create: vi.fn().mockResolvedValue(undefined) };

    await runImport(notifierService, inject<EventHistoryService>(eventHistory), inject<FastifyBaseLogger>(log));

    // (a) + (c) the operation completed and its own history is untouched by the failure.
    expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
      bookId: 1,
      bookTitle: 'Dune',
      eventType: 'imported',
    }));

    // (b) the health roster names it, in operator language rather than a raw reply code.
    const results = await health.runAllChecks();
    const check = results.find((r) => r.checkName === 'notifier:Email');

    expect(check).toMatchObject({
      state: 'error',
      target: { kind: 'notifier', id: 3 },
    });
    expect(check?.message).toContain('the mail server rejected the recipient or sender address');
    expect(check?.message).not.toContain('554');
    expect(health.getAggregateState()).toBe('error');
  });

  it('the announcement about the broken notifier is never routed through it', async () => {
    const { log, notifierService, health } = build();
    mockSendMail.mockRejectedValue(recipientRejected());
    const eventHistory = { create: vi.fn().mockResolvedValue(undefined) };

    await runImport(notifierService, inject<EventHistoryService>(eventHistory), inject<FastifyBaseLogger>(log));
    expect(mockSendMail).toHaveBeenCalledTimes(1);

    await health.runAllChecks();
    await new Promise((r) => setImmediate(r));

    // Without the exclusion the health issue would be mailed through the dead channel.
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(notifierService.getFailureSnapshot(3).suppressedCount).toBe(0);
  });

  // Each notify() call site wraps its own fireAndForget, so every event path is at risk
  // independently of the others.
  it.each(['on_grab', 'on_import', 'on_failure'] as const)(
    'notify(%s) resolves rather than rejecting when the notifier is terminally broken',
    async (event) => {
      const { db, notifierService } = build();
      db.select.mockReturnValue(mockDbChain([
        createMockDbNotifier({ ...EMAIL_NOTIFIER, events: ['on_grab', 'on_import', 'on_failure'] }),
      ]));
      mockSendMail.mockRejectedValue(recipientRejected());

      await expect(notifierService.notify(event, { event, book: { title: 'Dune' } })).resolves.toBeUndefined();
      await expect(notifierService.notify(event, { event, book: { title: 'Dune' } })).resolves.toBeUndefined();

      expect(notifierService.getFailureSnapshot(3).state).toBe('stopped');
    },
  );

  it('a transient relay failure warns rather than stopping, once the streak is long enough', async () => {
    const { log, clock, notifierService, health } = build();
    mockSendMail.mockRejectedValue(Object.assign(new Error('421 try again later'), { responseCode: 421 }));
    const eventHistory = { create: vi.fn().mockResolvedValue(undefined) };

    for (let i = 0; i < NOTIFIER_WARN_AFTER_CONSECUTIVE_FAILURES; i += 1) {
      clock.now += 60 * 60_000;
      await runImport(notifierService, inject<EventHistoryService>(eventHistory), inject<FastifyBaseLogger>(log));
    }

    const results = await health.runAllChecks();
    expect(results.find((r) => r.checkName === 'notifier:Email')).toMatchObject({ state: 'warning' });
    expect(mockSendMail).toHaveBeenCalledTimes(NOTIFIER_WARN_AFTER_CONSECUTIVE_FAILURES);
  });
});
