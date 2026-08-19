import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalPath } from '../../src/server/utils/path-identity.js';
import { createMAMFake, type MAMFakeHandle } from './mam.js';
import { createQBitFake, type QBitFakeHandle } from './qbit.js';
import { createAudibleFake, type AudibleFakeHandle } from './audible.js';
import { E2E_DEFAULT_PORTS, resolvePort } from '../fixtures/ports.js';
import { SEED_SEARCH_QUERY } from '../fixtures/seed.js';

/**
 * Hosts all three fakes as the FIRST `webServer` entry, because Playwright starts `webServer`
 * processes before `globalSetup` and sets each entry up sequentially, awaiting readiness before
 * the next spawns — so fakes started in `globalSetup` lose a race against the app servers' first
 * cron ticks, and a lost race opens the indexer breaker for ~60s (#2474). MAM binds LAST: the
 * config's readiness check watches its port, so "MAM is up" implies all three are up. Playwright
 * owns this process's lifetime; the listeners die with it, so there is no explicit teardown.
 */

export interface FakesHostInputs {
  mamPort: number;
  qbitPort: number;
  audiblePort: number;
  /** The ROOT run's downloads dir — the qBit fake stages its completed download here. */
  downloadsPath: string;
}

export interface FakesHostHandles {
  mam: MAMFakeHandle;
  qbit: QBitFakeHandle;
  audible: AudibleFakeHandle;
  close: () => Promise<void>;
}

export interface FakesHostCliHooks {
  env?: NodeJS.ProcessEnv;
  exit?: (code: number) => void;
  writeStderr?: (message: string) => void;
  writeStdout?: (message: string) => void;
}

/** Derives every input from the entry's own env — nothing here depends on globalSetup. */
export function readFakesHostInputs(env: NodeJS.ProcessEnv): FakesHostInputs {
  const downloadsPath = env.E2E_DOWNLOADS_PATH?.trim();
  if (!downloadsPath) {
    throw new Error('fakes-host: E2E_DOWNLOADS_PATH is unset or empty, so the qBit fake has nowhere to stage downloads');
  }
  return {
    mamPort: resolvePort('E2E_MAM_PORT', E2E_DEFAULT_PORTS.mam, env),
    qbitPort: resolvePort('E2E_QBIT_PORT', E2E_DEFAULT_PORTS.qbit, env),
    audiblePort: resolvePort('E2E_AUDIBLE_PORT', E2E_DEFAULT_PORTS.audible, env),
    downloadsPath,
  };
}

/** Binds Audible, then qBit, then MAM (readiness sentinel — keep it last), and seeds MAM's fixture. */
export async function startFakesHost(inputs: FakesHostInputs): Promise<FakesHostHandles> {
  // Module-relative resolution works for both tsx and compiled invocations.
  const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'silent.m4b');

  const audible = await createAudibleFake({ port: inputs.audiblePort });
  const qbit = await createQBitFake({
    port: inputs.qbitPort,
    downloadsPath: inputs.downloadsPath,
    fixturePath,
    // Keep the mutation pending long enough for React to render the disabled button.
    addLatencyMs: 150,
  });
  const mam = await createMAMFake({
    port: inputs.mamPort,
    expectedCookie: 'test-mam-id',
    torrentFileName: 'e2e-test-book',
    torrentFileLength: 4297,
  });

  mam.seedResults(SEED_SEARCH_QUERY, [
    {
      id: 42,
      title: 'E2E Test Book [Unabridged]',
      author: 'E2E Test Author',
      narrator: 'E2E Test Narrator',
      // Use ISO `en`; numeric `1` is not normalized and fails default language filtering.
      langCode: 'en',
      size: '200.0 MiB',
      seeders: 15,
      leechers: 0,
      isFreeleech: true,
    },
  ]);

  const close = async (): Promise<void> => {
    await Promise.allSettled([mam.close(), qbit.close(), audible.close()]);
  };
  return { mam, qbit, audible, close };
}

/**
 * Starts the host and keeps the process alive on its listeners; failure exits non-zero. Returns
 * the handles so tests can close the listeners — a dangling fastify server at worker exit is the
 * known teardown-crash shape. The production launch ignores the return; Playwright owns the PID.
 */
export async function runFakesHostCli(hooks: FakesHostCliHooks = {}): Promise<FakesHostHandles | undefined> {
  const {
    env = process.env,
    exit = (code: number): void => { process.exit(code); },
    writeStderr = (message: string): void => { process.stderr.write(message); },
    writeStdout = (message: string): void => { process.stdout.write(message); },
  } = hooks;

  try {
    const inputs = readFakesHostInputs(env);
    const handles = await startFakesHost(inputs);
    writeStdout(
      `[fakes-host] listening — audible:${inputs.audiblePort} qbit:${inputs.qbitPort} mam:${inputs.mamPort}\n`,
    );
    return handles;
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    writeStderr(`[fakes-host] refusing to start: ${reason}\n`);
    exit(1);
    return undefined;
  }
}

// Only the `webServer` launch runs the CLI; importing this module from a test must not.
if (process.argv[1] !== undefined && canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url))) {
  await runFakesHostCli();
}
