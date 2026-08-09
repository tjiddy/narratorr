import path from 'node:path';

/** Pure archive-path decisions; EPUB member names always use path.posix semantics. */

/** Discriminated because `unsafe_entry_path` is itself a legal member name. */
export type EpubPathResult =
  | { kind: 'entry'; name: string }
  | { kind: 'rejected'; reason: 'unsafe_entry_path' };

export type EpubHrefResult = EpubPathResult | { kind: 'remote' };

export type EpubDuplicateResult =
  | { kind: 'unique' }
  | { kind: 'duplicate'; reason: 'duplicate_entry'; name: string };

const REJECTED: EpubPathResult = { kind: 'rejected', reason: 'unsafe_entry_path' };

/** OCF forbids C0 controls; scan by code unit to avoid a control-character regex. */
function hasControlCharacter(raw: string): boolean {
  for (let i = 0; i < raw.length; i += 1) {
    if (raw.charCodeAt(i) <= 0x1f) return true;
  }
  return false;
}

/** Reject the entire single-letter-colon family, including `x:chapter.xhtml`. */
const DRIVE_RE = /^[A-Za-z]:/;

/** Schemes require two characters here; single-letter prefixes are treated as drive paths. */
const SCHEME_RE = /^[a-z][a-z0-9+.-]+:/i;

/**
 * Normalise a raw archive member name to a POSIX archive key, or reject it.
 *
 * Rejects POSIX-absolute, drive-absolute, UNC, any `..` segment, any backslash,
 * any C0 control character, and anything that normalises to nothing.
 */
export function normalizeArchivePath(raw: string): EpubPathResult {
  if (raw === '') return REJECTED;
  // ZIP names use `/`; reject backslash smuggling, including UNC and drive paths.
  if (raw.includes('\\')) return REJECTED;
  if (hasControlCharacter(raw)) return REJECTED;
  if (raw.startsWith('/')) return REJECTED;
  // path.posix does not consider `C:/a` absolute.
  if (DRIVE_RE.test(raw)) return REJECTED;
  // Scan before normalization, which would hide collapsible traversal such as `a/../b`.
  if (raw.split('/').includes('..')) return REJECTED;

  const name = path.posix.normalize(raw);
  if (name === '.' || name === './') return REJECTED;
  return { kind: 'entry', name };
}

/** Fatally decodes OCF-mandated UTF-8; unzipper's replacement-character path is not authoritative. */
export function decodeEntryName(pathBuffer: Buffer): EpubPathResult {
  try {
    return { kind: 'entry', name: new TextDecoder('utf-8', { fatal: true }).decode(pathBuffer) };
  } catch {
    return REJECTED;
  }
}

/** Finds the first exact duplicate; case collisions are harmless because entries are never written to disk. */
export function findDuplicateEntry(names: readonly string[]): EpubDuplicateResult {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) return { kind: 'duplicate', reason: 'duplicate_entry', name };
    seen.add(name);
  }
  return { kind: 'unique' };
}

/**
 * Shared resolver for manifest hrefs and CipherReference URIs. `baseDir` is the
 * package directory or container root; containment is against the root, not baseDir.
 */
export function resolveHref(baseDir: string, rawUrl: string): EpubHrefResult {
  if (SCHEME_RE.test(rawUrl) || rawUrl.startsWith('//')) return { kind: 'remote' };

  const stripped = rawUrl.split('#')[0]!.split('?')[0]!;
  if (stripped === '') return REJECTED;

  // Decode before normalization and containment to block encoded traversal.
  let decoded: string;
  try {
    decoded = decodeURIComponent(stripped);
  } catch {
    return REJECTED;
  }

  // Reject absolutes before join hides their prefix, and after percent-decoding reveals it.
  if (decoded === '' || decoded.startsWith('/') || DRIVE_RE.test(decoded)) return REJECTED;
  if (decoded.includes('\\')) return REJECTED;

  return normalizeArchivePath(path.posix.join(baseDir, decoded));
}
