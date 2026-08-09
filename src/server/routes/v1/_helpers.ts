import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import type { DbOrTx } from '@db/index.js';
import type { authors, books, downloads, narrators, series } from '@db/schema.js';
import { resolveByPublicId } from '../../utils/public-id.js';
import { serializeError } from '../../utils/serialize-error.js';

type PublicIdTable = typeof books | typeof authors | typeof narrators | typeof series | typeof downloads;

/** Signals a v1-scoped 404 envelope. */
export class V1NotFoundError extends Error {
  constructor(message = 'Resource not found') {
    super(message);
    this.name = 'V1NotFoundError';
  }
}

// Resolution is opaque-ID only; numeric row IDs deliberately return 404.
export async function fetchByPublicId<TRow, TDto>(
  db: DbOrTx,
  table: PublicIdTable,
  publicId: string,
  fetch: (rowid: number) => Promise<TRow | null>,
  project: (row: TRow) => TDto,
): Promise<TDto> {
  const rowid = await resolveByPublicId(db, table, publicId);
  if (rowid === null) throw new V1NotFoundError();
  const row = await fetch(rowid);
  if (row === null) throw new V1NotFoundError();
  return project(row);
}

export function v1ErrorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  // This must precede classification: sending after headers corrupts the committed response.
  if (reply.sent || reply.raw.headersSent) {
    request.log.error(
      { error: serializeError(error) },
      'v1 error after the response was committed — destroying the connection',
    );
    reply.raw.destroy();
    return reply;
  }

  if (error instanceof V1NotFoundError) {
    request.log.warn({ code: 'NOT_FOUND' }, error.message);
    return reply.status(404).send({ error: { code: 'NOT_FOUND', message: error.message } });
  }

  if ('validation' in error && error.validation) {
    request.log.warn({ code: 'BAD_REQUEST' }, error.message);
    return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: error.message } });
  }

  request.log.error(error, error.message || 'Unhandled v1 error');
  return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
}
