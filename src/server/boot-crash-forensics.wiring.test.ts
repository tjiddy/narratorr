import { describe, it, expect, vi, type Mock } from 'vitest';
import os from 'node:os';
import path from 'node:path';

/**
 * Boots the real `main()` against mocked boundaries. The ordering between the early prune and the
 * database work is the whole point of this suite: "both were called" passes even when the order is
 * exactly backwards, which is the defect. Only the *neighbours* are mocked — the crash-forensics
 * entry points keep their real implementations so this also covers the first-boot shape, where the
 * artifact directory does not exist yet.
 */
const order: string[] = [];

const configDir = path.join(os.tmpdir(), 'narratorr-boot-wiring');

vi.mock('./config.js', () => ({
  config: {
    dbPath: path.join(configDir, 'narratorr.db'),
    configPath: configDir,
    isDev: true,
    port: 0,
    urlBase: '/',
    authBypass: false,
    trustedProxies: undefined,
  },
}));

vi.mock('fastify', () => {
  const app = {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), level: 'info' },
    withTypeProvider: () => app,
    setValidatorCompiler: vi.fn(),
    setSerializerCompiler: vi.fn(),
    register: vi.fn().mockResolvedValue(undefined),
  };
  return { default: () => app };
});

vi.mock('@db/index.js', () => ({
  runMigrations: vi.fn(async () => { order.push('runMigrations'); }),
  createDb: vi.fn(() => { order.push('createDb'); return {}; }),
}));

vi.mock('./boot-crash-forensics.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./boot-crash-forensics.js')>();
  return {
    ...actual,
    pruneCrashArtifactsAtBoot: vi.fn(async (log: never) => {
      order.push('pruneCrashArtifactsAtBoot');
      await actual.pruneCrashArtifactsAtBoot(log);
    }),
    checkCrashForensicsAtBoot: vi.fn(async (log: never) => {
      order.push('checkCrashForensicsAtBoot');
      await actual.checkCrashForensicsAtBoot(log);
    }),
  };
});

vi.mock('./services/backup.service.js', () => ({
  applyPendingRestore: vi.fn(() => { order.push('applyPendingRestore'); }),
}));
vi.mock('./routes', () => ({
  createServices: vi.fn(async () => ({
    settings: { get: vi.fn().mockResolvedValue({}) },
    auth: { initialize: vi.fn() },
  })),
  registerRoutes: vi.fn(),
}));
vi.mock('./server-utils.js', () => ({
  registerStaticAndSpa: vi.fn(),
  listenWithRetry: vi.fn(async () => { order.push('listen'); }),
}));
vi.mock('./startup.js', () => ({ startRuntime: vi.fn(async () => ({})) }));
vi.mock('./shutdown.js', () => ({ gracefulShutdown: vi.fn() }));
vi.mock('./plugins/security-plugins.js', () => ({ registerSecurityPlugins: vi.fn() }));
vi.mock('./plugins/auth.js', () => ({ default: vi.fn() }));
vi.mock('./plugins/error-handler.js', () => ({ errorHandlerPlugin: vi.fn() }));
vi.mock('./routes/v1/openapi.js', () => ({ registerV1OpenApi: vi.fn() }));
vi.mock('./request-trace-logging.js', () => ({ registerRequestTraceLogging: vi.fn() }));
vi.mock('./boot-warnings.js', () => ({
  warnIfAuthBypassWithUser: vi.fn(),
  checkReverseProxyBootConfig: vi.fn(),
}));
vi.mock('./boot-ffmpeg-version.js', () => ({ checkFfmpegVersionAtBoot: vi.fn() }));
vi.mock('./boot-mutagen-version.js', () => ({ checkMutagenVersionAtBoot: vi.fn() }));
vi.mock('./utils/secret-codec.js', () => ({
  loadEncryptionKey: vi.fn(() => ({ key: Buffer.alloc(32), source: 'env' })),
  initializeKey: vi.fn(),
}));
vi.mock('./utils/secret-migration.js', () => ({ migrateSecretsToEncrypted: vi.fn() }));

import Fastify from 'fastify';
import { listenWithRetry } from './server-utils.js';
import { checkCrashForensicsAtBoot, pruneCrashArtifactsAtBoot } from './boot-crash-forensics.js';

await import('./index.js');

// main() is fired from module scope, so the import resolves before boot finishes.
await vi.waitFor(() => expect(listenWithRetry).toHaveBeenCalled(), { timeout: 10_000 });

describe('crash-forensics boot wiring', () => {
  it('invokes both entry points exactly once during startup', () => {
    expect(pruneCrashArtifactsAtBoot).toHaveBeenCalledTimes(1);
    expect(checkCrashForensicsAtBoot).toHaveBeenCalledTimes(1);
  });

  it('prunes before the migration and the database open, not merely alongside them', () => {
    const prune = order.indexOf('pruneCrashArtifactsAtBoot');
    expect(prune).toBeGreaterThanOrEqual(0);
    expect(prune).toBeLessThan(order.indexOf('applyPendingRestore'));
    expect(prune).toBeLessThan(order.indexOf('runMigrations'));
    expect(prune).toBeLessThan(order.indexOf('createDb'));
  });

  it('keeps the readiness check with the other optional-capability probes, after the database', () => {
    expect(order.indexOf('checkCrashForensicsAtBoot')).toBeGreaterThan(order.indexOf('createDb'));
  });

  it('reaches listen on a first boot where the artifact directory does not exist yet', () => {
    // The real prune ran against a missing /config/crash-reports and neither threw nor warned.
    const log = (Fastify as unknown as () => { log: { warn: Mock } })().log;
    const pruneWarnings = log.warn.mock.calls.filter(
      ([, message]) => String(message).startsWith('Failed to prune') || String(message).startsWith('Pruned'),
    );

    expect(pruneWarnings).toEqual([]);
    expect(order.at(-1)).toBe('listen');
  });
});
