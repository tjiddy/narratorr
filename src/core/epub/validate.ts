import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { EpubOptionalReader, EpubPackageView } from './extract.js';
import { extractEpubCover, extractEpubMetadata, extractEpubToc } from './extract.js';
import { MAX_ARCHIVE_BYTES, MAX_INSPECTION_BYTES, MAX_XML_BYTES } from './limits.js';
import { resolveHref } from './paths.js';
import type { EpubInspection, EpubValidation, EpubValidationCode } from './result.js';
import type { EpubXmlElement, EpubXmlResult } from './xml.js';
import { attrByExactName, childrenByLocalName, parseEpubXml } from './xml.js';
import type {
  ZipArchiveEntry,
  ZipEntryRead,
  ZipPositionalSource,
  ZipReadFailure,
  ZipSourceSession,
} from './zip-source.js';
import { withZipSource } from './zip-source.js';

/**
 * Structural validation for companion EPUBs (#1989, design §4) — the pipeline,
 * its precedence order, and the `META-INF/encryption.xml` classifier.
 *
 * **Orchestration only.** The EOCD selection, the ZIP64 preflight, the
 * entry-count ceiling, the positional adapter, entry-name decoding, and
 * duplicate detection all live in 1.1c (`zip-source.ts`); path resolution, the
 * counting transform, the frozen limits, the result vocabulary, and error
 * classification live in 1.1a; bounded decoding and parsing live in 1.1b. This
 * module calls them in order and maps their outcomes onto the frozen
 * vocabulary. Any re-spelling of that logic here is a DRY defect.
 *
 * **No context handle, and one export.** `validateEpub(filePath)` performs the
 * entire preflight itself: one call is one open is one budget. There is no
 * `EpubContext` to pass, own, close, or reuse. The shared pipeline, the
 * structure it produces, its budget, and the encryption classifier are all
 * module-private; {@link runEpubPipeline} hands the structure to a continuation
 * and it is dead the moment that continuation returns, because 1.1c closes the
 * handle in its own `finally`. 1.1e's `inspectEpub` lands **here**, beside
 * `validateEpub`, over the same private pipeline — `extract.ts` owns only the
 * optional-read helpers. That is what keeps "reuse the pipeline whole" and "the
 * internal shape appears in no export" true at the same time (#1989 Decision 1).
 *
 * **I/O failure is never a verdict.** 1.1c already classifies around
 * `Open.custom()` and around every entry stream, rethrowing on `throw` and
 * otherwise reporting a label; this module *maps* labels and re-classifies
 * nothing. The one site it could catch — `lstat` — deliberately has no catch, so
 * its rejection propagates unchanged.
 *
 * **Nothing here removes DRM, and validation promises nothing about Kindle
 * conversion compatibility.**
 */

/** The OCF-mandated media-type member and its only accepted content. */
const MIMETYPE_ENTRY = 'mimetype';
const EPUB_MEDIA_TYPE = 'application/epub+zip';
const CONTAINER_ENTRY = 'META-INF/container.xml';
const ENCRYPTION_ENTRY = 'META-INF/encryption.xml';

/**
 * The base `resolveHref` is given for a container `full-path` and for a
 * `CipherReference URI` — both are container-root-relative (OCF 3.3 §3.5.1,
 * §4.1), unlike a manifest `href`, which is relative to the package document.
 */
const CONTAINER_ROOT = '';

/** ZIP general-purpose bit 0: the member is encrypted. */
const ZIP_ENCRYPTED_BIT = 0x1;

/** `PK\x03\x04` (a local file header) or `PK\x05\x06` (an empty archive's EOCD). */
const SIGNATURE_BYTES = 4;
const LOCAL_FILE_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const EMPTY_ARCHIVE_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

/**
 * The font media types an obfuscated-font reference may carry — the OpenType/WOFF
 * set (RFC 8081) plus the legacy spellings still emitted by real publishers.
 *
 * **The filename extension is never consulted** (#1989 Decision 4, which
 * deliberately overrides §4's prose at `docs/plans/companion-ebook-support.md:355-357`).
 * An extension-suffix rule classifies an encrypted spine document named
 * `chapter.ttf` as readable and a legitimate `FONT.TTF` as DRM; media type plus
 * manifest identity plus spine role decides it instead, so case and suffix are
 * both irrelevant.
 */
const FONT_MEDIA_TYPES = new Set([
  // RFC 8081 registered types.
  'font/ttf',
  'font/otf',
  'font/woff',
  'font/woff2',
  'font/sfnt',
  'font/collection',
  // Pre-RFC-8081 spellings still emitted by real publishers. The x- family is the
  // treacherous one: it has no canonical form, so every generation of tooling coined
  // its own. The first live falsification was The Shining (dev UAT, 2026-07-29):
  // Adobe-obfuscated fonts manifest-declared `application/x-font-truetype` — a
  // DRM-free book read as drm_protected because only the `x-font-ttf` sibling was
  // listed. When a legit book trips the classifier, suspect THIS list first.
  'application/font-sfnt',
  'application/vnd.ms-opentype',
  'application/font-woff',
  'application/x-font-ttf',
  'application/x-font-truetype',
  'application/x-truetype-font',
  'application/x-font-otf',
  'application/x-font-opentype',
]);

/**
 * Every verdict the **structural** pipeline can reach.
 *
 * `available` is deliberately absent: nothing before the encryption classifier
 * can decide it, so the pipeline's verdict arm is a rejection by construction.
 * Saying so in the type is what lets `inspectEpub` hand a pipeline verdict
 * straight back as an `EpubInspection` — whose `available` arm carries a
 * metadata/TOC/cover payload — without an unreachable branch to widen it.
 */
type EpubRejection = Exclude<EpubValidation, { status: 'available' }>;

const AVAILABLE: EpubValidation = { status: 'available' };
const DRM_PROTECTED: EpubRejection = { status: 'drm_protected' };

function invalid(code: EpubValidationCode): EpubRejection {
  return { status: 'invalid', code };
}

/**
 * The uniform mapping for a failure 1.1c *reported* rather than threw.
 *
 * Every read this module performs is mandatory, so the mapping is total here.
 * (1.1e adds the optional-read disposition, where the same labels yield a `null`
 * field instead.) A second `classifyEpubReadError` call over an already-reported
 * label would be a defect — the classification already happened.
 */
function fromReadFailure(label: ZipReadFailure): EpubRejection {
  return invalid(label === 'cap-exceeded' ? 'limit_exceeded' : 'truncated');
}

// --- the shared budget ------------------------------------------------------

/**
 * One call's `MAX_INSPECTION_BYTES` allowance, threaded across every read that
 * call performs. 1.1c owns no budget — `read(cap)` takes a per-read cap — so the
 * remainder lives here.
 *
 * There is **no cross-call budget** and no context to carry one: a caller that
 * validates and then inspects opens twice and is bounded twice.
 */
interface EpubInspectionBudget {
  /** Inflated bytes charged so far. */
  readonly consumed: number;
  /**
   * Read `entry` at `Math.min(remaining, ceiling)` and charge what came back.
   *
   * The **mandatory** form. It neither pre-rejects nor charges a failed read,
   * and deliberately so: a mandatory read that fails produces a verdict and the
   * call ends right there, so there is nothing left for a forgiven byte to
   * inflate.
   *
   * `mimetype` is deliberately not exempted from the `MAX_XML_BYTES` ceiling.
   * It is not an XML document, but minting a seventh constant to bound a 20-byte
   * ASCII literal would force an edit to a merged sibling's exact-value pin
   * (`limits.test.ts:19-26`, "the six constants") for no behavioural gain.
   */
  read(entry: ZipArchiveEntry, ceiling: number): Promise<ZipEntryRead>;
  /**
   * The **optional** form: charge-as-you-go, never rolled back (#1990
   * Decision 3).
   *
   * Two things separate it from {@link EpubInspectionBudget.read}:
   *
   * - **Pre-reject.** When nothing remains, or when the entry's *declared*
   *   `uncompressedSize` already exceeds what does, it returns without calling
   *   `entry.read` at all — `readEntry` calls `file.stream()` unconditionally
   *   (`zip-source.ts:568-581`), so even a zero cap would open a stream. The
   *   declared size is used **only** here, to skip work; it is never an
   *   enforcement point and never substituted for the streamed count.
   * - **Charge on failure.** A read that aborted on its cap, exhausted the
   *   remainder, or failed mid-inflate still inflated bytes, and those stay
   *   charged. Rolling them back would let one call inflate more than
   *   `MAX_INSPECTION_BYTES` by failing repeatedly, which is the whole ceiling.
   */
  readOptional(entry: ZipArchiveEntry, ceiling: number): Promise<ZipEntryRead>;
}

/**
 * What a pre-reject reports. `cap-exceeded` is the honest label — the read was
 * refused precisely because performing it would cross the ceiling — and every
 * optional read maps both failure labels to a `null` field anyway, so no caller
 * has to tell a pre-reject from a streamed abort.
 */
const PRE_REJECTED: ZipEntryRead = { kind: 'failed', label: 'cap-exceeded', inflatedBytes: 0 };

function createInspectionBudget(): EpubInspectionBudget {
  let consumed = 0;
  return {
    get consumed(): number {
      return consumed;
    },
    async read(entry: ZipArchiveEntry, ceiling: number): Promise<ZipEntryRead> {
      const read = await entry.read(Math.min(MAX_INSPECTION_BYTES - consumed, ceiling));
      if (read.kind === 'bytes') consumed += read.bytes.length;
      return read;
    },
    async readOptional(entry: ZipArchiveEntry, ceiling: number): Promise<ZipEntryRead> {
      const remaining = MAX_INSPECTION_BYTES - consumed;
      if (remaining <= 0 || entry.uncompressedSize > remaining) return PRE_REJECTED;
      const read = await entry.read(Math.min(remaining, ceiling));
      consumed += read.kind === 'bytes' ? read.bytes.length : read.inflatedBytes;
      return read;
    },
  };
}

// --- the shared structure ---------------------------------------------------

type EpubXmlDocument = Extract<EpubXmlResult, { kind: 'document' }>;

/**
 * The package document reduced to the two lookups both the spine chain and the
 * encryption classifier need.
 */
interface EpubPackageIndex {
  /** How many `<item>` elements the manifest declared, before any resolution. */
  readonly itemCount: number;
  /**
   * The manifest's `<item>` elements in document order.
   *
   * Retained rather than re-derived: nav and cover discovery both ask for "the
   * first manifest item in document order satisfying a predicate", which neither
   * lookup below can answer, and a second `childrenByLocalName` pass in
   * `extract.ts` would give that ordering two homes.
   */
  readonly items: readonly EpubXmlElement[];
  /**
   * The **first** `<spine>` element, or `undefined`. EPUB 2 TOC discovery reads
   * its `toc` attribute, which the derived lookups below do not carry.
   */
  readonly spine: EpubXmlElement | undefined;
  /**
   * Manifest items keyed by `id`. A **duplicated** id maps to `null`, so
   * "matches the `id` of exactly one manifest item" is decidable rather than
   * silently first-match.
   */
  readonly itemsById: ReadonlyMap<string, EpubXmlElement | null>;
  /** Manifest items grouped by the archive name their `href` resolves to. */
  readonly itemsByName: ReadonlyMap<string, EpubXmlElement[]>;
  /** Every `<itemref>`'s `idref`, linear or not. */
  readonly spineIdrefs: ReadonlySet<string>;
  /** The spine's `<itemref>` elements in document order. */
  readonly itemrefs: readonly EpubXmlElement[];
}

/**
 * What the structural pipeline produces once a book has passed every check up to
 * and including the linear spine.
 *
 * **Module-private, and never a handle.** It appears in no export at all — not
 * as a value, not as a type — so no caller can name it, hold it, or receive one:
 * `validateEpub` returns an `EpubValidation` and 1.1e's `inspectEpub` will
 * return an `EpubInspection`. It is valid only inside {@link runEpubPipeline}'s
 * continuation, is never owned by a caller, and is never closed by one — 1.1c's
 * `finally` owns the handle. This is deliberately *not* the rejected
 * `EpubContext` shape (#1989 Decision 1).
 *
 * Privacy is what makes that airtight rather than advisory. An exported
 * continuation with an unconstrained return type would let
 * `pipeline(path, async (outcome) => outcome)` hand the structure back *after*
 * the closing `finally` ran, leaving a caller holding a source whose handle is
 * gone. Nothing outside this module can express that call.
 */
interface EpubStructure {
  /** The open positional source, for reads a later stage still wants to perform. */
  readonly source: ZipPositionalSource;
  /** Every normalised archive member, as 1.1c reported them. */
  readonly entries: readonly ZipArchiveEntry[];
  readonly entriesByName: ReadonlyMap<string, ZipArchiveEntry>;
  readonly packageDocument: EpubXmlDocument;
  /** The directory the package document resolves its `href`s against. */
  readonly packageBaseDir: string;
  readonly packageIndex: EpubPackageIndex;
  /** The one budget for this call, carrying the bytes consumed so far. */
  readonly budget: EpubInspectionBudget;
}

/** The pipeline either produced a structure or already decided the verdict. */
type EpubPipelineOutcome =
  | { kind: 'structure'; structure: EpubStructure }
  | { kind: 'verdict'; validation: EpubRejection };

/**
 * The verdict arm, shared by all three staged unions below.
 *
 * Typed as the literal shape rather than as `EpubPipelineOutcome`, so it is
 * assignable to whichever stage's union the call site returns.
 */
function verdict(validation: EpubRejection): { kind: 'verdict'; validation: EpubRejection } {
  return { kind: 'verdict', validation };
}

// --- pre-open ---------------------------------------------------------------

/**
 * The two checks that must decide **before a descriptor exists**.
 *
 * `lstat`, not `stat`: symlinks are not followed. A non-regular file reuses
 * `not_a_zip` rather than growing the frozen vocabulary a twelfth code — it
 * reads as "this path does not present a readable ZIP archive", which is exactly
 * true of a directory, FIFO, socket, device, or symlink. Rejecting symlinks here
 * matches discovery and the §5 resolver: a validator that returns `available`
 * for a file the streamer will refuse to serve is worse than one that agrees
 * with it.
 *
 * **No catch.** An `lstat` rejection propagates unchanged, which is the required
 * behaviour — I/O failure is never a verdict.
 */
async function preOpenRejection(filePath: string): Promise<EpubRejection | null> {
  const stats = await lstat(filePath);
  if (!stats.isFile()) return invalid('not_a_zip');
  if (stats.size > MAX_ARCHIVE_BYTES) return invalid('limit_exceeded');
  return null;
}

// --- post-open --------------------------------------------------------------

/**
 * The four-byte signature read — the only read this module performs through
 * `source` directly.
 *
 * Legal in this window and harmless to the replay queue: `source.stream()` serves
 * a live read whenever the queue is empty (`zip-source.ts:353-358`), and
 * `preflightAndOpen()` calls `arm()`, which *clears* the queue before pushing
 * (`:376-379`).
 *
 * Unlike `entry.read()` and `preflightAndOpen()` this path has no failed-label
 * union: a live positional stream forwards its original read failure unchanged
 * (`zip-source.ts:298-314`), and no catch here would improve on that.
 */
async function readSignature(source: ZipPositionalSource): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source.stream(0, SIGNATURE_BYTES)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * What separates `not_a_zip` from `truncated`: fewer than four readable bytes,
 * or four bytes that are neither a local file header nor an empty archive's
 * EOCD, is not a ZIP at all. A file that passes this and then fails 1.1c's
 * preflight *is* a ZIP whose structure did not survive — `truncated`.
 */
function hasZipSignature(bytes: Buffer): boolean {
  // `Buffer.equals` compares length first, so a short read — a zero-byte or
  // three-byte file — falls out here without a separate length branch.
  return bytes.equals(LOCAL_FILE_SIGNATURE) || bytes.equals(EMPTY_ARCHIVE_SIGNATURE);
}

type ArchiveStage =
  | { kind: 'entries'; entries: ZipArchiveEntry[] }
  | { kind: 'verdict'; validation: EpubRejection };

/**
 * Everything from the authoritative `fstat` through the ZIP-encryption-bit scan.
 *
 * `session.stat` — the `fstat` — is the size and file-kind authority. The earlier
 * `lstat` is a cheap pre-reject; this is what the pipeline arithmetic uses, so
 * the bytes checked are provably the bytes read. These necessarily fire *after*
 * the handle exists, which is not a contradiction of the pre-open rule.
 *
 * `MAX_ARCHIVE_ENTRIES` is deliberately absent: 1.1c enforces it once, pre-open,
 * against the validated declared count (`zip-source.ts:554`). A second branch
 * here would be a DRY defect, and one against `entries.length` would not even be
 * a measurement.
 */
async function openArchive(session: ZipSourceSession): Promise<ArchiveStage> {
  if (!session.stat.isFile()) return verdict(invalid('not_a_zip'));
  if (session.stat.size > MAX_ARCHIVE_BYTES) return verdict(invalid('limit_exceeded'));
  if (!hasZipSignature(await readSignature(session.source))) return verdict(invalid('not_a_zip'));

  const archive = await session.preflightAndOpen();
  // Straight through, with no re-classification: all four reachable codes —
  // `truncated`, `limit_exceeded`, `unsafe_entry_path`, `duplicate_entry` — are
  // already the frozen vocabulary.
  if (archive.kind === 'rejected') return verdict(invalid(archive.code));
  if (archive.kind === 'failed') return verdict(fromReadFailure(archive.label));

  // Decided from the central directory, before any `entry.read()`: a ZIP whose
  // entries set general-purpose bit 0 is password-protected, and no password
  // error can then reach the read path. The owner-facing outcome is "this file
  // is protected", not "this file is malformed".
  const encrypted = archive.entries.some((entry) => (entry.flags & ZIP_ENCRYPTED_BIT) !== 0);
  if (encrypted) return verdict(DRM_PROTECTED);
  return { kind: 'entries', entries: archive.entries };
}

/** One mandatory read: the inflated bytes, or the verdict the attempt produced. */
type MandatoryRead =
  | { kind: 'bytes'; bytes: Buffer }
  | { kind: 'verdict'; validation: EpubRejection };

async function readMandatory(
  entry: ZipArchiveEntry | undefined,
  absent: EpubValidationCode,
  budget: EpubInspectionBudget,
): Promise<MandatoryRead> {
  if (!entry) return verdict(invalid(absent));
  const read = await budget.read(entry, MAX_XML_BYTES);
  if (read.kind === 'failed') return verdict(fromReadFailure(read.label));
  return { kind: 'bytes', bytes: read.bytes };
}

/**
 * The package document named by the container's **first** `<rootfile>`, or
 * `null`.
 *
 * Only the first is consulted — a second, well-formed one does not rescue a
 * broken first. Every shape that names no usable package document lands on
 * `unresolvable_package` at the call site rather than `malformed_xml`:
 * `parseEpubXml` already accepted the document against the `container` root, so
 * it *is* a usable document that fails to name a package, which is exactly what
 * `unresolvable_package` says.
 *
 * `undefined` is never handed to `resolveHref` — the absent-attribute case is
 * decided here, before the call.
 */
function resolvePackageName(document: EpubXmlDocument): string | null {
  const rootfiles = childrenByLocalName(document.$, document.root, 'rootfiles')[0];
  if (!rootfiles) return null;
  const rootfile = childrenByLocalName(document.$, rootfiles, 'rootfile')[0];
  if (!rootfile) return null;
  const fullPath = attrByExactName(rootfile, 'full-path');
  if (fullPath === undefined) return null;
  const resolved = resolveHref(CONTAINER_ROOT, fullPath);
  return resolved.kind === 'entry' ? resolved.name : null;
}

/**
 * The package document's resolution base (EPUB 3.3 §5.2), normalised so a
 * root-level package yields `''` rather than `'.'`. `resolveHref` accepts either
 * spelling identically; the normalisation is stated rather than left to chance.
 */
function packageBaseDir(packageName: string): string {
  const directory = path.posix.dirname(packageName);
  return directory === '.' ? '' : directory;
}

/** Build the manifest and spine lookups once, for both consumers. */
function indexPackage(document: EpubXmlDocument, baseDir: string): EpubPackageIndex {
  const { $, root } = document;
  const manifest = childrenByLocalName($, root, 'manifest')[0];
  const items = manifest ? childrenByLocalName($, manifest, 'item') : [];
  const spine = childrenByLocalName($, root, 'spine')[0];
  const itemrefs = spine ? childrenByLocalName($, spine, 'itemref') : [];

  const itemsById = new Map<string, EpubXmlElement | null>();
  const itemsByName = new Map<string, EpubXmlElement[]>();
  for (const item of items) {
    const id = attrByExactName(item, 'id');
    if (id !== undefined) itemsById.set(id, itemsById.has(id) ? null : item);
    const href = attrByExactName(item, 'href');
    if (href === undefined) continue;
    const resolved = resolveHref(baseDir, href);
    if (resolved.kind !== 'entry') continue;
    const aliases = itemsByName.get(resolved.name);
    if (aliases) aliases.push(item);
    else itemsByName.set(resolved.name, [item]);
  }

  const spineIdrefs = new Set<string>();
  for (const itemref of itemrefs) {
    const idref = attrByExactName(itemref, 'idref');
    if (idref !== undefined) spineIdrefs.add(idref);
  }

  return { itemCount: items.length, items, spine, itemsById, itemsByName, spineIdrefs, itemrefs };
}

/**
 * Whether the **linear** spine resolves to a readable reading order — not merely
 * that it contains elements.
 *
 * For each `<itemref>` that is not `linear="no"`, the full chain must complete:
 * `idref` present → matches exactly one manifest `<item>` → that item's `href`
 * resolves to an archive entry → that entry exists. **At least one** must
 * complete; a mixed spine with one broken itemref and one that resolves passes
 * (#1989 Decision 6), consistent with the tag-soup stance elsewhere — partial
 * damage must not mark a readable book `invalid`. Individual unresolved
 * itemrefs are not reported anywhere in Phase 1.
 */
function hasReadableSpine(structure: {
  packageIndex: EpubPackageIndex;
  packageBaseDir: string;
  entriesByName: ReadonlyMap<string, ZipArchiveEntry>;
}): boolean {
  const { packageIndex, packageBaseDir: baseDir, entriesByName } = structure;
  for (const itemref of packageIndex.itemrefs) {
    if (attrByExactName(itemref, 'linear') === 'no') continue;
    const idref = attrByExactName(itemref, 'idref');
    if (idref === undefined) continue;
    const item = packageIndex.itemsById.get(idref);
    // Absent, or ambiguous because two items share the id — neither is "exactly one".
    if (!item) continue;
    const href = attrByExactName(item, 'href');
    if (href === undefined) continue;
    const resolved = resolveHref(baseDir, href);
    if (resolved.kind !== 'entry') continue;
    if (entriesByName.has(resolved.name)) return true;
  }
  return false;
}

/**
 * The structural pipeline, from the authoritative `fstat` through the linear
 * spine. 1.1e runs this identical function and then performs its optional reads,
 * so there is exactly one implementation.
 */
async function buildStructure(session: ZipSourceSession): Promise<EpubPipelineOutcome> {
  const archive = await openArchive(session);
  if (archive.kind === 'verdict') return archive;

  const entries = archive.entries;
  const entriesByName = new Map(entries.map((entry) => [entry.name, entry]));
  const budget = createInspectionBudget();

  const mimetype = await readMandatory(entriesByName.get(MIMETYPE_ENTRY), 'bad_mimetype', budget);
  if (mimetype.kind === 'verdict') return mimetype;
  // Content only. Position and compression method are deliberately not checked —
  // that is the epubcheck-strict rule and it rejects readable, Kindle-sendable
  // books (#1989 Decision 5).
  if (mimetype.bytes.toString('utf8').trim() !== EPUB_MEDIA_TYPE) {
    return verdict(invalid('bad_mimetype'));
  }

  const container = await readMandatory(entriesByName.get(CONTAINER_ENTRY), 'missing_container', budget);
  if (container.kind === 'verdict') return container;
  const containerDocument = parseEpubXml(container.bytes, 'container');
  if (containerDocument.kind === 'rejected') return verdict(invalid(containerDocument.code));

  const packageName = resolvePackageName(containerDocument);
  if (packageName === null) return verdict(invalid('unresolvable_package'));
  const packageEntry = entriesByName.get(packageName);
  if (!packageEntry) return verdict(invalid('unresolvable_package'));

  const read = await readMandatory(packageEntry, 'unresolvable_package', budget);
  if (read.kind === 'verdict') return read;
  const packageDocument = parseEpubXml(read.bytes, 'package');
  if (packageDocument.kind === 'rejected') return verdict(invalid(packageDocument.code));

  const baseDir = packageBaseDir(packageName);
  const packageIndex = indexPackage(packageDocument, baseDir);
  if (packageIndex.itemCount === 0) return verdict(invalid('empty_manifest'));

  const structure: EpubStructure = {
    source: session.source,
    entries,
    entriesByName,
    packageDocument,
    packageBaseDir: baseDir,
    packageIndex,
    budget,
  };
  if (!hasReadableSpine(structure)) return verdict(invalid('empty_spine'));
  return { kind: 'structure', structure };
}

// --- the encryption.xml classifier ------------------------------------------

/**
 * What one `<CipherReference>` contributed. Aggregated over the **whole**
 * document before anything is decided — there is no first-match shortcut.
 */
type EncryptionFinding = 'malformed' | 'unsafe' | 'drm';

/**
 * Media types are case-insensitive (RFC 9110 §8.3.1), so this one *value*
 * comparison folds case; element and attribute *names* stay case-sensitive per
 * 1.1b. A parameter suffix (`; charset=…`) is not expected on a font and is not
 * stripped, so `font/ttf; charset=utf-8` deliberately does not match.
 */
function isFontMediaType(value: string | undefined): boolean {
  return value !== undefined && FONT_MEDIA_TYPES.has(value.trim().toLowerCase());
}

/**
 * Whether an encrypted archive member is routine font obfuscation rather than
 * DRM. All three clauses must hold, and the predicate is **universally
 * quantified over every manifest item that resolves to this name** — not
 * existentially over the first match.
 *
 * That quantifier is what makes aliasing conservative and order-independent. A
 * parse-tolerated manifest may declare one archive entry twice — say `font-id`
 * as an unspined `font/ttf` and `chapter-id` as a spined
 * `application/xhtml+xml`. An existential reading would call that entry a font
 * through the first declaration and a spine document through the second, and
 * would flip verdict when the manifest order flipped.
 *
 * A `linear="no"` itemref counts as a spine reference here, unlike spine
 * *resolution*, which is scoped to linear ones: an encrypted ancillary content
 * document is still an encrypted content document.
 */
function isObfuscatedFont(name: string, structure: EpubStructure): boolean {
  if (!structure.entriesByName.has(name)) return false;
  const aliases = structure.packageIndex.itemsByName.get(name);
  if (!aliases || aliases.length === 0) return false;
  return aliases.every((item) => {
    if (!isFontMediaType(attrByExactName(item, 'media-type'))) return false;
    const id = attrByExactName(item, 'id');
    return id === undefined || !structure.packageIndex.spineIdrefs.has(id);
  });
}

/** Scan every reference in the document, collecting what each one contributed. */
function collectEncryptionFindings(
  document: EpubXmlDocument,
  structure: EpubStructure,
): Set<EncryptionFinding> {
  const { $, root } = document;
  const findings = new Set<EncryptionFinding>();
  for (const encryptedData of childrenByLocalName($, root, 'EncryptedData')) {
    // Two levels deep: `childrenByLocalName` is direct-children-only
    // (`xml.ts:161-170`), so a single-level lookup for `CipherReference` finds
    // nothing.
    const references = childrenByLocalName($, encryptedData, 'CipherData').flatMap((cipherData) =>
      childrenByLocalName($, cipherData, 'CipherReference'),
    );
    if (references.length === 0) {
      findings.add('malformed');
      continue;
    }
    for (const reference of references) {
      // `attrByExactName`: the EPUB specs define `URI` unprefixed, so a prefixed
      // spelling denotes a different attribute and reads as absent.
      const uri = attrByExactName(reference, 'URI');
      if (uri === undefined || uri === '') {
        findings.add('malformed');
        continue;
      }
      const resolved = resolveHref(CONTAINER_ROOT, uri);
      if (resolved.kind !== 'entry') findings.add('unsafe');
      else if (!isObfuscatedFont(resolved.name, structure)) findings.add('drm');
    }
  }
  return findings;
}

/**
 * Classify `META-INF/encryption.xml` by **what** is encrypted.
 *
 * Its presence alone has no effect on the verdict — it is parsed, not treated as
 * a signal. Verified against a real book: the first EPUB in the library carries
 * one with algorithm `http://ns.adobe.com/pdf/enc#RC`, but all four encrypted
 * resources are manifest-declared `.ttf` fonts and all 55 XHTML documents are
 * plaintext. Rejecting on the file's presence would mark a perfectly readable
 * book `invalid`.
 *
 * Aggregation is total and then ordered, most severe first. Document-conformance
 * problems outrank content problems because a document that does not conform is
 * one whose other references we cannot trust; `unsafe_entry_path` outranks
 * `drm_protected` because a traversal-bearing reference is an attack signal
 * worth surfacing over a DRM notice.
 *
 * `drm_protected` is **never downgraded to `invalid`**: fonts are decorative and
 * nothing this feature does needs them, while every other encrypted resource
 * means the companion artefact cannot be fully read, and the owner-facing
 * outcome for that is the DRM sentence.
 */
async function classifyEncryption(structure: EpubStructure): Promise<EpubValidation> {
  const entry = structure.entriesByName.get(ENCRYPTION_ENTRY);
  if (!entry) return AVAILABLE;

  const read = await structure.budget.read(entry, MAX_XML_BYTES);
  if (read.kind === 'failed') return fromReadFailure(read.label);
  const document = parseEpubXml(read.bytes, 'encryption');
  if (document.kind === 'rejected') return invalid(document.code);

  const findings = collectEncryptionFindings(document, structure);
  if (findings.has('malformed')) return invalid('malformed_xml');
  if (findings.has('unsafe')) return invalid('unsafe_entry_path');
  if (findings.has('drm')) return DRM_PROTECTED;
  return AVAILABLE;
}

// --- the one public entry point ---------------------------------------------

/**
 * Run the pre-open checks and the structural pipeline over `filePath`, then hand
 * the outcome to `onOutcome`.
 *
 * **Module-private**, and deliberately so. This is the seam 1.1e's `inspectEpub`
 * reuses — it lands in *this* module, beside `validateEpub`, and calls this
 * function; `extract.ts` then owns only the optional-read helpers that take what
 * they need. That keeps the pipeline at exactly one implementation without any
 * of it becoming reachable from outside.
 *
 * It takes a continuation rather than returning the structure so that no
 * structure can outlive the open: 1.1c owns the handle inside `withZipSource`'s
 * callback and closes it in a `finally` on every exit, including a thrown error.
 * The continuation shape alone is not a *guarantee* — the return type is
 * unconstrained, so `pipeline(path, async (outcome) => outcome)` would smuggle
 * the structure past the close. Privacy is what closes that: the only two call
 * sites are in this file, and neither returns the outcome.
 *
 * Every byte read after the open comes from that one handle, via
 * `session.source` or `entry.read(cap)`. No code path here re-opens the archive
 * by pathname, and this module calls `node:fs/promises`' `open` nowhere.
 */
async function runEpubPipeline<T>(
  filePath: string,
  onOutcome: (outcome: EpubPipelineOutcome) => Promise<T>,
): Promise<T> {
  const preOpen = await preOpenRejection(filePath);
  if (preOpen) return onOutcome(verdict(preOpen));
  return withZipSource(filePath, async (session) => onOutcome(await buildStructure(session)));
}

/**
 * Structurally validate a companion `.epub`.
 *
 * The pipeline, in order: `lstat` → regular-file → `MAX_ARCHIVE_BYTES` →
 * `withZipSource` → the `fstat` re-check → the four-byte signature →
 * `preflightAndOpen()` → its rejected/failed arms → the ZIP-encryption-bit scan
 * → `mimetype` → `META-INF/container.xml` → package resolution and parse →
 * manifest → linear spine → the `encryption.xml` classifier. **Precedence is
 * that order**, so a file that is both structurally broken and encrypted returns
 * the structural code: an empty spine plus a DRM'd `encryption.xml` is
 * `empty_spine`, because a document we cannot parse is not one we can make an
 * encryption claim about. The bit scan is the exception by position — it sits
 * before the `mimetype` read and therefore wins over everything after it.
 *
 * This exists as a separate function from 1.1e's `inspectEpub` because the
 * reconciler's six-hourly sweep needs only the status and must not hold up to
 * 8 MiB of cover bytes per book, while the owner panel wants everything in one
 * pass.
 *
 * **The only export in this module** — `inspectEpub` will be the second and
 * last. Everything else here is private: there is no context type to name, no
 * handle to own, and nothing for a caller to close (#1989 Decision 1).
 */
export async function validateEpub(filePath: string): Promise<EpubValidation> {
  return runEpubPipeline(filePath, async (outcome) =>
    outcome.kind === 'verdict' ? outcome.validation : classifyEncryption(outcome.structure),
  );
}

// --- the optional reads ------------------------------------------------------

/**
 * The package view `extract.ts` asks for, assembled from the private structure.
 *
 * Assembling it here rather than handing `extract.ts` an `EpubStructure` is what
 * keeps the structure unnamed outside this module: `extract.ts` declares its own
 * narrow interfaces, this satisfies them at the call site, and no private type
 * appears in any export (#1990 Decision 2).
 */
function packageView(structure: EpubStructure): EpubPackageView {
  return {
    document: structure.packageDocument,
    baseDir: structure.packageBaseDir,
    items: structure.packageIndex.items,
    itemsById: structure.packageIndex.itemsById,
    spine: structure.packageIndex.spine,
  };
}

/** The archive capability, bound to this call's one budget in its optional form. */
function optionalReader(structure: EpubStructure): EpubOptionalReader {
  return {
    entry: (name) => structure.entriesByName.get(name),
    read: (entry, ceiling) => structure.budget.readOptional(entry, ceiling),
  };
}

/**
 * The optional reads, in their frozen order, over the budget the mandatory reads
 * left behind.
 *
 * **TOC first, then the cover** — and the order is a decision, not an accident.
 * Because the budget is shared, a nav and a cover that are each within their own
 * caps can jointly exceed what remains, so an unspecified order would make
 * `{ toc, cover: null }` and `{ toc: null, cover }` equally compliant for the
 * same file: a non-deterministic public result. The TOC goes first because it is
 * the smaller read and feeds the plan's named consumer, the chapter count; the
 * cover is the largest optional read and the most expendable.
 *
 * Metadata is not an optional read — it consumes no budget and cannot fail — so
 * its position here says nothing.
 */
async function inspectStructure(structure: EpubStructure): Promise<EpubInspection> {
  const validation = await classifyEncryption(structure);
  if (validation.status !== 'available') return validation;

  const view = packageView(structure);
  const reader = optionalReader(structure);
  const toc = await extractEpubToc(view, reader);
  const cover = await extractEpubCover(view, reader);
  return { status: 'available', metadata: extractEpubMetadata(view), toc, cover };
}

/**
 * Structurally validate a companion `.epub` **and** read its metadata, table of
 * contents, and cover.
 *
 * The pipeline is 1.1d's, run whole and re-implemented nowhere: the identical
 * preflight, the identical structural checks in the identical precedence, and
 * the identical `encryption.xml` classifier. Every non-`available` outcome is
 * returned unchanged with no optional read attempted, so this and `validateEpub`
 * cannot disagree about a book's status.
 *
 * **One call is one open is one budget.** The archive is opened once and bounded
 * by `MAX_ARCHIVE_BYTES` and `MAX_INSPECTION_BYTES` for this call alone; there is
 * no cross-call budget and no context to carry one. A caller that validates and
 * then inspects opens twice and is bounded twice.
 *
 * **An optional read never changes the status** — see `extract.ts` for the
 * disposition rule and its reasoning. Filesystem errors remain the exception and
 * still propagate: a `throw` classification ignores the call site.
 *
 * The second and last export in this module (#1989 Decision 1).
 */
export async function inspectEpub(filePath: string): Promise<EpubInspection> {
  return runEpubPipeline(filePath, async (outcome) =>
    outcome.kind === 'verdict' ? outcome.validation : inspectStructure(outcome.structure),
  );
}
