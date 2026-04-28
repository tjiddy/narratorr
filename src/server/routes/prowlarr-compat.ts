import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { IndexerService } from '../services/indexer.service.js';
import { maskFields } from '../utils/secret-codec.js';
import { getVersion } from '../utils/version.js';

// ── Types ──

interface ReadarrField {
  name: string;
  value: unknown;
  type: string;
  advanced?: boolean;
}

// ── Request body schema (Readarr-compatible echo surface) ──

const readarrFieldSchema = z.object({
  name: z.string().min(1),
  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(z.union([z.string(), z.number()])),
  ]).optional(),
  type: z.string().optional(),
  advanced: z.boolean().optional(),
});

const readarrBodySchema = z.object({
  // Identification / echo fields
  id: z.number().int().optional(),
  name: z.string().optional(),
  implementation: z.string().min(1),
  implementationName: z.string().optional(),
  configContract: z.string().optional(),
  infoLink: z.string().optional(),
  // Flags
  enableRss: z.boolean().optional(),
  enableAutomaticSearch: z.boolean().optional(),
  enableInteractiveSearch: z.boolean().optional(),
  supportsRss: z.boolean().optional(),
  supportsSearch: z.boolean().optional(),
  // Other Readarr surface
  protocol: z.string().optional(),
  priority: z.number().int().min(0).max(100).optional(),
  downloadClientId: z.number().int().optional(),
  tags: z.array(z.number().int()).optional(),
  fields: z.array(readarrFieldSchema),
}).strict();

type ReadarrBody = z.infer<typeof readarrBodySchema>;

interface ReadarrIndexer {
  id: number;
  name: string;
  implementation: string;
  implementationName: string;
  configContract: string;
  infoLink: string;
  enableRss: boolean;
  enableAutomaticSearch: boolean;
  enableInteractiveSearch: boolean;
  supportsRss: boolean;
  supportsSearch: boolean;
  protocol: string;
  priority: number;
  downloadClientId: number;
  tags: number[];
  fields: ReadarrField[];
}

type IndexerRow = {
  id: number;
  name: string;
  type: string;
  enabled: boolean;
  priority: number;
  settings: Record<string, unknown>;
  source: string | null;
  sourceIndexerId: number | null;
  createdAt: Date;
};

// ── Field defaults ──

const FIELD_DEFAULTS: Record<string, unknown> = {
  apiPath: '/api',
  categories: [3030],
  minimumSeeders: 0,
  'seedCriteria.seedRatio': null,
  'seedCriteria.seedTime': null,
};

// ── Implementation → protocol/contract mapping ──

type IndexerType = 'abb' | 'torznab' | 'newznab' | 'myanonamouse';

const IMPL_MAP: Record<string, { protocol: string; configContract: string; type: IndexerType }> = {
  Torznab: { protocol: 'torrent', configContract: 'TorznabSettings', type: 'torznab' },
  Newznab: { protocol: 'usenet', configContract: 'NewznabSettings', type: 'newznab' },
};

const TYPE_TO_IMPL: Record<string, string> = {
  torznab: 'Torznab',
  newznab: 'Newznab',
};

// ── Translation utilities ──

/** Extract sourceIndexerId from the last numeric path segment of baseUrl (e.g., http://prowlarr:9696/1/ → 1) */
export function extractSourceIndexerId(baseUrl: string): number | null {
  let pathname: string;
  try {
    pathname = new URL(baseUrl).pathname;
  } catch {
    pathname = baseUrl;
  }
  const matches = [...pathname.matchAll(/\/(\d+)(?=[/]|$)/g)];
  return matches.length ? parseInt(matches[matches.length - 1][1], 10) : null;
}

/** Convert Readarr Fields[] to Narratorr internal settings */
export function fromReadarrFields(fields: ReadonlyArray<{ name: string; value?: unknown }>): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.name === 'baseUrl') {
      settings.apiUrl = field.value;
    } else if (field.name === 'apiPath') {
      // Echo-only: not stored, not used at runtime
      continue;
    } else {
      settings[field.name] = field.value;
    }
  }
  return settings;
}

/** Convert Narratorr internal settings + type to Readarr Fields[].
 *  Secret fields (apiKey, mamId, flareSolverrUrl) are masked with the sentinel
 *  before emission so plaintext credentials never leave the server. The standard
 *  CRUD path applies the same masking via secretEntity in registerCrudRoutes;
 *  this function preserves that invariant for the Prowlarr-compat surface.
 *  Sentinel passthrough on PUT/POST is handled by IndexerService.update via
 *  resolveSentinelFields. */
export function toReadarrFields(settings: Record<string, unknown>): ReadarrField[] {
  const masked = maskFields('indexer', { ...settings });
  const fields: ReadarrField[] = [];

  // baseUrl ↔ apiUrl mapping
  fields.push({ name: 'baseUrl', value: masked.apiUrl ?? '', type: 'textbox', advanced: false });
  fields.push({ name: 'apiPath', value: '/api', type: 'textbox', advanced: true });
  fields.push({ name: 'apiKey', value: masked.apiKey ?? '', type: 'textbox', advanced: false });
  fields.push({ name: 'categories', value: masked.categories ?? FIELD_DEFAULTS.categories, type: 'tag', advanced: false });
  fields.push({ name: 'minimumSeeders', value: masked.minimumSeeders ?? FIELD_DEFAULTS.minimumSeeders, type: 'number', advanced: true });
  fields.push({ name: 'seedCriteria.seedRatio', value: masked['seedCriteria.seedRatio'] ?? FIELD_DEFAULTS['seedCriteria.seedRatio'], type: 'number', advanced: true });
  fields.push({ name: 'seedCriteria.seedTime', value: masked['seedCriteria.seedTime'] ?? FIELD_DEFAULTS['seedCriteria.seedTime'], type: 'number', advanced: true });

  // Echo back any unknown fields stored in settings
  const knownKeys = new Set(['apiUrl', 'apiKey', 'categories', 'minimumSeeders', 'seedCriteria.seedRatio', 'seedCriteria.seedTime',
    // Internal-only keys not echoed as fields
    'hostname', 'pageLimit', 'flareSolverrUrl', 'useProxy', 'proxyUrl']);
  for (const [key, value] of Object.entries(masked)) {
    if (!knownKeys.has(key)) {
      fields.push({ name: key, value, type: 'textbox', advanced: true });
    }
  }

  return fields;
}

/** Convert a DB IndexerRow to the Readarr-compatible response shape */
function toReadarrIndexer(row: IndexerRow): ReadarrIndexer {
  const impl = TYPE_TO_IMPL[row.type] ?? row.type;
  const mapping = IMPL_MAP[impl];

  return {
    id: row.id,
    name: row.name,
    implementation: impl,
    implementationName: impl,
    configContract: mapping?.configContract ?? `${impl}Settings`,
    infoLink: '',
    enableRss: row.enabled,
    enableAutomaticSearch: row.enabled,
    enableInteractiveSearch: row.enabled,
    supportsRss: true,
    supportsSearch: true,
    protocol: mapping?.protocol ?? 'torrent',
    priority: row.priority,
    downloadClientId: 0,
    tags: [],
    fields: toReadarrFields(row.settings),
  };
}

/**
 * Domain validation for create/update bodies, run after Zod parsing inside the
 * route handler. Mirrors the legacy `validateReadarrBody` contract — returns
 * `{ message }` via the route handler instead of the global validation envelope.
 *
 * Why a string check (not just truthy): readarrFieldSchema.value is polymorphic
 * (string | number | boolean | null | (string|number)[]) for compat with
 * arbitrary Readarr fields. A non-string `baseUrl.value` would otherwise reach
 * `extractSourceIndexerId` (`pathname.matchAll` on a non-string throws TypeError)
 * and the Torznab/Newznab adapters require `apiKey: string`.
 */
function validateReadarrDomain(body: ReadarrBody): string | null {
  if (!IMPL_MAP[body.implementation]) {
    return `Unsupported implementation type: ${body.implementation}. Supported: ${Object.keys(IMPL_MAP).join(', ')}`;
  }

  const baseUrl = body.fields.find(f => f.name === 'baseUrl');
  if (!baseUrl || typeof baseUrl.value !== 'string' || baseUrl.value.trim() === '') {
    return 'Missing required field: baseUrl';
  }

  const apiKey = body.fields.find(f => f.name === 'apiKey');
  if (!apiKey || typeof apiKey.value !== 'string' || apiKey.value.trim() === '') {
    return 'Missing required field: apiKey';
  }

  return null;
}

// ── Package version (shared util) ──

// Track app start time
const appStartTime = new Date().toISOString();

// ── Helpers ──

/** Parse a Readarr request body, returning settings with defaults applied */
function parseReadarrBody(body: ReadarrBody) {
  const impl = body.implementation;
  const mapping = IMPL_MAP[impl]!;
  const settings = fromReadarrFields(body.fields);
  const baseUrl = (settings.apiUrl as string) ?? '';
  const sourceIndexerId = extractSourceIndexerId(baseUrl);

  // Apply defaults for fields not provided
  for (const [key, defaultValue] of Object.entries(FIELD_DEFAULTS)) {
    if (key !== 'apiPath' && settings[key] === undefined) {
      settings[key] = defaultValue;
    }
  }

  return { impl, mapping, settings, sourceIndexerId };
}

function makeSchemaTemplate(impl: string) {
  const mapping = IMPL_MAP[impl]!;
  return {
    id: 0, name: '', implementation: impl, implementationName: impl,
    configContract: mapping.configContract, infoLink: '',
    enableRss: true, enableAutomaticSearch: true, enableInteractiveSearch: true,
    supportsRss: true, supportsSearch: true,
    protocol: mapping.protocol, priority: 50, downloadClientId: 0, tags: [],
    fields: [
      { name: 'baseUrl', value: '', type: 'textbox', advanced: false },
      { name: 'apiPath', value: '/api', type: 'textbox', advanced: true },
      { name: 'apiKey', value: '', type: 'textbox', advanced: false },
      { name: 'categories', value: [3030], type: 'tag', advanced: false },
      { name: 'minimumSeeders', value: 0, type: 'number', advanced: true },
      { name: 'seedCriteria.seedRatio', value: null, type: 'number', advanced: true },
      { name: 'seedCriteria.seedTime', value: null, type: 'number', advanced: true },
    ],
  };
}

// ── Routes ──

function registerSystemRoutes(app: FastifyInstance) {
  app.get('/api/v1/system/status', async () => ({
    appName: 'Narratorr',
    version: getVersion(),
    instanceName: 'Narratorr',
    startTime: appStartTime,
    startupPath: process.cwd(),
    isLinux: true,
    isDocker: !!process.env.DOCKER,
    branch: 'main',
    authentication: 'apiKey',
  }));
}

function registerIndexerRoutes(app: FastifyInstance, indexerService: IndexerService) {
  app.get('/api/v1/indexer/schema', async () => [makeSchemaTemplate('Torznab'), makeSchemaTemplate('Newznab')]);

  app.get('/api/v1/indexer', async () => {
    const all = await indexerService.getAll();
    return all.map(row => toReadarrIndexer(row as IndexerRow));
  });

  app.get<{ Params: { id: string } }>('/api/v1/indexer/:id', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    if (isNaN(id)) return reply.status(404).send({ message: 'Indexer not found' });
    const row = await indexerService.getById(id);
    if (!row) return reply.status(404).send({ message: 'Indexer not found' });
    return toReadarrIndexer(row as IndexerRow);
  });

  app.post<{ Body: ReadarrBody; Querystring: { forceSave?: string } }>(
    '/api/v1/indexer',
    { schema: { body: readarrBodySchema } },
    async (request, reply) => {
      const body = request.body;
      const domainError = validateReadarrDomain(body);
      if (domainError) return reply.status(400).send({ message: domainError });

      const { mapping, settings, sourceIndexerId } = parseReadarrBody(body);
      const result = await indexerService.createOrUpsertProwlarr({
        name: body.name ?? body.implementation,
        type: mapping.type,
        enabled: body.enableRss ?? true,
        priority: body.priority ?? 50,
        settings,
        sourceIndexerId,
      });

      const statusCode = 201;
      request.log.info({ id: result.row.id, sourceIndexerId, upserted: result.upserted }, 'Prowlarr indexer created/upserted');
      return reply.status(statusCode).send(toReadarrIndexer(result.row as IndexerRow));
    },
  );

  app.put<{ Params: { id: string }; Body: ReadarrBody }>(
    '/api/v1/indexer/:id',
    { schema: { body: readarrBodySchema } },
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      if (isNaN(id)) return reply.status(404).send({ message: 'Indexer not found' });

      const body = request.body;
      const domainError = validateReadarrDomain(body);
      if (domainError) return reply.status(400).send({ message: domainError });

      const { mapping, settings, sourceIndexerId } = parseReadarrBody(body);
      const updated = await indexerService.update(id, {
        name: body.name ?? body.implementation,
        type: mapping.type,
        enabled: body.enableRss ?? true,
        priority: body.priority ?? 50,
        settings,
        source: 'prowlarr',
        sourceIndexerId,
      });

      if (!updated) return reply.status(404).send({ message: 'Indexer not found' });
      request.log.info({ id }, 'Prowlarr indexer updated');
      return toReadarrIndexer(updated as IndexerRow);
    },
  );

  app.delete<{ Params: { id: string } }>('/api/v1/indexer/:id', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    if (isNaN(id)) return reply.status(404).send({ message: 'Indexer not found' });
    const deleted = await indexerService.delete(id);
    if (!deleted) return reply.status(404).send({ message: 'Indexer not found' });
    request.log.info({ id }, 'Prowlarr indexer deleted');
    return reply.status(200).send({});
  });

  app.post<{ Body: ReadarrBody }>(
    '/api/v1/indexer/test',
    { schema: { body: readarrBodySchema } },
    async (request, reply) => {
      const body = request.body;
      const impl = body.implementation;
      if (!IMPL_MAP[impl]) {
        return reply.status(400).send({
          isWarning: false,
          message: `Unsupported implementation: ${impl}`,
          detailedDescription: 'Only Torznab and Newznab are supported.',
        });
      }

      const mapping = IMPL_MAP[impl]!;
      const settings = fromReadarrFields(body.fields);
      const result = await indexerService.testConfig({ type: mapping.type, settings });

      if (result.success) return reply.status(200).send({});
      return reply.status(400).send({
        isWarning: false,
        message: result.message ?? 'Connection test failed',
        detailedDescription: result.message ?? 'Could not connect to the indexer.',
      });
    },
  );
}

export async function prowlarrCompatRoutes(app: FastifyInstance, indexerService: IndexerService) {
  registerSystemRoutes(app);
  registerIndexerRoutes(app, indexerService);
}
