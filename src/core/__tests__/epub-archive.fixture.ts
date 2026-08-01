/**
 * Fixture barrel for the companion-EPUB read path. **This is the import path** —
 * every consumer uses `import * as F from '.../epub-archive.fixture.js'` (or a named
 * import from it), and keeping that stable is why the barrel exists.
 *
 * Split in #2003: this file had reached 396 of the repo's 400-line `max-lines` cap,
 * which counts code only, so it read as 629 lines while lint saw 396. Four lines of
 * headroom meant the next fixture shape added would have failed lint and blocked
 * `pnpm verify` for a change that had nothing to do with EPUBs.
 *
 * The two halves were already separated by a comment banner and had no shared
 * concern, so they became two files:
 *
 * - `epub-zip.fixture.ts`  — ZIP/archive byte plumbing (`buildArchive`, `patchArchive`,
 *                            `listCentralDirectory`, `forgeZip64Tail`, offsets, spans).
 * - `epub-book.fixture.ts` — EPUB document XML (`containerXml`, `packageXml`,
 *                            `metadataXml`, nav/NCX builders, `epubEntries`, `buildEpub`).
 *
 * The dependency runs book -> zip only (`buildEpub` composes `buildArchive`). Never add
 * the reverse: this barrel re-exports both, so zip -> book would close a cycle.
 *
 * Export names across the two are disjoint, so `export *` cannot shadow.
 */
export * from './epub-zip.fixture.js';
export * from './epub-book.fixture.js';
