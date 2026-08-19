import { access, constants, readdir, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { serializeError } from './utils/serialize-error.js';
import { CRASH_ARTIFACT_DIR, classifyCrashArtifact } from './utils/crash-artifacts.js';

export { CRASH_ARTIFACT_DIR, REPORT_PARSE_LIMIT } from './utils/crash-artifacts.js';

const REPORT_RETENTION = 5;
const CORE_RETENTION = 2;

const PROC_LIMITS = '/proc/self/limits';
const CORE_PATTERN = '/proc/sys/kernel/core_pattern';
const CORE_LIMIT_ROW = 'Max core file size';
const REPORT_SIGNAL = 'SIGUSR2';

// ---------------------------------------------------------------------------
// Prune
// ---------------------------------------------------------------------------

export interface CrashPruneSummary {
  reports: number;
  cores: number;
  deletedReports: number;
  deletedCores: number;
}

interface Candidate {
  name: string;
  filePath: string;
  mtimeMs: number;
}

const EMPTY_SUMMARY: CrashPruneSummary = { reports: 0, cores: 0, deletedReports: 0, deletedCores: 0 };

/**
 * Bounds the artifact directory to the newest {@link CORE_RETENTION} cores and
 * {@link REPORT_RETENTION} reports, counted independently so a burst of small reports can never
 * evict the one core holding a backtrace. Anything the content classifier does not recognise is
 * left alone and never counted — this directory is shared with whatever the operator puts in it.
 */
export async function pruneCrashArtifacts(dir: string, log: FastifyBaseLogger): Promise<CrashPruneSummary> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return EMPTY_SUMMARY;
  }

  const cores: Candidate[] = [];
  const reports: Candidate[] = [];

  for (const entry of entries) {
    // Directory entries that are not regular files are never read and never unlinked.
    if (!entry.isFile()) continue;

    const candidate = await statCandidate(dir, entry.name);
    if (!candidate) continue;

    const kind = await classifyCrashArtifact(candidate.filePath);
    if (kind === 'core') cores.push(candidate);
    else if (kind === 'report') reports.push(candidate);
    else if (kind === 'over-limit') {
      log.warn(
        { file: entry.name, size: candidate.size },
        'Crash artifact is too large to classify — it is retained but unmanaged; delete it if it is not needed',
      );
    }
  }

  const deletedCores = await deleteBeyond(cores, CORE_RETENTION, log);
  const deletedReports = await deleteBeyond(reports, REPORT_RETENTION, log);

  const summary: CrashPruneSummary = {
    reports: reports.length,
    cores: cores.length,
    deletedReports,
    deletedCores,
  };
  if (deletedReports + deletedCores > 0) log.info(summary, 'Pruned crash artifacts');
  return summary;
}

async function statCandidate(dir: string, name: string): Promise<(Candidate & { size: number }) | null> {
  const filePath = path.join(dir, name);
  try {
    const stats = await stat(filePath);
    return { name, filePath, mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return null;
  }
}

async function deleteBeyond(list: Candidate[], retention: number, log: FastifyBaseLogger): Promise<number> {
  // Equal mtimes are routine on a fast filesystem, so the name breaks the tie deterministically.
  const doomed = [...list]
    .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(retention);

  let deleted = 0;
  for (const candidate of doomed) {
    try {
      await unlink(candidate.filePath);
      deleted++;
    } catch (error: unknown) {
      // Already gone is the desired end state, not a failure.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        deleted++;
        continue;
      }
      log.warn({ error: serializeError(error), file: candidate.name }, 'Failed to delete a crash artifact');
    }
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

export interface CrashReportConfig {
  directory: string;
  filename: string;
  reportOnFatalError: boolean;
  reportOnSignal: boolean;
  signal: string;
  excludeEnv: boolean;
}

/** Injected probes retained for deterministic boot tests, mirroring `MutagenVersionProbeDeps`. */
export interface CrashForensicsProbeDeps {
  readProcLimits: () => Promise<string>;
  readCorePattern: () => Promise<string>;
  getReportConfig: () => CrashReportConfig;
  /** Resolves when the artifact directory exists and is writable; rejects with an errno otherwise. */
  probeArtifactDir: () => Promise<void>;
  cwd: () => string;
}

type LegState = 'armed' | 'disarmed' | 'unknown';

interface Leg {
  name: string;
  state: LegState;
  reasons: string[];
  /** The effective value behind the verdict, surfaced in the payload; null when undetermined. */
  value: string | null;
}

function armed(name: string, value: string | null = null): Leg {
  return { name, state: 'armed', reasons: [], value };
}
function disarmed(name: string, reason: string, value: string | null = null): Leg {
  return { name, state: 'disarmed', reasons: [reason], value };
}
function unknown(name: string): Leg {
  return { name, state: 'unknown', reasons: [], value: null };
}

async function coreLimitLeg(deps: CrashForensicsProbeDeps): Promise<Leg> {
  let text: string;
  try {
    text = await deps.readProcLimits();
  } catch {
    return unknown('core-limit');
  }

  const row = text.split('\n').find((line) => line.startsWith(CORE_LIMIT_ROW));
  if (!row) return unknown('core-limit');

  const soft = row.slice(CORE_LIMIT_ROW.length).trim().split(/\s+/)[0];
  if (!soft) return unknown('core-limit');
  if (soft === 'unlimited') return armed('core-limit', soft);

  const bytes = Number(soft);
  if (!Number.isFinite(bytes)) return unknown('core-limit');
  if (bytes > 0) return armed('core-limit', soft);

  return disarmed(
    'core-limit',
    'the soft core-file limit is 0, so the kernel will write no core — unset CRASH_CORE_DUMPS, and if the inherited hard limit blocks the raise start the container with --ulimit core=-1',
    soft,
  );
}

async function corePatternLeg(deps: CrashForensicsProbeDeps): Promise<Leg> {
  let raw: string;
  try {
    raw = await deps.readCorePattern();
  } catch {
    return unknown('core-pattern');
  }

  const pattern = raw.trim();
  if (!pattern) return unknown('core-pattern');

  if (pattern.startsWith('|')) {
    const handler = pattern.slice(1).trim().split(/\s+/)[0];
    return disarmed(
      'core-pattern',
      `a host core handler (${handler}) consumes the core, so it never appears under ${CRASH_ARTIFACT_DIR} — retrieve it with coredumpctl`,
      pattern,
    );
  }
  if (!pattern.startsWith('/')) {
    return disarmed(
      'core-pattern',
      `kernel.core_pattern "${pattern}" is relative, so the core lands in the process working directory and is lost when the container is recreated`,
      pattern,
    );
  }

  // The basename is free: the pruner identifies cores by ELF content, not by name.
  const dir = path.posix.dirname(path.posix.normalize(pattern));
  if (dir !== CRASH_ARTIFACT_DIR) {
    return disarmed(
      'core-pattern',
      `kernel.core_pattern writes to ${dir}, not ${CRASH_ARTIFACT_DIR}, so cores will not land where they are kept`,
      pattern,
    );
  }
  return armed('core-pattern', pattern);
}

function reportConfigLeg(config: CrashReportConfig, cwd: string): { leg: Leg; directory: string } {
  const reasons: string[] = [];

  if (!config.reportOnFatalError) reasons.push('--report-on-fatalerror is off, so a V8-fatal crash writes no report');
  if (!config.reportOnSignal) reasons.push('--report-on-signal is off, so kill -USR2 captures no live snapshot');
  if (config.signal !== REPORT_SIGNAL) {
    reasons.push(`the report signal is ${config.signal || 'unset'}, not ${REPORT_SIGNAL}, so the runbook's kill -USR2 would do nothing`);
  }
  if (!config.excludeEnv) {
    reasons.push('--report-exclude-env is off, so a report would carry NARRATORR_SECRET_KEY and every other credential in the process environment');
  }

  // Node returns the raw configured value, so a relative directory must be resolved before it is
  // compared; the default empty string means the process working directory.
  const directory = path.posix.resolve(cwd, config.directory);
  if (directory !== CRASH_ARTIFACT_DIR) {
    reasons.push(`reports would be written to ${directory}, outside the persisted ${CRASH_ARTIFACT_DIR} the pruner owns`);
  }
  if (config.filename !== '') reasons.push(filenameReason(config.filename));

  return {
    leg: { name: 'report-config', state: reasons.length > 0 ? 'disarmed' : 'armed', reasons, value: null },
    directory,
  };
}

function filenameReason(filename: string): string {
  const base = `--report-filename is set to "${filename}", so the artifact will not match the report.*.json name the runbook tells operators to look for (retention is unaffected — artifacts are classified by content)`;
  if (filename === 'core' || filename.startsWith('core.')) {
    return `${base}; a report named like a core is also the most confusing thing to find in ${CRASH_ARTIFACT_DIR}`;
  }
  return base;
}

async function artifactDirLeg(deps: CrashForensicsProbeDeps): Promise<Leg> {
  try {
    await deps.probeArtifactDir();
    return armed('artifact-directory');
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    // Write access only — nothing readable from inside the container proves the mount is durable.
    if (code === 'ENOENT') {
      return disarmed('artifact-directory', `${CRASH_ARTIFACT_DIR} does not exist, so no core or report can be written there`);
    }
    if (code === 'EACCES') {
      return disarmed('artifact-directory', `${CRASH_ARTIFACT_DIR} is not writable by this process, so no core or report can be written there`);
    }
    return unknown('artifact-directory');
  }
}

/** A known-disarmed leg is actionable regardless of what else could not be determined. */
function aggregate(legs: Leg[]): LegState {
  if (legs.some((leg) => leg.state === 'disarmed')) return 'disarmed';
  if (legs.some((leg) => leg.state === 'unknown')) return 'unknown';
  return 'armed';
}

/**
 * Answers "is crash evidence actually being captured?" in one line per boot. Each leg owns its own
 * failure taxonomy — a probe rejection is data for that leg, not an error — so the single
 * top-level catch is reserved for a defect in the check itself, and the two never both fire.
 */
export async function logCrashForensicsAtBoot(
  deps: CrashForensicsProbeDeps,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    const coreLimit = await coreLimitLeg(deps);
    const corePattern = await corePatternLeg(deps);
    const config = deps.getReportConfig();
    const report = reportConfigLeg(config, deps.cwd());
    const artifactDir = await artifactDirLeg(deps);

    const legs = [coreLimit, corePattern, report.leg, artifactDir];
    const readiness = aggregate(legs);
    const payload = {
      readiness,
      coreLimit: coreLimit.value,
      corePattern: corePattern.value,
      reportDirectory: report.directory,
      reportFilename: config.filename,
      artifactDir: CRASH_ARTIFACT_DIR,
      signal: config.signal,
      excludeEnv: config.excludeEnv,
      disarmedLegs: legs.filter((leg) => leg.state === 'disarmed').map((leg) => leg.name),
      unknownLegs: legs.filter((leg) => leg.state === 'unknown').map((leg) => leg.name),
    };

    if (readiness === 'disarmed') {
      const reasons = legs.flatMap((leg) => (leg.state === 'disarmed' ? leg.reasons : []));
      log.warn(payload, `Crash forensics not fully armed: ${reasons.join('; ')}`);
      return;
    }
    if (readiness === 'unknown') {
      log.info(payload, 'Crash forensics readiness could not be fully determined');
      return;
    }
    log.info(payload, 'Crash forensics armed');
  } catch (error: unknown) {
    log.warn({ error: serializeError(error) }, 'Failed to check crash forensics readiness at startup');
  }
}

// ---------------------------------------------------------------------------
// Production wrappers
// ---------------------------------------------------------------------------

/** Bind the production probes while retaining the independently tested best-effort contract. */
export async function checkCrashForensicsAtBoot(log: FastifyBaseLogger): Promise<void> {
  await logCrashForensicsAtBoot({
    readProcLimits: () => readFile(PROC_LIMITS, 'utf-8'),
    readCorePattern: () => readFile(CORE_PATTERN, 'utf-8'),
    getReportConfig: () => ({
      directory: process.report?.directory ?? '',
      filename: process.report?.filename ?? '',
      reportOnFatalError: process.report?.reportOnFatalError ?? false,
      reportOnSignal: process.report?.reportOnSignal ?? false,
      signal: process.report?.signal ?? '',
      excludeEnv: process.report?.excludeEnv ?? false,
    }),
    probeArtifactDir: () => access(CRASH_ARTIFACT_DIR, constants.W_OK),
    cwd: () => process.cwd(),
  }, log);
}

/**
 * Runs before anything else touches /config. A segfault crashloop restarts boot every ~3s and
 * cores can be GB-scale on the same volume as the database, so a prune wired beside the late
 * capability probes would never execute on precisely the crashloop it exists to break.
 */
export async function pruneCrashArtifactsAtBoot(log: FastifyBaseLogger): Promise<void> {
  try {
    await pruneCrashArtifacts(CRASH_ARTIFACT_DIR, log);
  } catch (error: unknown) {
    log.warn({ error: serializeError(error) }, 'Failed to prune crash artifacts at startup');
  }
}
