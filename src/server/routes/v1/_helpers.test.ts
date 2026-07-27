import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, type Mock } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Db } from '../../../db/index.js';
import { createMockDb, mockDbChain, inject } from '../../__tests__/helpers.js';
import { v1BooksRoutes } from './books.js';
import { V1NotFoundError, v1ErrorHandler } from './_helpers.js';

// ============================================================================
// v1ErrorHandler — the committed-response guard (#1975 AC23-AC26)
// ============================================================================
//
// The guard is exercised by calling `v1ErrorHandler` DIRECTLY with a stubbed
// reply, not through a route. That is deliberate: Fastify 5.8.5's `sendStream`
// (`node_modules/fastify/lib/reply.js:768-789`) checks
// `res.headersSent || reply.request.raw.aborted` in its `eos` callback and calls
// `res.destroy()` INSTEAD of `onErrorHook`, so a route-level "force a stream
// error and assert the guard fired" test passes with the guard deleted — exactly
// the hollow assertion `narratorr/no-tautological-expect` exists to catch. The
// observable route-level property (no JSON appended to a committed 200) is
// asserted in `v1/companion-ebook-stream.test.ts` against received bytes instead.

/** A validation-shaped Fastify error, matching what the schema compiler throws. */
function validationError(): FastifyError {
  return Object.assign(new Error('querystring must NOT have additional properties'), {
    code: 'FST_ERR_VALIDATION',
    statusCode: 400,
    validation: [{ keyword: 'additionalProperties', instancePath: '', schemaPath: '#/additionalProperties', params: {} }],
    name: 'FastifyError',
  }) as unknown as FastifyError;
}

/** The three error classes the handler maps, by name. */
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
    // AC24 — the guard is the FIRST branch, so it must fire for EVERY error class.
    // A guard placed after the not-found/validation branches would still pass a
    // generic-error-only test while attempting an envelope send on those two.
    describe.each(ERROR_CLASSES)('with %s', (_label, makeError) => {
      it('destroys the raw response and sends nothing when raw.headersSent is true', () => {
        const { request, log } = stubRequest();
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
      // Per learning #1982: `Error.prototype.message`/`.stack` are NON-ENUMERABLE and read
      // through, so `objectContaining({ message })` passes for a RAW Error and proves
      // nothing. Assert on the own-enumerable key set plus serializeError's `type` field —
      // both are absent on a raw Error and present only after serialization.
      expect(Object.keys(record.error as object)).toEqual(
        expect.arrayContaining(['message', 'type']),
      );
      expect((record.error as { type: string }).type).toBe('Error');
    });
  });

  // AC25 — every existing mapping is byte-identical for a not-yet-committed reply.
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
    });
  });
});

// ----------------------------------------------------------------------------
// Blast radius: the guard sits on the error path of every v1 route module.
// ----------------------------------------------------------------------------
describe('v1 route error envelopes are unchanged by the guard', () => {
  let app: FastifyInstance;
  let db: ReturnType<typeof createMockDb>;

  beforeAll(async () => {
    app = Fastify({ logger: false, routerOptions: { maxParamLength: 2048 } }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    db = createMockDb();
    // No auth plugin: this suite exercises the v1 ERROR path, and the auth hook
    // would answer 401 before routing ever reached it.
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
