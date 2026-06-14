import type { FastifyInstance } from 'fastify';
import fastifySwagger, { type SwaggerTransform } from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';
import { getVersion } from '../../utils/version.js';
import { isProwlarrCompatPath } from '../prowlarr-compat.js';

// ============================================================================
// Public API v1 — OpenAPI/Swagger documentation (S9 — #1454)
// ============================================================================
//
// Generates an OpenAPI spec + browsable Swagger UI over the NATIVE `/api/v1`
// surface ONLY. The spec is the public contract third-party consumers rely on,
// so the entire docs subtree is intentionally reachable WITHOUT an API key — the
// auth plugin exempts it via a prefix check keyed off `V1_DOCS_BASE_PATH` (the
// single source of truth shared with `src/server/plugins/auth.ts`, mirroring the
// `PROWLARR_COMPAT_PATHS` pattern so registration and exemption cannot drift).
//
// Scope: the `transform` below converts the route Zod schemas to OpenAPI JSON
// Schema (via `jsonSchemaTransform`) for native v1 routes and `hide`s everything
// else — internal `/api/*` routes AND the Prowlarr/Readarr compat shim under
// `/api/v1/*` (NOT native v1, see `src/shared/schemas/v1/common.ts`) — so the
// public spec never leaks the unstable internal surface.

/**
 * Base path (WITHOUT URL_BASE) of the native v1 OpenAPI docs subtree. Swagger UI
 * serves a whole subtree under this prefix — the UI root (`/`), the spec JSON
 * (`/json`), YAML (`/yaml`), and static assets (`/static/*`) — so both the
 * registration `routePrefix` here and the auth exemption derive from this ONE
 * constant. A single exact-match allowlist entry would leave the sub-paths 401.
 */
export const V1_DOCS_BASE_PATH = '/api/v1/docs';

/**
 * Is `routePath` equal to or under the v1 docs subtree (URL_BASE-prefixed)?
 * Used by the auth plugin to exempt the whole docs subtree from API-key auth.
 * `urlBase` is the active URL_BASE (`''` when unset), never a hardcoded literal.
 */
export function isV1DocsPath(routePath: string, urlBase: string): boolean {
  const prefix = `${urlBase}${V1_DOCS_BASE_PATH}`;
  return routePath === prefix || routePath.startsWith(`${prefix}/`);
}

/**
 * Build the `@fastify/swagger` `transform`: convert native v1 routes' Zod
 * schemas to OpenAPI JSON Schema, `hide` everything else. A route is native v1
 * when its url is `${urlBase}/api/v1` (or under it) AND it is neither the
 * Prowlarr/Readarr compat shim nor the docs subtree itself. The whole `input`
 * (including the swagger `documentObject` that carries the OAS version) is passed
 * through to `jsonSchemaTransform`; for non-v1 routes we set `hide: true`, which
 * `jsonSchemaTransform` honors with an early return BEFORE touching the (possibly
 * non-Zod) schema, so internal routes are excluded without choking the transform.
 */
function createV1Transform(urlBase: string): SwaggerTransform {
  const v1Prefix = `${urlBase}/api/v1`;
  return (input) => {
    const { schema, url } = input;
    const isNativeV1 =
      (url === v1Prefix || url.startsWith(`${v1Prefix}/`)) &&
      !isProwlarrCompatPath(url, urlBase) &&
      !isV1DocsPath(url, urlBase);
    if (!isNativeV1) {
      return jsonSchemaTransform({ ...input, schema: { ...schema, hide: true } });
    }
    return jsonSchemaTransform(input);
  };
}

/**
 * Register `@fastify/swagger` + `@fastify/swagger-ui` scoped to the native v1
 * surface. MUST be registered BEFORE the v1 routes so the swagger `onRoute` hook
 * captures them. `urlBase` is the active URL_BASE prefix (`''` when unset); the
 * docs serve under `{urlBase}/api/v1/docs` and the spec's `servers` base path
 * reflects the prefix.
 */
export async function registerV1OpenApi(app: FastifyInstance, urlBase: string): Promise<void> {
  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'Narratorr API',
        description: 'Public API v1 for Narratorr — the self-hosted audiobook manager.',
        version: getVersion(),
      },
      servers: [{ url: urlBase || '/' }],
    },
    transform: createV1Transform(urlBase),
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: `${urlBase}${V1_DOCS_BASE_PATH}`,
  });
}
