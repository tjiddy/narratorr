import type { FastifyInstance } from 'fastify';
import fastifySwagger, { type SwaggerTransform } from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';
import { getVersion } from '../../utils/version.js';
import { isProwlarrCompatPath } from '../prowlarr-compat.js';

// Expose only native v1 routes; internal and compatibility routes stay hidden.
// The auth plugin exempts this entire docs subtree through V1_DOCS_BASE_PATH.

/** Shared registration/auth prefix for the Swagger UI, specs, and assets. */
export const V1_DOCS_BASE_PATH = '/api/v1/docs';

export function isV1DocsPath(routePath: string, urlBase: string): boolean {
  const prefix = `${urlBase}${V1_DOCS_BASE_PATH}`;
  return routePath === prefix || routePath.startsWith(`${prefix}/`);
}

/**
 * Hide non-native routes before Zod conversion and strip URL_BASE from emitted paths.
 * URL_BASE lives only in servers[].url; stripBasePath must remain false below.
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
    const transformed = jsonSchemaTransform(input);
    if (urlBase && transformed.url.startsWith(urlBase)) {
      return { ...transformed, url: transformed.url.slice(urlBase.length) };
    }
    return transformed;
  };
}

/** Register before v1 routes so Swagger's onRoute hook captures them. */
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
    // createV1Transform owns URL_BASE stripping.
    stripBasePath: false,
    transform: createV1Transform(urlBase),
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: `${urlBase}${V1_DOCS_BASE_PATH}`,
  });
}
