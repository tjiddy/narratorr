import path from 'node:path';

/**
 * Archive path decisions for companion EPUBs (#1986, design §4).
 *
 * Pure and archive-free: these take strings, buffers, and name lists — never a
 * `File`, a handle, or an open archive. Applying them to a real central
 * directory is 1.1c's job.
 *
 * **`path.posix` only, never bare `node:path`.** On a Windows dev box the
 * default build rewrites `/` to `\` and would corrupt every archive member
 * name; an EPUB entry name is a platform-independent POSIX key.
 */

/**
 * The outcome of a name-returning helper.
 *
 * Discriminated rather than a bare `string`, because `unsafe_entry_path` is
 * itself a legal relative archive member name and a legal UTF-8 decode — a
 * `string | 'unsafe_entry_path'` union could not tell success from rejection.
 */
export type EpubPathResult =
  | { kind: 'entry'; name: string }
  | { kind: 'rejected'; reason: 'unsafe_entry_path' };

/** `resolveHref`'s outcome — a path result plus the "not in this archive" arm. */
export type EpubHrefResult = EpubPathResult | { kind: 'remote' };

/** The duplicate detector reports a finding, not a name, so no collision exists here. */
export type EpubDuplicateResult =
  | { kind: 'unique' }
  | { kind: 'duplicate'; reason: 'duplicate_entry'; name: string };

const REJECTED: EpubPathResult = { kind: 'rejected', reason: 'unsafe_entry_path' };

/**
 * NUL and the rest of the C0 control range (U+0000-U+001F), never legal in an
 * OCF item name. Scanned by code unit rather than by a character class, which
 * would be a `no-control-regex` violation - and the AC forbids lint disables.
 */
function hasControlCharacter(raw: string): boolean {
  for (let i = 0; i < raw.length; i += 1) {
    if (raw.charCodeAt(i) <= 0x1f) return true;
  }
  return false;
}

/**
 * Anything of the shape `<single letter>:` — the Windows drive-letter family.
 * Deliberately not anchored to a following separator: `x:chapter.xhtml` must
 * never become an archive key either, and the governing invariant for the whole
 * family is that none of its spellings produces `kind: 'entry'`.
 */
const DRIVE_RE = /^[A-Za-z]:/;

/**
 * A URL scheme of **two or more** characters (note `+`, not `*`). One character
 * before the colon is read as a drive letter instead — a deliberate, documented
 * deviation from RFC 3986 §3.1, matching the WHATWG URL Standard's explicit
 * "Windows drive letter" concept. In a manifest `href`, `C:` is overwhelmingly
 * likelier to be a smuggled Windows path than a one-letter protocol, and
 * rejecting costs at most a `null` optional field.
 */
const SCHEME_RE = /^[a-z][a-z0-9+.-]+:/i;

/**
 * Normalise a raw archive member name to a POSIX archive key, or reject it.
 *
 * Rejects POSIX-absolute, drive-absolute, UNC, any `..` segment, any backslash,
 * any C0 control character, and anything that normalises to nothing.
 */
export function normalizeArchivePath(raw: string): EpubPathResult {
  if (raw === '') return REJECTED;
  // The ZIP spec mandates `/` as the separator, so a backslash is a Windows-path
  // smuggle. This also covers UNC (`\\host\share`) and `C:\a`.
  if (raw.includes('\\')) return REJECTED;
  if (hasControlCharacter(raw)) return REJECTED;
  if (raw.startsWith('/')) return REJECTED;
  // `path.posix.isAbsolute('C:/a')` is `false`, so the drive form needs its own pattern.
  if (DRIVE_RE.test(raw)) return REJECTED;
  // Evaluated on the INPUT, before any collapsing: `path.posix.normalize('a/../b')`
  // is `'b'`, so a normalise-then-scan implementation silently accepts it.
  // Nothing legitimate is lost — a central-directory member name never contains
  // `..`, and `resolveHref` collapses interior `..` before calling us.
  if (raw.split('/').includes('..')) return REJECTED;

  const name = path.posix.normalize(raw);
  if (name === '.' || name === './') return REJECTED;
  return { kind: 'entry', name };
}

/**
 * Decode raw central-directory name bytes as UTF-8, fatally.
 *
 * OCF requires UTF-8 item names, and there is no CP437 fallback — the ZIP
 * language-encoding flag does not license one. unzipper's own `File.path` comes
 * from a non-fatal `Buffer.toString()` that substitutes U+FFFD for malformed
 * bytes, which would index and duplicate-check a name the spec means to reject.
 */
export function decodeEntryName(pathBuffer: Buffer): EpubPathResult {
  try {
    return { kind: 'entry', name: new TextDecoder('utf-8', { fatal: true }).decode(pathBuffer) };
  } catch {
    // The fatal decoder throws `TypeError`; any decode failure is a rejection.
    return REJECTED;
  }
}

/**
 * Report the first exactly-repeated name in a list of normalised entry names.
 *
 * Deliberately case-sensitive: nothing in Phase 1 writes an archive member to
 * disk, so a case collision is harmless and folding would reject legitimate
 * archives.
 */
export function findDuplicateEntry(names: readonly string[]): EpubDuplicateResult {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) return { kind: 'duplicate', reason: 'duplicate_entry', name };
    seen.add(name);
  }
  return { kind: 'unique' };
}

/**
 * The single shared EPUB reference resolver: turn a manifest `href` or a
 * `CipherReference URI` into an archive key.
 *
 * **No other function in `src/core/epub/` may do this.** Four call sites
 * (spine/content matching, DRM classification, nav/NCX discovery, cover
 * extraction) making four path decisions is the defect this prevents.
 *
 * `baseDir` is the caller's choice: the directory containing the package
 * document for manifest hrefs (EPUB 3.3 §5.2), or `''` for the container root.
 * **Containment is against the container root, not against `baseDir`** — a `..`
 * that lands back inside the archive is legitimate and accepted.
 */
export function resolveHref(baseDir: string, rawUrl: string): EpubHrefResult {
  // 1. A real scheme, or protocol-relative, is not in this archive.
  if (SCHEME_RE.test(rawUrl) || rawUrl.startsWith('//')) return { kind: 'remote' };

  // 2. Strip the fragment and the query.
  const stripped = rawUrl.split('#')[0]!.split('?')[0]!;
  if (stripped === '') return REJECTED;

  // 3. Percent-decode once. Decoding PRECEDES normalisation and containment —
  //    the reverse order is the classic `%2e%2e%2f` bypass.
  let decoded: string;
  try {
    decoded = decodeURIComponent(stripped);
  } catch {
    // A malformed escape throws `URIError`.
    return REJECTED;
  }

  // 4. Reject absolute references BEFORE joining. Joining hides the prefix from
  //    every start-anchored check downstream: `path.posix.join('OEBPS', 'C:/a')`
  //    is `'OEBPS/C:/a'` and `path.posix.join('OEBPS', '/a')` is `'OEBPS/a'`,
  //    both of which `normalizeArchivePath` would then admit. Post-decode,
  //    because `C:%2Fa` decodes to `C:/a` and must be caught identically.
  if (decoded === '' || decoded.startsWith('/') || DRIVE_RE.test(decoded)) return REJECTED;
  if (decoded.includes('\\')) return REJECTED;

  // 5. Resolve against the base, then 6. run the result through the normaliser,
  //    which rejects anything that escaped the container root.
  return normalizeArchivePath(path.posix.join(baseDir, decoded));
}
