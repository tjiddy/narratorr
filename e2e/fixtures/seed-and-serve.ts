import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { eq } from 'drizzle-orm';
import { books, settings } from '../../src/db/schema.js';
import { canonicalPath } from '../../src/server/utils/path-identity.js';
import { seedE2ERun } from './seed.js';
import { E2E_DEFAULT_PORTS, resolvePort } from './ports.js';
import { waitForTcpPorts } from './wait-for-ports.js';
import { SEED_LIBRARY_DIR_ENV } from './server-env.js';

/**
 * Each `webServer` launches this file instead of the production bundle directly, because Playwright
 * starts `webServer` entries BEFORE `globalSetup` and that is not configurable. Seeding here puts
 * the seed and the boot in one process in one order, so Playwright's health probe structurally
 * cannot observe a server that booted against an empty DB (#2452).
 */
export { SEED_LIBRARY_DIR_ENV };

export interface SeedInputs {
  dbPath: string;
  libraryPath: string;
  mamUrl: string;
  /** Host only, matching `qbittorrentSettingsSchema`; no protocol or port. */
  qbitHost: string;
  qbitPort: number;
}

export interface SeedAndServeDeps {
  /** Injected so the core is unit-testable; the CLI defaults it to importing the production bundle. */
  startServer: () => Promise<void>;
  /**
   * Resolves only when every fake is reachable; the boot is refused otherwise. The fakes host is
   * the first `webServer` entry, but that ordering lives in config — this gate is what makes
   * "no server boots against an unbound fake port" hold by construction (#2474): a lost race
   * opens the indexer breaker for ~60s and starves whichever spec searches inside the window.
   */
  waitForFakes: () => Promise<void>;
  /** Emitted between the marker check and the boot, so captured stdout carries the ordering proof. */
  log?: (message: string) => void;
}

export interface SeedAndServeCliHooks {
  env?: NodeJS.ProcessEnv;
  exit?: (code: number) => void;
  writeStderr?: (message: string) => void;
  writeStdout?: (message: string) => void;
  startServer?: () => Promise<void>;
  waitForFakes?: () => Promise<void>;
}

/** Derives every seed input from the wrapper's own env — nothing here depends on globalSetup. */
export function readSeedInputs(env: NodeJS.ProcessEnv): SeedInputs {
  const dbPath = env.DATABASE_URL?.trim();
  if (!dbPath) {
    throw new Error('seed-and-serve: DATABASE_URL is unset or empty, so there is no run DB to seed');
  }

  const libraryPath = env[SEED_LIBRARY_DIR_ENV]?.trim();
  if (!libraryPath) {
    throw new Error(`seed-and-serve: ${SEED_LIBRARY_DIR_ENV} is unset or empty, so settings.library.path cannot be seeded`);
  }

  return {
    dbPath,
    libraryPath,
    mamUrl: `http://localhost:${resolvePort('E2E_MAM_PORT', E2E_DEFAULT_PORTS.mam, env)}`,
    qbitHost: 'localhost',
    qbitPort: resolvePort('E2E_QBIT_PORT', E2E_DEFAULT_PORTS.qbit, env),
  };
}

/** Seeds, proves the seed landed, then starts the server. Any failure rejects without starting it. */
export async function seedAndServe(inputs: SeedInputs, deps: SeedAndServeDeps): Promise<void> {
  const dbDir = dirname(inputs.dbPath);
  if (!existsSync(dbDir)) {
    throw new Error(`seed-and-serve: the directory holding DATABASE_URL does not exist (${dbDir})`);
  }

  await seedE2ERun({
    dbPath: inputs.dbPath,
    mamUrl: inputs.mamUrl,
    qbitHost: inputs.qbitHost,
    qbitPort: inputs.qbitPort,
    libraryPath: inputs.libraryPath,
  });
  await assertSeedVisible(inputs.dbPath);
  deps.log?.(`[seed-and-serve] seed verified for ${inputs.dbPath}\n`);

  await deps.waitForFakes();
  deps.log?.(`[seed-and-serve] fakes reachable; starting the server\n`);

  await deps.startServer();
}

/** Reads the CLI's env, runs the core, and turns a rejection into a diagnostic plus a non-zero exit. */
export async function runSeedAndServeCli(hooks: SeedAndServeCliHooks = {}): Promise<void> {
  const {
    env = process.env,
    exit = (code: number): void => { process.exit(code); },
    writeStderr = (message: string): void => { process.stderr.write(message); },
    writeStdout = (message: string): void => { process.stdout.write(message); },
    startServer = importServerBundle,
    waitForFakes = (): Promise<void> => waitForTcpPorts([
      resolvePort('E2E_MAM_PORT', E2E_DEFAULT_PORTS.mam, env),
      resolvePort('E2E_QBIT_PORT', E2E_DEFAULT_PORTS.qbit, env),
      resolvePort('E2E_AUDIBLE_PORT', E2E_DEFAULT_PORTS.audible, env),
    ]),
  } = hooks;

  try {
    await seedAndServe(readSeedInputs(env), { startServer, waitForFakes, log: writeStdout });
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    writeStderr(
      `[seed-and-serve] refusing to start the server for DATABASE_URL=${env.DATABASE_URL ?? '<unset>'}: ${reason}\n`,
    );
    exit(1);
  }
}

/**
 * A fresh connection, deliberately not the one the seed transaction wrote through: the original
 * defect (#2452) was a server reading an empty DB, which a same-connection read cannot observe.
 */
async function assertSeedVisible(dbPath: string): Promise<void> {
  const client = createClient({ url: `file:${dbPath}` });
  const db = drizzle(client);
  try {
    const general = await db.select().from(settings).where(eq(settings.key, 'general'));
    const seeded = await db.select().from(books);
    if (general.length === 0 || seeded.length === 0) {
      throw new Error(
        `seed-and-serve: the seeded marker rows are not visible through a fresh connection to ${dbPath} ` +
        `(settings.general rows: ${general.length}, books rows: ${seeded.length})`,
      );
    }
  } finally {
    client.close();
  }
}

/**
 * Imported, not spawned: `node --import tsx` registers the loader in-process, so Playwright manages
 * exactly one PID and its existing kill path keeps working. The specifier is built at runtime
 * because `dist/` does not exist when `pnpm typecheck` runs ahead of `pnpm build`.
 */
async function importServerBundle(): Promise<void> {
  await import(new URL('../../dist/server/index.js', import.meta.url).href);
}

// Only the `webServer` launch runs the CLI; importing this module from a test must not.
if (process.argv[1] !== undefined && canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url))) {
  await runSeedAndServeCli();
}
