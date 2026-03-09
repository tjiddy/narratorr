import type { FastifyInstance } from 'fastify';
import type { IndexerService } from '../services/indexer.service.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Types ──

interface ReadarrField {
  name: string;
  value: unknown;
  type: string;
  advanced?: boolean;
}

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
export function fromReadarrFields(fields: ReadarrField[]): Record<string, unknown> {
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

/** Convert Narratorr internal settings + type to Readarr Fields[] */
export function toReadarrFields(settings: Record<string, unknown>): ReadarrField[] {
  const fields: ReadarrField[] = [];

  // baseUrl ↔ apiUrl mapping
  fields.push({ name: 'baseUrl', value: settings.apiUrl ?? '', type: 'textbox', advanced: false });
  fields.push({ name: 'apiPath', value: '/api', type: 'textbox', advanced: true });
  fields.push({ name: 'apiKey', value: settings.apiKey ?? '', type: 'textbox', advanced: false });
  fields.push({ name: 'categories', value: settings.categories ?? FIELD_DEFAULTS.categories, type: 'tag', advanced: false });
  fields.push({ name: 'minimumSeeders', value: settings.minimumSeeders ?? FIELD_DEFAULTS.minimumSeeders, type: 'number', advanced: true });
  fields.push({ name: 'seedCriteria.seedRatio', value: settings['seedCriteria.seedRatio'] ?? FIELD_DEFAULTS['seedCriteria.seedRatio'], type: 'number', advanced: true });
  fields.push({ name: 'seedCriteria.seedTime', value: settings['seedCriteria.seedTime'] ?? FIELD_DEFAULTS['seedCriteria.seedTime'], type: 'number', advanced: true });

  // Echo back any unknown fields stored in settings
  const knownKeys = new Set(['apiUrl', 'apiKey', 'categories', 'minimumSeeders', 'seedCriteria.seedRatio', 'seedCriteria.seedTime',
    // Internal-only keys not echoed as fields
    'hostname', 'pageLimit', 'flareSolverrUrl', 'useProxy', 'proxyUrl']);
  for (const [key, value] of Object.entries(settings)) {
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

/** Validate Readarr-format indexer request body. Returns error message or null. */
function validateReadarrBody(body: { implementation?: string; fields?: ReadarrField[] }): string | null {
  if (!body.implementation || !IMPL_MAP[body.implementation]) {
    return `Unsupported implementation type: ${body.implementation ?? '(missing)'}. Supported: ${Object.keys(IMPL_MAP).join(', ')}`;
  }

  const fields = body.fields ?? [];
  const baseUrl = fields.find(f => f.name === 'baseUrl');
  if (!baseUrl || !baseUrl.value || (typeof baseUrl.value === 'string' && baseUrl.value.trim() === '')) {
    return 'Missing required field: baseUrl';
  }

  const apiKey = fields.find(f => f.name === 'apiKey');
  if (!apiKey || !apiKey.value || (typeof apiKey.value === 'string' && apiKey.value.trim() === '')) {
    return 'Missing required field: apiKey';
  }

  return null;
}

// ── Package version ──

let packageVersion: string | undefined;
function getVersion(): string {
  if (!packageVersion) {
    try {
      const pkgPath = resolve(process.cwd(), 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      packageVersion = pkg.version;
    } catch {
      packageVersion = '0.0.0';
    }
  }
  return packageVersion!;
}

// Track app start time
const appStartTime = new Date().toISOString();

// ── Helpers ──

type ReadarrBody = { name?: string; implementation?: string; fields?: ReadarrField[]; priority?: number; enableRss?: boolean };

/** Parse and validate a Readarr request body, returning settings with defaults applied */
function parseReadarrBody(body: ReadarrBody) {
  const impl = body.implementation!;
  const mapping = IMPL_MAP[impl]!;
  const settings = fromReadarrFields(body.fields ?? []);
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

  app.post<{ Body: Record<string, unknown>; Querystring: { forceSave?: string } }>(
    '/api/v1/indexer',
    async (request, reply) => {
      const body = request.body as ReadarrBody;
      const validationError = validateReadarrBody(body);
      if (validationError) return reply.status(400).send({ message: validationError });

      const { mapping, settings, sourceIndexerId } = parseReadarrBody(body);
      const result = await indexerService.createOrUpsertProwlarr({
        name: body.name ?? body.implementation!,
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

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/v1/indexer/:id',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      if (isNaN(id)) return reply.status(404).send({ message: 'Indexer not found' });

      const body = request.body as ReadarrBody;
      const validationError = validateReadarrBody(body);
      if (validationError) return reply.status(400).send({ message: validationError });

      const { mapping, settings, sourceIndexerId } = parseReadarrBody(body);
      const updated = await indexerService.update(id, {
        name: body.name ?? body.implementation!,
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

  app.post<{ Body: Record<string, unknown> }>('/api/v1/indexer/test', async (request, reply) => {
    const body = request.body as { implementation?: string; fields?: ReadarrField[] };
    const impl = body.implementation;
    if (!impl || !IMPL_MAP[impl]) {
      return reply.status(400).send({
        isWarning: false,
        message: `Unsupported implementation: ${impl ?? '(missing)'}`,
        detailedDescription: 'Only Torznab and Newznab are supported.',
      });
    }

    const mapping = IMPL_MAP[impl]!;
    const settings = fromReadarrFields(body.fields ?? []);
    const result = await indexerService.testConfig({ type: mapping.type, settings });

    if (result.success) return reply.status(200).send({});
    return reply.status(400).send({
      isWarning: false,
      message: result.message ?? 'Connection test failed',
      detailedDescription: result.message ?? 'Could not connect to the indexer.',
    });
  });
}

export async function prowlarrCompatRoutes(app: FastifyInstance, indexerService: IndexerService) {
  registerSystemRoutes(app);
  registerIndexerRoutes(app, indexerService);
}
