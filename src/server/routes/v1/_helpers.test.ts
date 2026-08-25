import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, type Mock } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Db } from '@db/index.js';
import { createMockDb, mockDbChain, inject } from '../../__tests__/helpers.js';
import { v1BooksRoutes } from './books.js';
import { V1NotFoundError, v1ErrorHandler } from './_helpers.js';
import { expectNoLeak, makeLeakyDrizzleError } from '../../__tests__/drizzle-error.fixture.js';

// Fastify destroys failed streams before onErrorHook, so only a direct test reaches this guard.
function validationError(): FastifyError {
  return Object.assign(new Error('querystring must NOT have additional properties'), {
    code: 'FST_ERR_VALIDATION',
    statusCode: 400,
    validation: [{ keyword: 'additionalProperties', instancePath: '', schemaPath: '#/additionalProperties', params: {} }],
    name: 'FastifyError',
  }) as unknown as FastifyError;
}

const ERROR_CLASSES: Array<[string, () => FastifyError | Error]> = [
  ['a V1NotFoundError', () => new V1NotFoundError('Book not found')],
  ['a validation error', () => validationError()],
  ['a generic error', () => new Error('boom')],
];

function stubRequest() {
  const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return { request: { log } as unknown as FastifyRequest, log };
}

function stubReply(state: { sent?: boolean; headersSent?: boolean }) {
  const destroy = vi.fn();
  const send = vi.fn();
  const status = vi.fn(() => reply);
  const reply = {
    sent: state.sent ?? false,
    raw: { headersSent: state.headersSent ?? false, destroy },
    status,
    send,
  } as unknown as FastifyReply;
  return { reply, destroy, send, status };
}

describe('v1ErrorHandler', () => {
  describe('the committed-response guard', () => {
    // Every error class must hit the committed-response guard before classification.
    describe.each(ERROR_CLASSES)('with %s', (_label, makeError) => {
      it('destroys the raw response and sends nothing when raw.headersSent is true', () => {
        const { request } = stubRequest();
        const { reply, destroy, send, status } = stubReply({ headersSent: true });

        const returned = v1ErrorHandler(makeError(), request, reply);

        expect(returned).toBe(reply);
        expect(send).not.toHaveBeenCalled();
        expect(status).not.toHaveBeenCalled();
        expect(destroy).toHaveBeenCalledTimes(1);
      });

      it('destroys the raw response and sends nothing when reply.sent is true', () => {
        const { request } = stubRequest();
        const { reply, destroy, send, status } = stubReply({ sent: true, headersSent: false });

        const returned = v1ErrorHandler(makeError(), request, reply);

        expect(returned).toBe(reply);
        expect(send).not.toHaveBeenCalled();
        expect(status).not.toHaveBeenCalled();
        expect(destroy).toHaveBeenCalledTimes(1);
      });
    });

    it('logs the error exactly once, through serializeError (AC26)', () => {
      const { request, log } = stubRequest();
      const { reply } = stubReply({ headersSent: true });

      v1ErrorHandler(new Error('boom'), request, reply);

      const records = [...log.error.mock.calls, ...log.warn.mock.calls];
      expect(records).toHaveLength(1);
      const record = records[0]![0] as { error: unknown };
      // Non-enumerable message/stack cannot distinguish this from a raw Error; own keys can.
      expect(Object.keys(record.error as object)).toEqual(
        expect.arrayContaining(['message', 'type']),
      );
      expect((record.error as { type: string }).type).toBe('Error');
    });
  });

  describe('the existing mappings, for an uncommitted reply', () => {
    it('maps V1NotFoundError to 404 NOT_FOUND', () => {
      const { request, log } = stubRequest();
      const { reply, send, status, destroy } = stubReply({});

      v1ErrorHandler(new V1NotFoundError('Book not found'), request, reply);

      expect(status).toHaveBeenCalledWith(404);
      expect(send).toHaveBeenCalledWith({ error: { code: 'NOT_FOUND', message: 'Book not found' } });
      expect(destroy).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith({ code: 'NOT_FOUND' }, 'Book not found');
    });

    it('maps a validation error to 400 BAD_REQUEST', () => {
      const { request, log } = stubRequest();
      const { reply, send, status, destroy } = stubReply({});
      const error = validationError();

      v1ErrorHandler(error, request, reply);

      expect(status).toHaveBeenCalledWith(400);
      expect(send).toHaveBeenCalledWith({ error: { code: 'BAD_REQUEST', message: error.message } });
      expect(destroy).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith({ code: 'BAD_REQUEST' }, error.message);
    });

    it('maps anything else to 500 INTERNAL_ERROR without leaking the message', () => {
      const { request, log } = stubRequest();
      const { reply, send, status, destroy } = stubReply({});

      v1ErrorHandler(new Error('a leaky internal detail'), request, reply);

      expect(status).toHaveBeenCalledWith(500);
      expect(send).toHaveBeenCalledWith({
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
      });
      expect(destroy).not.toHaveBeenCalled();
      expect(log.error).toHaveBeenCalledTimes(1);
      // The sibling headers-sent case already serialized; this branch did not until #2604 AC7.
      const record = log.error.mock.calls[0]![0] as { error: { type: string } };
      expect(record.error.type).toBe('Error');
    });

    // T35 — `v1ErrorHandler` is installed by every v1 plugin, so this one blind spot was ten sinks.
    it('serializes an unhandled drizzle error on the uncommitted-reply branch (AC7 / L6b)', () => {
      const { request, log } = stubRequest();
      const { reply, send, status } = stubReply({});

      v1ErrorHandler(makeLeakyDrizzleError() as FastifyError, request, reply);

      expect(status).toHaveBeenCalledWith(500);
      expect(send).toHaveBeenCalledWith({
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
      });

      const record = log.error.mock.calls[0]![0] as Record<string, unknown> & { error: { type: string } };
      expect(record.error.type).toBe('DrizzleQueryError');
      expect(record).not.toHaveProperty('query');
      expect(record).not.toHaveProperty('params');
      expectNoLeak(JSON.stringify(record));
      // Pino writes argument 1 as `msg`; serializing argument 0 leaves it untouched.
      const message = String(log.error.mock.calls[0]![1]);
      expectNoLeak(message);
      expect(message).toContain('FOREIGN KEY constraint failed');
    });
  });
});

describe('v1 route error envelopes are unchanged by the guard', () => {
  let app: FastifyInstance;
  let db: ReturnType<typeof createMockDb>;

  beforeAll(async () => {
    app = Fastify({ logger: false, routerOptions: { maxParamLength: 2048 } }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    db = createMockDb();
    // Auth would return 401 before these v1 error paths run.
    await v1BooksRoutes(app, {
      bookService: { getById: vi.fn().mockResolvedValue(null) } as never,
      bookListService: { getAll: vi.fn().mockResolvedValue({ data: [], total: 0 }) } as never,
      metadataService: {} as never,
      downloadOrchestrator: {} as never,
      indexerSearchService: {} as never,
      indexerService: {} as never,
      blacklistService: {} as never,
      settingsService: { get: vi.fn().mockResolvedValue({ enabled: false }) } as never,
      eventHistory: {} as never,
      eventBroadcaster: {} as never,
    }, inject<Db>(db));
    await app.ready();
  });

  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    (db.select as Mock).mockReturnValue(mockDbChain([]));
  });

  it('still returns the 404 NOT_FOUND envelope for an unresolvable publicId', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/books/bk_nope' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String) } });
  });

  it('still returns the 400 BAD_REQUEST envelope for an unknown querystring param', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/books?bogus=1' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: 'BAD_REQUEST', message: expect.any(String) } });
  });
});
