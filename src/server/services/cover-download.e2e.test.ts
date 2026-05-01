import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, LookupFunction } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import type { FastifyBaseLogger } from 'fastify';
import { inject } from '../__tests__/helpers.js';
import type { Db } from '../../db/index.js';

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../utils/blocked-fetch-address.js', async (importActual) => {
  const actual = await importActual<typeof import('../utils/blocked-fetch-address.js')>();
  return { ...actual, createSsrfSafeDispatcher: vi.fn(), resolveAndValidate: vi.fn() };
});

import { createSsrfSafeDispatcher, resolveAndValidate } from '../utils/blocked-fetch-address.js';
import { downloadRemoteCover } from './cover-download.js';

function createMockLogger() {
  return inject<FastifyBaseLogger>({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    silent: vi.fn(),
    level: 'info',
  });
}

function createMockDb() {
  return {
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  };
}

type LookupBehavior = (
  opts: Parameters<LookupFunction>[1],
  cb: Parameters<LookupFunction>[2],
) => void;

const successBehavior = (address: string, family: 4 | 6 = 4): LookupBehavior =>
  (opts, cb) => {
    if (opts && (opts as { all?: boolean }).all) {
      (cb as unknown as (err: NodeJS.ErrnoException | null, addresses: { address: string; family: number }[]) => void)(
        null,
        [{ address, family }],
      );
    } else {
      cb(null, address, family);
    }
  };

const rejectBehavior = (message: string): LookupBehavior =>
  (_opts, cb) => cb(new Error(message) as NodeJS.ErrnoException, '', 0);

describe('downloadRemoteCover (real-HTTP e2e — DNS rebinding revalidation)', () => {
  let server: Server;
  let port: number;
  let requestCount: number;
  let serverHandler: (req: IncomingMessage, res: ServerResponse) => void;
  let mockDb: ReturnType<typeof createMockDb>;
  let log: FastifyBaseLogger;
  let lookupCalls: string[];
  let lookupBehaviors: LookupBehavior[];

  beforeAll(() => {
    // Node 24's bundled fetch rejects externally-constructed undici@8.1.0 Agents
    // before lookup runs. Routing globalThis.fetch through undici's own fetch
    // (same package version as the test Agent) eliminates that mismatch — real
    // HTTP transport is still used.
    vi.stubGlobal('fetch', undiciFetch);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    requestCount = 0;
    lookupCalls = [];
    lookupBehaviors = [];

    server = createServer((req, res) => serverHandler(req, res));
    await new Promise<void>((resolve) => server.listen({ port: 0, host: '127.0.0.1' }, resolve));
    port = (server.address() as AddressInfo).port;

    const testLookup: LookupFunction = (hostname, opts, cb) => {
      lookupCalls.push(hostname);
      const behavior = lookupBehaviors.shift();
      if (!behavior) {
        throw new Error(
          `Test lookup ran out of behaviors at call ${lookupCalls.length} for ${hostname}`,
        );
      }
      behavior(opts, cb);
    };
    const testAgent = new Agent({ connect: { lookup: testLookup } });
    vi.mocked(createSsrfSafeDispatcher).mockReturnValue(testAgent);

    mockDb = createMockDb();
    log = createMockLogger();
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    vi.clearAllMocks();
  });

  it('rejects rebinding redirect: hop 2 dispatcher lookup refuses, downloadRemoteCover returns false', async () => {
    serverHandler = (_req, res) => {
      requestCount += 1;
      res.writeHead(302, { Location: `http://rebind.test:${port}/cover.jpg` });
      res.end();
    };

    vi.mocked(resolveAndValidate)
      .mockResolvedValueOnce(['127.0.0.1'])
      .mockResolvedValueOnce(['93.184.216.34']);

    lookupBehaviors.push(
      successBehavior('127.0.0.1', 4),
      rejectBehavior('Refused: hostname rebind.test resolves to blocked address 192.168.1.1'),
    );

    const result = await downloadRemoteCover(
      1,
      '/tmp/book',
      `http://origin.test:${port}/cover.jpg`,
      inject<Db>(mockDb),
      log,
    );

    expect(result).toBe(false);
    expect(lookupCalls).toEqual(['origin.test', 'rebind.test']);
    expect(requestCount).toBe(1);
    expect(vi.mocked(resolveAndValidate)).toHaveBeenCalledTimes(2);
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          message: 'fetch failed',
          cause: expect.objectContaining({
            message: expect.stringMatching(/Refused.*resolves to blocked address/),
          }),
        }),
      }),
      expect.any(String),
    );
  });

  it('successful redirect baseline: both hops connect, cover saves, db updates', async () => {
    serverHandler = (_req, res) => {
      requestCount += 1;
      if (requestCount === 1) {
        res.writeHead(302, { Location: `http://allowed.test:${port}/cover.jpg` });
        res.end();
        return;
      }
      const body = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': String(body.byteLength),
      });
      res.end(body);
    };

    vi.mocked(resolveAndValidate)
      .mockResolvedValueOnce(['127.0.0.1'])
      .mockResolvedValueOnce(['127.0.0.1']);

    lookupBehaviors.push(
      successBehavior('127.0.0.1', 4),
      successBehavior('127.0.0.1', 4),
    );

    const result = await downloadRemoteCover(
      1,
      '/tmp/book',
      `http://origin.test:${port}/cover.jpg`,
      inject<Db>(mockDb),
      log,
    );

    expect(result).toBe(true);
    expect(lookupCalls).toEqual(['origin.test', 'allowed.test']);
    expect(requestCount).toBe(2);
    expect(mockDb.update).toHaveBeenCalledOnce();
  });
});
