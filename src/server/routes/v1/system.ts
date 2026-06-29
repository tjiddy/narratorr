import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import os from 'os';
import { getVersion, getCommit, getBuildTime } from '../../utils/version.js';
import { systemV1Schema } from '../../../shared/schemas/v1/system.js';
import { v1ErrorHandler } from './_helpers.js';

/**
 * Native public API v1 — System (read). Registers `GET /api/v1/system` inside an
 * ENCAPSULATED plugin so the v1-scoped `v1ErrorHandler` (v1 error envelope) does
 * not leak onto internal `/api/*` routes. API-key auth is inherited automatically
 * via the global `/api/v*` `onRequest` hook (`src/server/plugins/auth.ts`) — no
 * per-route auth wiring. Mirrors `v1BooksRoutes`/`v1AuthorsRoutes` (#1449).
 *
 * This is a SINGLETON resource: the handler returns a plain object (NOT the
 * `{ data, total }` list envelope). The `.strict()` `systemV1Schema` `response`
 * schema FAILS CLOSED — it guarantees the sensitive `/api/system/info` fields
 * (`libraryPath`, `freeSpace`, `dbSize`) can never leak here, since any extra key
 * fails serialization rather than being silently stripped.
 *
 * All field values reuse existing sources — `getVersion()`/`getCommit()`/
 * `getBuildTime()` from `version.ts`, and `nodeVersion`/`os` derived exactly the
 * way `health-routes.ts`'s `/api/system/info` derives them (`process.version`;
 * `` `${os.type()} ${os.release()}` ``). No new business logic.
 *
 * Path note: `/api/v1/system` is a distinct, longer-prefix-safe path that does
 * NOT collide with or shadow the Prowlarr/Readarr compat shim at the longer
 * `/api/v1/system/status` (`src/server/routes/prowlarr-compat.ts`).
 */
export async function v1SystemRoutes(app: FastifyInstance): Promise<void> {
  await app.register(
    async (v1) => {
      v1.setErrorHandler(v1ErrorHandler);
      const typed = v1.withTypeProvider<ZodTypeProvider>();

      typed.get(
        '/system',
        {
          schema: {
            response: { 200: systemV1Schema },
          },
        },
        async () => ({
          version: getVersion(),
          commit: getCommit(),
          buildTime: getBuildTime(),
          nodeVersion: process.version,
          os: `${os.type()} ${os.release()}`,
        }),
      );
    },
    { prefix: '/api/v1' },
  );
}
