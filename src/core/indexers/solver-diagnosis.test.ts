/**
 * The #2374 diagnosis: which component is broken when a solver round-trip fails. The classifier is
 * pure, so the AC1 verdict table is driven here cell-for-cell; the probe is exercised against a
 * stubbed transport so every AC12 transport code is asserted on the same fixture table the
 * classifier reads, which is what keeps the three places that code governs from drifting.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useMswServer } from '../__tests__/msw/server.js';
import { useSolverBound } from '../__tests__/solver-bound.js';
import type * as NetworkServiceModule from '../utils/network-service.js';

// Keep MSW/fetch spies on this test path while production retains dispatcher routing.
vi.mock('../utils/network-service.js', async (importActual) => {
  const actual = await importActual<typeof NetworkServiceModule>();
  return {
    ...actual,
    fetchWithOptionalDispatcher: ((url, options) => globalThis.fetch(url, options as RequestInit)) as typeof actual.fetchWithOptionalDispatcher,
  };
});

import {
  classifySolverFailure,
  describeSolverFailure,
  outcomeForTransportCode,
  probeReachable,
  probesNeededFor,
  type ProbeOutcome,
} from './solver-diagnosis.js';
import { markSolverFailure, SOLVER_FAILURE_ORIGINS, type SolverFailure } from './solver-failure.js';
import { MAPPED_TRANSPORT_CODES } from '../utils/map-network-error.js';
import { REACHABILITY_PROBE_TIMEOUT_MS } from '../utils/constants.js';

const HOST = 'audiobookbay.test';
const TARGET_URL = `https://${HOST}`;
const SOLVER_URL = 'http://flaresolverr.test:8191';
const SOLVER_ENDPOINT = `${SOLVER_URL}/v1`;
const PROXY_URL = 'http://proxy.test:8080';

const TIMED_OUT = 'FlareSolverr proxy timed out after 60s';
const SOLVER_SAID = 'FlareSolverr error: Challenge failed';

/**
 * The one fixture table AC12 governs, driven through all three places that read it: the target
 * probe, the solver liveness probe, and the transport code the round-trip's own throw retained.
 */
const TRANSPORT_CASES: Array<{ code: string | undefined; causeMessage: string; state: ProbeOutcome['state'] }> = [
  { code: 'ECONNREFUSED', causeMessage: 'connect ECONNREFUSED 10.0.0.5:8191', state: 'unreachable' },
  { code: 'ENOTFOUND', causeMessage: 'getaddrinfo ENOTFOUND missing.invalid', state: 'unreachable' },
  { code: 'ETIMEDOUT', causeMessage: 'connect ETIMEDOUT 10.0.0.5:8191', state: 'inconclusive' },
  { code: 'UND_ERR_CONNECT_TIMEOUT', causeMessage: 'Connect Timeout Error', state: 'inconclusive' },
  { code: 'UND_ERR_HEADERS_TIMEOUT', causeMessage: 'Headers Timeout Error', state: 'inconclusive' },
  { code: 'UND_ERR_BODY_TIMEOUT', causeMessage: 'Body Timeout Error', state: 'inconclusive' },
  { code: 'ECONNRESET', causeMessage: 'read ECONNRESET', state: 'inconclusive' },
  { code: 'EAI_AGAIN', causeMessage: 'getaddrinfo EAI_AGAIN solver.test', state: 'inconclusive' },
  { code: 'ENETUNREACH', causeMessage: 'connect ENETUNREACH 10.0.0.5:8191', state: 'inconclusive' },
  { code: undefined, causeMessage: 'socket hang up', state: 'inconclusive' },
];

function reachable(status = 200): ProbeOutcome {
  return { state: 'reachable', status };
}

function unreachable(code: 'ECONNREFUSED' | 'ENOTFOUND'): ProbeOutcome {
  return { state: 'unreachable', code };
}

function inconclusive(reason = 'ETIMEDOUT'): ProbeOutcome {
  return { state: 'inconclusive', reason };
}

function classify(
  failure: SolverFailure,
  originalMessage: string,
  probes: { targetProbe?: ProbeOutcome; solverProbe?: ProbeOutcome } = {},
) {
  return classifySolverFailure({
    failure,
    originalMessage,
    targetHost: HOST,
    solverAddress: SOLVER_ENDPOINT,
    ...probes,
  });
}

/** Rejects every fetch the way undici surfaces a real transport failure: wrapped, with a cause. */
function rejectTransport(code: string | undefined, causeMessage: string) {
  const cause = code === undefined
    ? new Error(causeMessage)
    : Object.assign(new Error(causeMessage), { code });
  return vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    Object.assign(new TypeError('fetch failed'), { cause }),
  );
}

/**
 * Intercepts only the probe's own deadline, so MSW's timers keep running for real. This works
 * because the probe hand-rolls `AbortController` + `setTimeout`: `AbortSignal.timeout` schedules on
 * a native timer a `setTimeout` spy cannot see (see `abortsignal-timeout-native-timer-retry-tests`).
 */
function captureProbeTimer() {
  const delays: number[] = [];
  const armed: number[] = [];
  const cleared: number[] = [];
  const handlers = new Map<number, () => void>();
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  let nextId = 1_000_000_000;

  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler, delay?: number, ...rest: unknown[]) => {
    delays.push(delay ?? 0);
    if (delay !== REACHABILITY_PROBE_TIMEOUT_MS) return nativeSetTimeout(handler as () => void, delay, ...rest);
    const id = nextId++;
    handlers.set(id, handler as () => void);
    armed.push(id);
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof globalThis.setTimeout);

  vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((handle?: unknown) => {
    if (typeof handle === 'number' && handlers.has(handle)) {
      handlers.delete(handle);
      cleared.push(handle);
      return;
    }
    nativeClearTimeout(handle as Parameters<typeof globalThis.clearTimeout>[0]);
  }) as typeof globalThis.clearTimeout);

  return {
    delays,
    armed,
    cleared,
    fire: () => {
      for (const [id, run] of [...handlers.entries()]) {
        handlers.delete(id);
        run();
      }
    },
  };
}

describe('solver diagnosis — transport code policy (AC12)', () => {
  it('attributes for exactly the two destination-semantic codes', () => {
    expect(outcomeForTransportCode('ECONNREFUSED')).toEqual({ state: 'unreachable', code: 'ECONNREFUSED' });
    expect(outcomeForTransportCode('ENOTFOUND')).toEqual({ state: 'unreachable', code: 'ENOTFOUND' });
  });

  it.each(TRANSPORT_CASES)('reads $code as $state', ({ code, state }) => {
    expect(outcomeForTransportCode(code).state).toBe(state);
  });

  /**
   * Iterates `mapNetworkError`'s own registry rather than a hand-copied list, so a code added
   * upstream reds here instead of silently inheriting a verdict (F12).
   */
  it('partitions every code mapNetworkError registers, so a new one cannot inherit a verdict', () => {
    const partition = Object.fromEntries(
      MAPPED_TRANSPORT_CODES.map((code) => [code, outcomeForTransportCode(code).state]),
    );
    expect(partition).toEqual({
      ECONNREFUSED: 'unreachable',
      ENOTFOUND: 'unreachable',
      UND_ERR_CONNECT_TIMEOUT: 'inconclusive',
      ETIMEDOUT: 'inconclusive',
      ECONNRESET: 'inconclusive',
      UND_ERR_HEADERS_TIMEOUT: 'inconclusive',
      UND_ERR_BODY_TIMEOUT: 'inconclusive',
      UND_ERR_RESPONSE_EXCEEDED_SIZE: 'inconclusive',
    });
  });
});

describe('solver diagnosis — which probes each arm needs (AC2, AC9)', () => {
  it.each([
    ['slot-wait', { target: false, solver: false }],
    ['solver-no-answer', { target: false, solver: false }],
    ['solver-answered', { target: true, solver: false }],
    ['round-trip-timeout', { target: true, solver: true }],
  ] as const)('%s', (origin, expected) => {
    expect(probesNeededFor({ origin })).toEqual(expected);
  });

  /**
   * Enumerates the real registry rather than the four cases above, so an arm added to `fetch.ts`
   * without a probe policy and a table row is visible here rather than inheriting a branch.
   */
  it('covers every arm the transport can throw from', () => {
    expect([...SOLVER_FAILURE_ORIGINS].sort()).toEqual(
      ['round-trip-timeout', 'slot-wait', 'solver-answered', 'solver-no-answer'],
    );
    for (const origin of SOLVER_FAILURE_ORIGINS) {
      expect(probesNeededFor({ origin })).toEqual(expect.objectContaining({ target: expect.any(Boolean), solver: expect.any(Boolean) }));
      const { verdict, message } = classify({ origin }, TIMED_OUT, { targetProbe: reachable(), solverProbe: reachable() });
      expect(['target', 'solver', 'no-page', 'inconclusive', 'undiagnosed']).toContain(verdict);
      expect(message.length).toBeGreaterThan(0);
    }
  });
});

describe('solver diagnosis — the AC1 verdict table', () => {
  it('keeps a slot-wait failure undiagnosed and verbatim (AC10)', () => {
    const slotWait = 'Timed out after 60s waiting for a request slot at solver http://flaresolverr.test:8191';
    const result = classify({ origin: 'slot-wait' }, slotWait);
    expect(result).toEqual({ verdict: 'undiagnosed', message: slotWait });
  });

  describe('solver-no-answer — the retained cause is the only evidence', () => {
    it.each(TRANSPORT_CASES)('$code yields the $state verdict arm', ({ code, state }) => {
      const result = classify(
        { origin: 'solver-no-answer', ...(code !== undefined && { transportCode: code }) },
        `FlareSolverr proxy unreachable at ${SOLVER_URL}`,
      );
      expect(result.verdict).toBe(state === 'unreachable' ? 'solver' : 'inconclusive');
    });

    it('names the solver address and nothing about the target when the solver refused', () => {
      const result = classify({ origin: 'solver-no-answer', transportCode: 'ECONNREFUSED' }, 'FlareSolverr proxy unreachable at x');
      expect(result.message).toBe(`Solver unreachable: ${SOLVER_ENDPOINT} refused the connection (ECONNREFUSED).`);
      expect(result.message).not.toContain(HOST);
    });

    it('says why no probe was run when the code is equally consistent with a local fault', () => {
      const result = classify({ origin: 'solver-no-answer', transportCode: 'EAI_AGAIN' }, TIMED_OUT);
      expect(result.message).toContain('No probe was run: transport code EAI_AGAIN');
    });

    it('says so when the failure carried no code at all', () => {
      const result = classify({ origin: 'solver-no-answer' }, TIMED_OUT);
      expect(result.message).toContain('No probe was run: the failure carried no transport code');
    });
  });

  describe('solver-answered — something answered, so the target probe decides', () => {
    it.each([
      ['unreachable', unreachable('ECONNREFUSED'), 'target'],
      ['reachable', reachable(), 'no-page'],
      ['inconclusive', inconclusive(), 'inconclusive'],
    ] as const)('target probe %s → %s', (_label, targetProbe, verdict) => {
      expect(classify({ origin: 'solver-answered' }, SOLVER_SAID, { targetProbe }).verdict).toBe(verdict);
    });

    it('never produces the Solver verdict, whatever the target probe saw', () => {
      for (const targetProbe of [unreachable('ECONNREFUSED'), unreachable('ENOTFOUND'), reachable(403), inconclusive()]) {
        expect(classify({ origin: 'solver-answered' }, SOLVER_SAID, { targetProbe }).verdict).not.toBe('solver');
      }
    });

    it("quotes the solver's own words in the No-page message", () => {
      const result = classify({ origin: 'solver-answered' }, SOLVER_SAID, { targetProbe: reachable() });
      expect(result.message).toContain(`"${SOLVER_SAID}"`);
    });
  });

  describe('round-trip-timeout — no retained evidence, so both probes decide', () => {
    const CELLS: Array<[ProbeOutcome, ProbeOutcome, string]> = [
      [unreachable('ECONNREFUSED'), reachable(), 'target'],
      [unreachable('ECONNREFUSED'), unreachable('ECONNREFUSED'), 'target'],
      [unreachable('ENOTFOUND'), inconclusive(), 'target'],
      [reachable(), unreachable('ECONNREFUSED'), 'solver'],
      [reachable(), unreachable('ENOTFOUND'), 'solver'],
      [reachable(), reachable(405), 'no-page'],
      [reachable(), inconclusive(), 'inconclusive'],
      [inconclusive(), reachable(), 'inconclusive'],
      [inconclusive(), unreachable('ECONNREFUSED'), 'inconclusive'],
      [inconclusive(), inconclusive(), 'inconclusive'],
    ];

    it.each(CELLS)('target %o + solver %o', (targetProbe, solverProbe, verdict) => {
      expect(classify({ origin: 'round-trip-timeout' }, TIMED_OUT, { targetProbe, solverProbe }).verdict).toBe(verdict);
    });

    it('covers the whole cross-product, so a new probe outcome cannot slip in untested', () => {
      const outcomes = [unreachable('ECONNREFUSED'), reachable(), inconclusive()];
      const covered = new Set(CELLS.map(([target, solver]) => `${target.state}/${solver.state}`));
      for (const target of outcomes) {
        for (const solver of outcomes) {
          expect(covered.has(`${target.state}/${solver.state}`)).toBe(true);
        }
      }
    });

    it('reports a refusing solver as Solver while noting the target answered', () => {
      const result = classify({ origin: 'round-trip-timeout' }, TIMED_OUT, {
        targetProbe: reachable(200),
        solverProbe: unreachable('ECONNREFUSED'),
      });
      expect(result.message).toBe(
        `Solver unreachable: ${SOLVER_ENDPOINT} refused the connection (ECONNREFUSED). ${HOST} answered a direct probe (HTTP 200).`,
      );
    });

    it('a blackholing solver makes the probe inconclusive, not Solver', () => {
      const result = classify({ origin: 'round-trip-timeout' }, TIMED_OUT, {
        targetProbe: reachable(),
        solverProbe: inconclusive('ETIMEDOUT'),
      });
      expect(result.verdict).toBe('inconclusive');
    });
  });

  describe('the Target verdict', () => {
    it('says refused, not timed out, and names the host (AC4)', () => {
      const result = classify({ origin: 'round-trip-timeout' }, TIMED_OUT, {
        targetProbe: unreachable('ECONNREFUSED'),
        solverProbe: reachable(),
      });
      expect(result.message).toBe(
        `Target unreachable: ${HOST} refused the connection (ECONNREFUSED). Probed directly, not through the solver.`,
      );
      expect(result.message).not.toMatch(/timed out/i);
    });

    it('says the name did not resolve for ENOTFOUND', () => {
      const result = classify({ origin: 'solver-answered' }, SOLVER_SAID, { targetProbe: unreachable('ENOTFOUND') });
      expect(result.message).toContain(`${HOST} did not resolve (ENOTFOUND)`);
    });

    it('does not attribute anything to the solver', () => {
      const result = classify({ origin: 'solver-answered' }, SOLVER_SAID, { targetProbe: unreachable('ECONNREFUSED') });
      expect(result.message).not.toContain(SOLVER_ENDPOINT);
    });
  });

  /** AC17 — the No-page verdict is an observation, never a finding of solver health. */
  describe('the No-page verdict never exonerates the solver', () => {
    const EXONERATION = /\b(up|healthy|working|fine|operational|alive|ok|exonerated)\b/i;

    it.each([
      ['solver-answered', classify({ origin: 'solver-answered' }, SOLVER_SAID, { targetProbe: reachable() })],
      ['round-trip-timeout', classify({ origin: 'round-trip-timeout' }, TIMED_OUT, { targetProbe: reachable(), solverProbe: reachable(405) })],
    ] as const)('%s route', (_label, result) => {
      expect(result.verdict).toBe('no-page');
      expect(result.message).not.toMatch(EXONERATION);
      expect(result.message).toContain(HOST);
      expect(result.message).toContain(SOLVER_ENDPOINT);
      expect(result.message).toContain('remain possible causes — neither has been ruled out');
    });

    it('shares one class marker across both arms while the evidence differs', () => {
      const answered = classify({ origin: 'solver-answered' }, SOLVER_SAID, { targetProbe: reachable() });
      const timedOut = classify({ origin: 'round-trip-timeout' }, TIMED_OUT, { targetProbe: reachable(), solverProbe: reachable(405) });
      expect(answered.message.startsWith('No page came back.')).toBe(true);
      expect(timedOut.message.startsWith('No page came back.')).toBe(true);
      expect(answered.message).not.toBe(timedOut.message);
    });
  });

  /**
   * AC6/AC1 — the one place a component name legitimately appears inside a verdict that blames
   * nobody, pinned whole so the two requirements are visible together rather than inferred.
   */
  describe('the Inconclusive verdict quotes today\'s error without attributing it', () => {
    it('pins the round-trip-timeout message exactly', () => {
      const result = classify({ origin: 'round-trip-timeout' }, TIMED_OUT, {
        targetProbe: inconclusive('ETIMEDOUT'),
        solverProbe: inconclusive('ETIMEDOUT'),
      });
      expect(result.message).toBe(
        `Could not determine which component failed: "${TIMED_OUT}". That names the solver only as the source of the report, not as the component at fault — no component is blamed and none is ruled out. Direct probe of ${HOST}: inconclusive (ETIMEDOUT). Direct probe of ${SOLVER_ENDPOINT}: inconclusive (ETIMEDOUT).`,
      );
      expect(result.message).toContain(TIMED_OUT);
    });

    it('pins the solver-answered message exactly', () => {
      const result = classify({ origin: 'solver-answered' }, SOLVER_SAID, { targetProbe: inconclusive('EAI_AGAIN') });
      expect(result.message).toBe(
        `Could not determine which component failed: "${SOLVER_SAID}". That names the solver only as the source of the report, not as the component at fault — no component is blamed and none is ruled out. Direct probe of ${HOST}: inconclusive (EAI_AGAIN).`,
      );
    });
  });

  it('keeps the four verdict classes mutually distinguishable from their messages', () => {
    const messages = {
      target: classify({ origin: 'solver-answered' }, SOLVER_SAID, { targetProbe: unreachable('ECONNREFUSED') }).message,
      solver: classify({ origin: 'solver-no-answer', transportCode: 'ECONNREFUSED' }, TIMED_OUT).message,
      'no-page': classify({ origin: 'solver-answered' }, SOLVER_SAID, { targetProbe: reachable() }).message,
      inconclusive: classify({ origin: 'solver-answered' }, SOLVER_SAID, { targetProbe: inconclusive() }).message,
    };
    expect(new Set(Object.values(messages)).size).toBe(4);
    expect(messages.target).toMatch(/^Target unreachable: /);
    expect(messages.solver).toMatch(/^Solver unreachable: /);
    expect(messages['no-page']).toMatch(/^No page came back\./);
    expect(messages.inconclusive).toMatch(/^Could not determine which component failed: /);
  });

  it('falls back to Inconclusive when a probe the table requires is missing', () => {
    expect(classify({ origin: 'solver-answered' }, SOLVER_SAID).verdict).toBe('inconclusive');
    expect(classify({ origin: 'round-trip-timeout' }, TIMED_OUT, { targetProbe: reachable() }).verdict).toBe('inconclusive');
  });
});

describe('solver diagnosis — the probe primitive (AC5, AC13, AC16)', () => {
  const server = useMswServer();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([200, 403, 503, 405, 429])('reads any direct HTTP response (%i) as reachable', async (status) => {
    server.use(http.head(TARGET_URL, () => new HttpResponse(null, { status })));
    await expect(probeReachable(TARGET_URL)).resolves.toEqual({ state: 'reachable', status });
  });

  it('reads a 200 challenge interstitial as reachable — the probe asks only what is listening', async () => {
    server.use(http.head(TARGET_URL, () => new HttpResponse(null, { status: 200 })));
    await expect(probeReachable(TARGET_URL)).resolves.toEqual({ state: 'reachable', status: 200 });
  });

  it.each(TRANSPORT_CASES)('maps a direct $code rejection to $state', async ({ code, causeMessage, state }) => {
    rejectTransport(code, causeMessage);
    const outcome = await probeReachable(TARGET_URL);
    expect(outcome.state).toBe(state);
    if (outcome.state === 'unreachable') expect(outcome.code).toBe(code);
  });

  it('gives the same outcome for every code on the solver address as on the target (cross-side symmetry)', async () => {
    for (const { code, causeMessage, state } of TRANSPORT_CASES) {
      const spy = rejectTransport(code, causeMessage);
      const target = await probeReachable(TARGET_URL);
      const solver = await probeReachable(SOLVER_ENDPOINT);
      expect(target).toEqual(solver);
      expect(target.state).toBe(state);
      spy.mockRestore();
    }
  });

  it('returns inconclusive rather than rejecting when the transport throws outright (AC16)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('transport exploded'); });
    await expect(probeReachable(TARGET_URL)).resolves.toMatchObject({ state: 'inconclusive' });
  });

  it('reads its own expiring deadline as inconclusive, never unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      (init as RequestInit).signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const witness = captureProbeTimer();

    const pending = probeReachable(TARGET_URL);
    await vi.waitFor(() => expect(witness.armed).toHaveLength(1));
    witness.fire();

    await expect(pending).resolves.toEqual({ state: 'inconclusive', reason: 'ETIMEDOUT' });
    expect(witness.delays).toContain(REACHABILITY_PROBE_TIMEOUT_MS);
  });

  it('arms its own deadline with the shared constant and clears it on the resolve path', async () => {
    server.use(http.head(TARGET_URL, () => new HttpResponse(null, { status: 200 })));
    const witness = captureProbeTimer();

    await probeReachable(TARGET_URL);

    expect(witness.armed).toHaveLength(1);
    expect(witness.cleared).toEqual(witness.armed);
  });

  it('clears its deadline on the reject path too', async () => {
    rejectTransport('ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.5:443');
    const witness = captureProbeTimer();

    await probeReachable(TARGET_URL);

    expect(witness.armed).toHaveLength(1);
    expect(witness.cleared).toEqual(witness.armed);
  });

  describe('through a configured standard proxy (AC13)', () => {
    it.each(TRANSPORT_CASES.filter((entry) => entry.state === 'unreachable'))(
      'never reports unreachable for $code, because the dispatcher erases transport identity',
      async ({ code, causeMessage }) => {
        rejectTransport(code, causeMessage);
        await expect(probeReachable(TARGET_URL, { proxyUrl: PROXY_URL })).resolves.toMatchObject({ state: 'inconclusive' });
      },
    );

    it.each([407, 502, 503])('reads an origin-ambiguous %i through the dispatcher as inconclusive', async (status) => {
      server.use(http.head(TARGET_URL, () => new HttpResponse(null, { status })));
      await expect(probeReachable(TARGET_URL, { proxyUrl: PROXY_URL })).resolves.toMatchObject({ state: 'inconclusive' });
    });

    it('gives the same verdict to a target-generated and a proxy-generated 503 (F7)', async () => {
      server.use(http.head(TARGET_URL, () => new HttpResponse(null, { status: 503, headers: { 'X-Fixture-Origin': 'target' } })));
      const fromTarget = await probeReachable(TARGET_URL, { proxyUrl: PROXY_URL });
      server.resetHandlers();
      server.use(http.head(TARGET_URL, () => new HttpResponse(null, { status: 503, headers: { 'X-Fixture-Origin': 'proxy' } })));
      const fromProxy = await probeReachable(TARGET_URL, { proxyUrl: PROXY_URL });
      expect(fromTarget).toEqual(fromProxy);
      expect(fromTarget.state).toBe('inconclusive');
    });

    it('still reads a 403 through the dispatcher as reachable', async () => {
      server.use(http.head(TARGET_URL, () => new HttpResponse(null, { status: 403 })));
      await expect(probeReachable(TARGET_URL, { proxyUrl: PROXY_URL })).resolves.toEqual({ state: 'reachable', status: 403 });
    });

    it('control: the same 503 with no proxy configured is reachable', async () => {
      server.use(http.head(TARGET_URL, () => new HttpResponse(null, { status: 503 })));
      await expect(probeReachable(TARGET_URL)).resolves.toEqual({ state: 'reachable', status: 503 });
    });

    it('passes the dispatcher when a proxy is configured and omits it otherwise', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
      await probeReachable(TARGET_URL, { proxyUrl: PROXY_URL });
      await probeReachable(SOLVER_ENDPOINT);
      const [proxied, direct] = fetchSpy.mock.calls;
      expect((proxied![1] as Record<string, unknown>).dispatcher).toBeDefined();
      expect((direct![1] as Record<string, unknown>).dispatcher).toBeUndefined();
      expect((proxied![1] as RequestInit).method).toBe('HEAD');
    });

    it('reports inconclusive rather than throwing for an unparseable proxy URL', async () => {
      await expect(probeReachable(TARGET_URL, { proxyUrl: 'not a url' })).resolves.toMatchObject({ state: 'inconclusive' });
    });
  });
});

describe('describeSolverFailure — orchestration (AC3, AC9, AC10)', () => {
  const server = useMswServer();
  const context = { targetProbeUrl: TARGET_URL, targetHost: HOST, solverUrl: SOLVER_URL };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns an unmarked error verbatim and issues no probe', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const message = await describeSolverFailure(new Error('Invalid RSS response: missing <rss> or <channel> element'), context);
    expect(message).toBe('Invalid RSS response: missing <rss> or <channel> element');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns a slot-wait failure verbatim and issues no probe (AC10)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const slotWait = markSolverFailure(new Error('Timed out after 60s waiting for a request slot at solver x'), 'slot-wait');
    await expect(describeSolverFailure(slotWait, context)).resolves.toBe(slotWait.message);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('runs no probe on the solver-no-answer arm, whatever the cause (AC2)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const error = markSolverFailure(new Error(`FlareSolverr proxy unreachable at ${SOLVER_URL}`), 'solver-no-answer', 'ECONNREFUSED');
    const message = await describeSolverFailure(error, context);
    expect(message).toContain(`Solver unreachable: ${SOLVER_ENDPOINT}`);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('probes only the target on a solver-answered arm', async () => {
    const probed: string[] = [];
    server.use(
      http.head(TARGET_URL, ({ request }) => { probed.push(request.url); return new HttpResponse(null, { status: 200 }); }),
      http.head(SOLVER_ENDPOINT, ({ request }) => { probed.push(request.url); return new HttpResponse(null, { status: 405 }); }),
    );
    const error = markSolverFailure(new Error(SOLVER_SAID), 'solver-answered');
    const message = await describeSolverFailure(error, context);
    expect(message).toMatch(/^No page came back\./);
    expect(probed).toEqual([`${TARGET_URL}/`]);
  });

  it('runs both probes concurrently on the timeout arm, so the pair costs one budget (AC3)', async () => {
    let inFlight = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const park = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => release.push(resolve));
      inFlight--;
      return new HttpResponse(null, { status: 200 });
    };
    server.use(http.head(TARGET_URL, park), http.head(SOLVER_ENDPOINT, park));

    const error = markSolverFailure(new Error(TIMED_OUT), 'round-trip-timeout');
    const pending = describeSolverFailure(error, context);
    await vi.waitFor(() => expect(release).toHaveLength(2));
    expect(peak).toBe(2);
    for (const open of release) open();

    await expect(pending).resolves.toMatch(/^No page came back\./);
  });

  it('takes the target probe through the standard proxy but the solver probe directly (AC13)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    const error = markSolverFailure(new Error(TIMED_OUT), 'round-trip-timeout');
    await describeSolverFailure(error, { ...context, proxyUrl: PROXY_URL });

    const byUrl = new Map(fetchSpy.mock.calls.map((call) => [String(call[0]), call[1] as Record<string, unknown>]));
    expect(byUrl.get(TARGET_URL)?.dispatcher).toBeDefined();
    expect(byUrl.get(SOLVER_ENDPOINT)?.dispatcher).toBeUndefined();
  });

  it('degrades to the verbatim error plus a could-not-determine statement when every probe fails (AC6)', async () => {
    rejectTransport('EAI_AGAIN', 'getaddrinfo EAI_AGAIN audiobookbay.test');
    const error = markSolverFailure(new Error(TIMED_OUT), 'round-trip-timeout');
    const message = await describeSolverFailure(error, context);
    expect(message).toContain(TIMED_OUT);
    expect(message).toContain('Could not determine which component failed');
  });
});

/**
 * AC14 — a diagnosis must not be able to queue behind the very traffic it is diagnosing. Neither
 * probe goes through `fetchWithProxy`, so neither enters `acquireSolverSlot`; if one did, this test
 * would hang rather than fail, which is exactly why the pool is held saturated for its duration.
 */
describe('describeSolverFailure — neither probe consumes a solver slot', () => {
  const server = useMswServer();
  const bound = useSolverBound(server);

  it('completes both probes while every solver slot is held by in-flight searches', async () => {
    const stub = bound.stub(SOLVER_ENDPOINT);
    await bound.saturate(stub, SOLVER_URL);

    const probed: string[] = [];
    server.use(
      http.head(TARGET_URL, () => { probed.push('target'); return new HttpResponse(null, { status: 200 }); }),
      http.head(SOLVER_ENDPOINT, () => { probed.push('solver'); return new HttpResponse(null, { status: 405 }); }),
    );

    const error = markSolverFailure(new Error(TIMED_OUT), 'round-trip-timeout');
    const message = await describeSolverFailure(error, {
      targetProbeUrl: TARGET_URL,
      targetHost: HOST,
      solverUrl: SOLVER_URL,
    });

    expect([...probed].sort()).toEqual(['solver', 'target']);
    expect(message).toMatch(/^No page came back\./);
    // The saturating searches are still parked: the probes neither displaced nor waited on them.
    expect(stub.observed).toBe(bound.max);
  });
});
