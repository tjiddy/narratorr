import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { SettingsService } from '../../services/settings.service.js';
import { capabilitiesV1Schema } from '@shared/schemas/v1/capabilities.js';
import { serializeError } from '../../utils/serialize-error.js';
import { v1ErrorHandler } from './_helpers.js';

export interface V1CapabilitiesRouteDeps {
  settingsService: SettingsService;
}

/**
 * Native public API v1 — Capabilities (read, #1961 plan §8). Registers
 * `GET /api/v1/capabilities` inside an ENCAPSULATED plugin so the v1-scoped
 * `v1ErrorHandler` (v1 error envelope) does not leak onto internal `/api/*`
 * routes. API-key auth is inherited automatically via the global `/api/v*`
 * `onRequest` hook (`src/server/plugins/auth.ts`) — no per-route auth wiring.
 * Mirrors `v1SystemRoutes`.
 *
 * A SINGLETON resource: the handler returns a plain object, not the
 * `{ data, total }` list envelope. Only `200` is declared — there is no error
 * outcome to send inline (`zod-type-provider-send-union-narrowing`).
 *
 * **The older-server signal.** A Narratorr predating this route has no
 * `/api/v1/capabilities`, so a consumer's "feature unsupported" signal is that
 * server's ambient `404`. Because the auth hook runs `onRequest` — before
 * routing — a KEYLESS probe of an unregistered path returns `401`, not `404`.
 * Consumers must therefore probe WITH a valid API key and treat `404` as
 * "unsupported" and `401` as an auth problem, never as "unsupported". The 404
 * body is the ambient shape (an unmatched route never enters this plugin, so
 * `v1ErrorHandler` does not run) — key on the STATUS CODE, never the body.
 *
 * **Fail-closed on a settings failure.** This endpoint reports the ABSENCE of a
 * feature; it does not report an outage. A rejected `settingsService.get` logs a
 * warn and answers `{ enabled: false }` — never a 5xx, which a consumer would
 * have to disambiguate from a real server fault.
 */
export async function v1CapabilitiesRoutes(app: FastifyInstance, deps: V1CapabilitiesRouteDeps): Promise<void> {
  await app.register(
    async (v1) => {
      v1.setErrorHandler(v1ErrorHandler);
      const typed = v1.withTypeProvider<ZodTypeProvider>();

      typed.get(
        '/capabilities',
        {
          schema: {
            response: { 200: capabilitiesV1Schema },
          },
        },
        async (request) => {
          let enabled = false;
          try {
            // The PARSED settings category, never a re-read of the raw row.
            enabled = (await deps.settingsService.get('companionEpub')).enabled;
          } catch (error: unknown) {
            request.log.warn(
              { error: serializeError(error) },
              'v1 capabilities: companionEpub settings read failed — reporting the feature as disabled',
            );
          }
          return { companionEpub: { enabled } };
        },
      );
    },
    { prefix: '/api/v1' },
  );
}
