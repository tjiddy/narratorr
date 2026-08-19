import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

/**
 * Fixed, not derived from CONFIG_PATH: `kernel.core_pattern` is a host-global sysctl that cannot
 * interpolate a per-container variable, so the core destination is necessarily one absolute
 * literal — and the report destination must equal it for a single pruner to own both.
 */
export const CRASH_ARTIFACT_DIR = '/config/crash-reports';

/**
 * Cost ceiling on the JSON classification path, deliberately not operator-tunable. Classifying
 * transiently holds the capped buffer, its decoded string and the parsed graph at once; measured
 * at 8 MiB that peak stays under ~60 MiB, once, before the database opens. An over-limit artifact
 * is retained and warned about — the remedy is deletion, which cannot be misconfigured.
 */
export const REPORT_PARSE_LIMIT = 8 * 1024 * 1024;

/** ELF magic (4 bytes) plus the padding up to `e_type`, a uint16 at offset 16. */
const CORE_SIGNATURE_BYTES = 18;
const ELF_MAGIC = 0x7f454c46;
const ET_CORE = 4;
const E_TYPE_OFFSET = 16;
const READ_CHUNK = 64 * 1024;

/** `null` is "not ours"; `over-limit` is "not ours, and the caller must say so out loud". */
export type CrashArtifactKind = 'core' | 'report' | 'over-limit' | null;

/**
 * Provenance by content, never by name. Artifact names are chosen by the kernel and by
 * operator-settable Node flags, so a name rule would have to know which configuration was in
 * effect when each file was written — information the filesystem does not carry.
 */
export async function classifyCrashArtifact(filePath: string): Promise<CrashArtifactKind> {
  let handle: FileHandle;
  try {
    handle = await open(filePath, 'r');
  } catch {
    return null;
  }

  try {
    const head = Buffer.alloc(CORE_SIGNATURE_BYTES);
    const { bytesRead } = await handle.read(head, 0, CORE_SIGNATURE_BYTES, 0);
    if (bytesRead < CORE_SIGNATURE_BYTES) return null;

    // A core of any size settles here, in 18 bytes, before anything is read or allocated.
    if (head.readUInt32BE(0) === ELF_MAGIC) {
      return head.readUInt16LE(E_TYPE_OFFSET) === ET_CORE ? 'core' : null;
    }

    const text = await readCapped(handle, head);
    if (text === null) return 'over-limit';
    return isNodeReport(text) ? 'report' : null;
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Reads at most `REPORT_PARSE_LIMIT + 1` bytes through the already-open handle, returning `null`
 * once the cap is passed. Capping the read rather than gating on a prior `stat` closes the
 * time-of-check/time-of-use gap: a file still being appended to cannot outgrow the budget.
 */
async function readCapped(handle: FileHandle, head: Buffer): Promise<string | null> {
  const chunks: Buffer[] = [head];
  let total = head.length;

  while (total <= REPORT_PARSE_LIMIT) {
    const want = Math.min(READ_CHUNK, REPORT_PARSE_LIMIT + 1 - total);
    const buffer = Buffer.alloc(want);
    const { bytesRead } = await handle.read(buffer, 0, want, total);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
  }

  return total > REPORT_PARSE_LIMIT ? null : Buffer.concat(chunks).toString('utf-8');
}

/** Own-property semantics throughout, so a `__proto__`-keyed document cannot fake a match. */
function hasOwn(value: unknown, key: string): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Total by construction: `JSON.parse` can yield `null`, a primitive or an array, all of which a
 * naive `parsed.header.reportVersion` would throw on. The version domain is positive integers —
 * the format version's actual history — which rejects `0`, `-1`, `1.5` and `Infinity` while
 * staying loose enough to survive a future Node bumping the version.
 */
function isNodeReport(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }

  if (!hasOwn(parsed, 'header')) return false;
  const header = parsed.header;
  if (!hasOwn(header, 'reportVersion')) return false;

  const version = header.reportVersion;
  return Number.isInteger(version) && (version as number) > 0;
}
