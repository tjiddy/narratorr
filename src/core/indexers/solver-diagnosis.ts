/**
 * Which component is broken when a solver round-trip fails: the target site, the solver, or neither
 * identifiable (#2374). Two halves — an impure reachability probe, and a pure classifier that maps
 * (failure arm × probe outcomes) to one operator verdict. All three solver-capable adapters share
 * both, so a verdict cannot drift per adapter.
 *
 * The verdict is an EVIDENCE REPORT, not a causal guess: it states what was observed and attributes
 * blame only where the observation admits exactly one reading. Mentioning a component is not
 * attributing to it — every verdict may quote the raw `FlareSolverr …` string, which names the
 * solver as the source of the observation, without asserting the solver is at fault. "The solver is
 * fine" is an attribution too, and is equally forbidden where the evidence does not entail it.
 */

import { getErrorMessage } from '@shared/error-message.js';
import { REACHABILITY_PROBE_TIMEOUT_MS } from '../utils/constants.js';
import { mapNetworkError } from '../utils/map-network-error.js';
import { fetchWithOptionalDispatcher, type DispatcherFetchInit } from '../utils/network-service.js';
import { createProxyAgent } from './proxy.js';
import { solverEndpoint } from './solver-endpoint.js';
import { solverFailureOf, transportCodeOf, type SolverFailure } from './solver-failure.js';

/**
 * A transport code may implicate the address it was raised against only when it is an answer *from*
 * or *about* that address: `ECONNREFUSED` is an RST in reply to a SYN, `ENOTFOUND` is NXDOMAIN.
 * Everything else — every timeout code, `ECONNRESET`, `EAI_AGAIN`, anything unrecognised — is the
 * ABSENCE of an answer, equally explicable by our own egress, a firewall dropping packets, or the
 * probe's own deadline (`mapNetworkError` synthesises `ETIMEDOUT` for any abort, ours included). A
 * closed allowlist, not an enumeration of what happened to break: adding to it means showing the
 * code satisfies that rule, with its own test.
 */
const ATTRIBUTING_CODES = ['ECONNREFUSED', 'ENOTFOUND'] as const;
export type AttributingCode = typeof ATTRIBUTING_CODES[number];

/**
 * Statuses a dispatcher makes origin-blind. `fetchWithOptionalDispatcher` returns a bare `Response`
 * carrying status but no hop-of-origin metadata, so a target-generated 503 and a proxy-generated 503
 * are the SAME observation and must get the same verdict.
 */
const ORIGIN_AMBIGUOUS_PROXY_STATUSES = [407, 502, 503];

/**
 * What a direct probe of one address saw. `reachable` means an HTTP listener answered — nothing
 * more, and never that the component can do its job. `unreachable` is reserved for the two
 * destination-semantic codes; the probe's own deadline expiring is `inconclusive`, since that says
 * only that our budget elapsed.
 */
export type ProbeOutcome =
  | { state: 'reachable'; status: number }
  | { state: 'unreachable'; code: AttributingCode }
  | { state: 'inconclusive'; reason: string };

const PROBE_NOT_RUN: ProbeOutcome = { state: 'inconclusive', reason: 'probe not run' };

/**
 * The one place the attribution allowlist is expressed. Three callers read it — the target probe,
 * the solver liveness probe, and the transport code the round-trip's own throw retained — and a code
 * that is inconclusive for one cannot be attributing for another.
 */
export function outcomeForTransportCode(code: string | undefined): ProbeOutcome {
  if (code !== undefined && (ATTRIBUTING_CODES as readonly string[]).includes(code)) {
    return { state: 'unreachable', code: code as AttributingCode };
  }
  return { state: 'inconclusive', reason: code ?? 'no transport code' };
}

/**
 * Is anything listening at `url`? A cheap HEAD, bounded by its own short deadline, never routed
 * through the solver — a probe that went through the component under suspicion could not
 * distinguish the cases and would reproduce the defect this exists to fix.
 *
 * Total by contract: it returns a three-state outcome and never propagates an exception, which is
 * what keeps the classifier pure and stops a probe failure from turning a working indexer red.
 *
 * Deliberately not `fetchWithProxyAgent`: that helper wraps every dispatcher-path throw in a
 * code-less `ProxyError`, discarding the transport identity the allowlist reads.
 */
export async function probeReachable(
  url: string,
  options: { proxyUrl?: string | undefined } = {},
): Promise<ProbeOutcome> {
  let dispatcher: ReturnType<typeof createProxyAgent>;
  try {
    dispatcher = createProxyAgent(options.proxyUrl, url);
  } catch (error: unknown) {
    return { state: 'inconclusive', reason: getErrorMessage(error) };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REACHABILITY_PROBE_TIMEOUT_MS);
  try {
    const init: DispatcherFetchInit = {
      method: 'HEAD',
      signal: controller.signal,
      ...(dispatcher !== undefined && { dispatcher }),
    };
    const response = await fetchWithOptionalDispatcher(url, init);
    if (dispatcher && ORIGIN_AMBIGUOUS_PROXY_STATUSES.includes(response.status)) {
      return { state: 'inconclusive', reason: `HTTP ${response.status} through the configured proxy` };
    }
    return { state: 'reachable', status: response.status };
  } catch (error: unknown) {
    // With a dispatcher the transport identity is gone by construction, so nothing here can attribute.
    if (dispatcher) return { state: 'inconclusive', reason: 'transport failure through the configured proxy' };
    return outcomeForTransportCode(transportCodeOf(mapNetworkError(error)));
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Which probes an arm's own evidence leaves unanswered. A `solver-answered` arm already proves
 * something answered at the solver address, and a `solver-no-answer` arm already carries a transport
 * code; only the round-trip timeout retains nothing at all, so only it needs both.
 *
 * The single decision point, deliberately: the delivered-status case is decided HERE rather than by
 * a short-circuit at the call site, so the pure function cannot advertise a probe requirement
 * production does not honour. The status is consulted only in the `solver-answered` arm — no other
 * arm can carry one, and none of them may start reading it.
 */
export function probesNeededFor(failure: SolverFailure): { target: boolean; solver: boolean } {
  switch (failure.origin) {
    case 'solver-answered':
      // A delivered status came from the target, through the solver: the observation a target probe
      // exists to make has already been made, so making it again can only muddy the verdict (#2483).
      return { target: failure.httpStatus === undefined, solver: false };
    case 'round-trip-timeout':
      return { target: true, solver: true };
    default:
      return { target: false, solver: false };
  }
}

export type SolverVerdict = 'target' | 'solver' | 'no-page' | 'inconclusive' | 'undiagnosed';

export interface SolverDiagnosisInput {
  failure: SolverFailure;
  /** Today's raw error text — the only observation the operator has, quoted rather than replaced. */
  originalMessage: string;
  targetHost: string;
  /** The address actually addressed: `solverEndpoint(proxyUrl)`, not a second spelling of it. */
  solverAddress: string;
  targetProbe?: ProbeOutcome | undefined;
  solverProbe?: ProbeOutcome | undefined;
}

export interface SolverDiagnosis {
  verdict: SolverVerdict;
  message: string;
}

/** Pure: the AC1 table, and nothing else. */
export function classifySolverFailure(input: SolverDiagnosisInput): SolverDiagnosis {
  switch (input.failure.origin) {
    case 'slot-wait':
      // The request never left for the solver, so there is nothing to diagnose and the existing
      // message already names the right component.
      return { verdict: 'undiagnosed', message: input.originalMessage };
    case 'solver-no-answer':
      return fromRetainedCause(input);
    case 'solver-answered':
      return fromSolverAnswered(input);
    case 'round-trip-timeout':
      return fromRoundTripTimeout(input);
  }
}

function fromRetainedCause(input: SolverDiagnosisInput): SolverDiagnosis {
  const outcome = outcomeForTransportCode(input.failure.transportCode);
  if (outcome.state === 'unreachable') {
    return { verdict: 'solver', message: solverMessage(input, outcome.code) };
  }
  return { verdict: 'inconclusive', message: inconclusiveMessage(input, unprobedNote(input.failure.transportCode)) };
}

function fromSolverAnswered(input: SolverDiagnosisInput): SolverDiagnosis {
  const delivered = input.failure.httpStatus;
  if (delivered !== undefined) {
    return { verdict: 'target', message: deliveredStatusMessage(input, delivered) };
  }
  const target = input.targetProbe ?? PROBE_NOT_RUN;
  if (target.state === 'unreachable') return { verdict: 'target', message: targetMessage(input, target.code) };
  if (target.state === 'reachable') {
    return { verdict: 'no-page', message: noPageMessage(input, target, undefined) };
  }
  return { verdict: 'inconclusive', message: inconclusiveMessage(input, probeNotes(input, target, undefined)) };
}

function fromRoundTripTimeout(input: SolverDiagnosisInput): SolverDiagnosis {
  const target = input.targetProbe ?? PROBE_NOT_RUN;
  const solver = input.solverProbe ?? PROBE_NOT_RUN;
  if (target.state === 'unreachable') return { verdict: 'target', message: targetMessage(input, target.code) };
  if (target.state === 'reachable' && solver.state === 'unreachable') {
    return { verdict: 'solver', message: solverMessage(input, solver.code, target) };
  }
  if (target.state === 'reachable' && solver.state === 'reachable') {
    return { verdict: 'no-page', message: noPageMessage(input, target, solver) };
  }
  return { verdict: 'inconclusive', message: inconclusiveMessage(input, probeNotes(input, target, solver)) };
}

function refusal(code: AttributingCode): string {
  return code === 'ECONNREFUSED'
    ? 'refused the connection (ECONNREFUSED)'
    : 'did not resolve (ENOTFOUND)';
}

/** Names the host and nothing else — a Target verdict makes no claim about the solver either way. */
function targetMessage(input: SolverDiagnosisInput, code: AttributingCode): string {
  return `Target unreachable: ${input.targetHost} ${refusal(code)}. Probed directly, not through the solver.`;
}

/**
 * The other Target arm (#2483). It cannot reuse `targetMessage`, whose `Probed directly` clause is
 * plainly false here: no probe ran, because the status IS the observation — the target answered,
 * through the solver, with that status rather than a page.
 */
function deliveredStatusMessage(input: SolverDiagnosisInput, status: number): string {
  return [
    `Target answered HTTP ${status}:`,
    `${input.targetHost} returned that status through the solver rather than a page.`,
    'No probe was run — the status came from the target itself.',
  ].join(' ');
}

function solverMessage(
  input: SolverDiagnosisInput,
  code: AttributingCode,
  target?: ProbeOutcome,
): string {
  const head = `Solver unreachable: ${input.solverAddress} ${refusal(code)}.`;
  return target?.state === 'reachable'
    ? `${head} ${input.targetHost} answered a direct probe (HTTP ${target.status}).`
    : head;
}

/**
 * Observations only. A liveness answer at the solver address proves an HTTP listener is there and
 * nothing more — the solver API is POST-based, so a framework can answer from its router (or return
 * an error envelope) while the browser worker behind it is wedged. So this verdict names both
 * components as still-possible and never says either is up.
 */
function noPageMessage(
  input: SolverDiagnosisInput,
  target: Extract<ProbeOutcome, { state: 'reachable' }>,
  solver: Extract<ProbeOutcome, { state: 'reachable' }> | undefined,
): string {
  const solverObservation = solver
    ? `an HTTP listener answered at ${input.solverAddress} (HTTP ${solver.status})`
    : `something answered at ${input.solverAddress}`;
  return [
    'No page came back.',
    `Observed: ${input.targetHost} answered a direct probe (HTTP ${target.status});`,
    `${solverObservation}; no page was returned.`,
    `Reported: "${input.originalMessage}".`,
    `Both ${input.targetHost} and ${input.solverAddress} remain possible causes — neither has been ruled out.`,
  ].join(' ');
}

function inconclusiveMessage(input: SolverDiagnosisInput, evidence: string): string {
  return [
    `Could not determine which component failed: "${input.originalMessage}".`,
    'That names the solver only as the source of the report, not as the component at fault —',
    'no component is blamed and none is ruled out.',
    evidence,
  ].join(' ');
}

function unprobedNote(code: string | undefined): string {
  if (code === undefined) {
    return 'No probe was run: the failure carried no transport code, so a second local request had nothing to rule out.';
  }
  return `No probe was run: transport code ${code} is equally consistent with a fault outside the solver — our own egress, a local resolver, or a dropped packet — which a second local request cannot rule out.`;
}

function describeProbe(outcome: ProbeOutcome): string {
  if (outcome.state === 'reachable') return `answered (HTTP ${outcome.status})`;
  if (outcome.state === 'unreachable') return refusal(outcome.code);
  return `inconclusive (${outcome.reason})`;
}

function probeNotes(
  input: SolverDiagnosisInput,
  target: ProbeOutcome,
  solver: ProbeOutcome | undefined,
): string {
  const notes = [`Direct probe of ${input.targetHost}: ${describeProbe(target)}.`];
  if (solver) notes.push(`Direct probe of ${input.solverAddress}: ${describeProbe(solver)}.`);
  return notes.join(' ');
}

export interface SolverFailureContext {
  /** Probed directly for reachability — the site's own origin, never routed through the solver. */
  targetProbeUrl: string;
  targetHost: string;
  /** The configured solver base URL; the endpoint actually addressed is derived from it here. */
  solverUrl: string;
  /** A standard proxy configured alongside the solver, if any. Applies to the target probe only. */
  proxyUrl?: string | undefined;
}

/**
 * Where a torznab/newznab diagnosis points: the API's own origin, probed rather than the caps URL so
 * no api key goes onto the probe's wire, and the host the verdict names. Shared by both adapters so
 * the two cannot answer "which host?" differently. Never throws — an unparseable `apiUrl` reaches
 * here only from an operator's own configuration, and a throw would turn `test()` into a crash.
 */
export function probeTargetFromApiUrl(apiUrl: string): { targetProbeUrl: string; targetHost: string } {
  try {
    const url = new URL(apiUrl);
    return { targetProbeUrl: url.origin, targetHost: url.hostname };
  } catch {
    return { targetProbeUrl: apiUrl, targetHost: apiUrl };
  }
}

/**
 * The single entry point the three solver-capable adapters call from their `test()` catch. Probes
 * run only here — after a round-trip has already failed, and only on the test path — so a successful
 * test issues zero additional requests, and neither probe ever takes a solver slot.
 */
export async function describeSolverFailure(
  error: unknown,
  context: SolverFailureContext,
): Promise<string> {
  const originalMessage = getErrorMessage(error);
  const failure = solverFailureOf(error);
  if (!failure) return originalMessage;

  const solverAddress = solverEndpoint(context.solverUrl);
  const needed = probesNeededFor(failure);
  const [targetProbe, solverProbe] = await Promise.all([
    needed.target
      ? probeReachable(context.targetProbeUrl, { ...(context.proxyUrl !== undefined && { proxyUrl: context.proxyUrl }) })
      : undefined,
    // Always direct, whatever `proxyUrl` says: the round-trip it explains is itself a bare fetch, and
    // a dispatcher would forfeit the transport codes the allowlist needs.
    needed.solver ? probeReachable(solverAddress) : undefined,
  ]);

  return classifySolverFailure({
    failure,
    originalMessage,
    targetHost: context.targetHost,
    solverAddress,
    targetProbe,
    solverProbe,
  }).message;
}
