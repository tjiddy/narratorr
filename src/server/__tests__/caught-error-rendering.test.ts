import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

/**
 * #2604 AC14 — the closure check for the text chokepoint.
 *
 * `getErrorMessage` and `serializeError` are the two functions that turn a caught `unknown` into
 * text, and closing the passkey leak means closing THEM rather than enumerating publishers. That
 * invariant has one enforcement gap no reviewable prose can shut: a future `.message` read on a
 * caught value re-opens it silently. Three rounds of this issue's spec tried to carry the proof as
 * an inventory in the issue body and produced a defect in the artifact each time — a stale tally,
 * an extraction pattern that could not see a ternary, another that dropped `?.` receivers. So the
 * inventory lives here, where it is recomputed on every run and fails loudly instead of decaying.
 *
 * Modelled on `attach-single-home.test.ts`, whose doc comment states the principle: without it the
 * invariant is a comment rather than a contract.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

/**
 * The single exclusion, and its argument is different in kind from the one that was struck down:
 * an `Error` object cannot survive JSON transport, so the browser only ever receives the TEXT a
 * server chokepoint already rendered.
 */
const EXCLUDED_DIRS = ['src/client'] as const;

/**
 * Default-deny, DISCOVERED not enumerated: every top-level directory under `src/` except the
 * exclusions. Naming the included layers is what failed twice during grooming — once by excluding
 * `src/core` on an import-direction argument (import direction constrains module graphs, not
 * runtime values), once by silently omitting `src/shared` and `src/db` — and a hard-coded list
 * fails a third way: a future `src/worker` carrying a raw caught-error read would be invisible
 * while this suite stayed green. Discovery is what makes the scope self-maintaining.
 */
export function discoverScannedDirs(srcRoot: string): string[] {
  return readdirSync(srcRoot)
    .filter((name) => statSync(join(srcRoot, name)).isDirectory())
    .map((name) => `src/${name}`)
    .filter((dir) => !(EXCLUDED_DIRS as readonly string[]).includes(dir))
    .sort();
}

const SCANNED_DIRS = discoverScannedDirs(join(REPO_ROOT, 'src'));

/**
 * Reads that are safe, with the class and the one-line reason a reviewer needs to judge them.
 *
 *   a — inside a typed guard, or off a typed value that authors its own message. Narrowing to bare
 *       `Error` does NOT qualify: `DrizzleQueryError extends Error`.
 *   b — a Zod issue message. A `ZodError`, never a driver error.
 *   c — re-publication of a string another site already built with `getErrorMessage`, or a field
 *       of a structured record rather than a throwable. Safe BECAUSE of the chokepoint.
 *   m — a matcher, not a publisher: the text is tested, never rendered. `isUniqueViolation` is the
 *       reference shape (AC12 depends on it reading the original object directly).
 *
 * Class (d) — a genuine untyped bypass — must stay EMPTY. It is not represented here: a class-(d)
 * site is a bug, and the four found while writing this test were routed instead of listed.
 */
type SafeClass = 'a' | 'b' | 'c' | 'm';

/**
 * `[receiver, class, occurrences, reason]`.
 *
 * The occurrence count is load-bearing, not decoration: keying on `{file, receiver}` alone let one
 * vouched `error.message` in a file silently absolve every later `error.message` added to it, so
 * the guard's central claim — that adding a bypass reds the suite — was false. Counts are matched
 * EXACTLY in both directions, so adding a read reds until someone raises the number and re-justifies
 * it, and deleting one reds until the number comes back down.
 *
 * A count is chosen over per-occurrence line numbers deliberately: line numbers churn on every edit
 * above a read, which trains reviewers to bump the allowlist without reading it. A count is stable
 * under refactoring and moves only when the number of reads actually changes.
 */

const KNOWN_SAFE: Record<string, ReadonlyArray<readonly [string, SafeClass, number, string]>> = {
  'src/core/connectors/abs.ts': [['error.message', 'a', 1, 'inside a ConnectorRequestError guard']],
  'src/core/connectors/plex.ts': [['error.message', 'a', 1, 'inside a ConnectorRequestError guard']],
  'src/core/download-clients/blackhole.ts': [['mapped.message', 'a', 2, 'mapNetworkError output — an operator sentence it authored']],
  'src/core/download-clients/deluge.ts': [
    ['data.error.message', 'c', 4, 'a Deluge JSON-RPC error payload field'],
    ['error.message', 'm', 2, 'matches AddTorrentError text; never published'],
    ['parsed.error.issues[0]?.message', 'b', 4, 'Zod response parse'],
  ],
  'src/core/download-clients/errors.ts': [['error.message', 'm', 2, 'isTimeoutError predicate; never published']],
  'src/core/download-clients/nzbget.ts': [
    ['<expr>.message', 'a', 1, '(error as Error).message inside an isTimeoutError guard'],
    ['parsed.error.issues[0]?.message', 'b', 2, 'Zod response parse'],
    ['parsed.error.message', 'b', 1, 'Zod response parse'],
  ],
  'src/core/download-clients/qbittorrent.ts': [
    ['error.message', 'm', 2, 'matches an HTTP 409 add-torrent response; never published'],
    ['parsed.error.issues[0]?.message', 'b', 2, 'Zod response parse'],
  ],
  'src/core/download-clients/retry.ts': [['<expr>.message', 'a', 1, '(lastError as Error).message inside an isTimeoutError guard']],
  'src/core/download-clients/sabnzbd.ts': [
    ['<expr>.message', 'a', 1, '(error as Error).message inside an isTimeoutError guard'],
    ['parsed.error.issues[0]?.message', 'b', 5, 'Zod response parse'],
  ],
  'src/core/download-clients/transmission.ts': [['parsed.error.issues[0]?.message', 'b', 3, 'Zod response parse']],
  'src/core/import-lists/format-zod-error.ts': [['issue?.message', 'b', 1, 'a Zod issue, by construction']],
  'src/core/import-lists/hardcover-provider.ts': [
    ['failure.message', 'c', 1, 'a typed HardcoverFetchFailure record'],
    ['outcome.message', 'c', 1, 'a typed fetch outcome union'],
    ['parsed.data.errors[0]!.message', 'c', 2, 'a GraphQL error payload field'],
  ],
  'src/core/indexers/errors.ts': [['error.message', 'm', 1, 'isProxyRelatedError predicate; never published']],
  'src/core/indexers/fetch.ts': [
    ['data.message', 'c', 1, 'a FlareSolverr response field'],
    ['parsed.error.issues[0]?.message', 'b', 1, 'Zod response parse'],
  ],
  'src/core/indexers/myanonamouse.ts': [
    ['error.message', 'a', 1, 'inside IndexerAuthError / IndexerError guards; the tail calls getErrorMessage'],
    ['parsed.error.issues[0]?.message', 'b', 2, 'Zod response parse'],
  ],
  'src/core/indexers/proxy.ts': [['parsed.error.issues[0]?.message', 'b', 1, 'Zod response parse']],
  'src/core/indexers/solver-diagnosis.ts': [['<expr>.message', 'c', 1, "reads this module's own diagnosis record"]],
  'src/core/metadata/audible.ts': [
    ['parsed.error.issues[0]?.message', 'b', 1, 'Zod response parse'],
    ['r.message', 'c', 1, 'a provider outcome union field'],
  ],
  'src/core/metadata/audnexus.ts': [
    ['parsed.error.issues[0]?.message', 'b', 1, 'Zod response parse'],
    ['r.message', 'c', 1, 'a provider outcome union field'],
  ],
  'src/core/metadata/hardcover.ts': [
    ['parsed.data.errors[0]!.message', 'c', 3, 'a GraphQL error payload field'],
    ['parsed.error.issues[0]?.message', 'b', 3, 'Zod response parse'],
  ],
  'src/core/notifiers/discord.ts': [
    ['payload.error.message', 'c', 1, 'the typed notification payload built by import-side-effects'],
    ['payload.health.message', 'c', 2, 'a health-check payload field'],
  ],
  'src/core/notifiers/script.ts': [
    ['error.message', 'a', 1, 'a typed spawn error from child_process'],
    ['payload.error.message', 'c', 1, 'the typed notification payload'],
    ['payload.health.message', 'c', 2, 'a health-check payload field'],
  ],
  'src/core/notifiers/webhook.ts': [
    ['payload.error?.message', 'c', 1, 'the typed notification payload'],
    ['payload.health?.message', 'c', 1, 'a health-check payload field'],
  ],
  'src/core/utils/download-url.ts': [['mapped.message', 'a', 1, 'mapNetworkError output — an operator sentence it authored']],
  'src/core/utils/encode-strategy.ts': [['n.message', 'c', 1, 'an EncodeNotice field, not an error']],
  'src/core/utils/map-network-error.ts': [
    ['cause.message', 'a', 2, 'the typed transport cause this module is mapping'],
    ['error.message', 'm', 1, "matches TypeError('fetch failed'); never published"],
  ],
  'src/server/config.ts': [['parsed.error.message', 'b', 1, 'Zod parse of the boot env schema']],
  'src/server/plugins/error-handler.ts': [
    ['error.message', 'a', 5, 'registry-mapped typed errors and Fastify FST_ envelopes; both untyped log arms are routed'],
  ],
  'src/server/routes/auth.ts': [['error.message', 'a', 4, 'inside the auth service typed-error guards']],
  'src/server/routes/book-import-files.ts': [['containment.message', 'c', 1, 'a containment verdict record, not a throwable']],
  'src/server/routes/books.ts': [['error.message', 'a', 1, 'inside a typed guard']],
  'src/server/routes/bulk-operations.ts': [['error.message', 'a', 4, 'guarded on the typed bulk-operation error codes']],
  'src/server/routes/crud-routes.ts': [['result.message', 'c', 2, 'service test result-union message']],
  'src/server/routes/download-clients.ts': [['resolution.message', 'c', 1, 'sentinel-resolution result union']],
  'src/server/routes/import-lists.ts': [
    ['outcome.message', 'c', 1, 'import-list run outcome union'],
    ['resolution.message', 'c', 1, 'sentinel-resolution result union'],
  ],
  'src/server/routes/import-submissions.ts': [
    ['bodyResult.error.message', 'b', 1, 'Zod body parse'],
    ['err.message', 'a', 1, 'inside a typed submission-error guard'],
    ['parsed.error.message', 'b', 4, 'Zod query/body parse'],
    ['queryResult.error.message', 'b', 2, 'Zod query parse'],
  ],
  'src/server/routes/library-scan.ts': [['error.message', 'a', 2, 'inside ScanInProgressError / LibraryPathError guards']],
  'src/server/routes/prowlarr-compat.ts': [['result.message', 'c', 2, 'indexer test result union']],
  'src/server/routes/search.ts': [
    ['error.message', 'a', 1, 'inside isBookMissingRefusal — the typed refusal authors its own sentence'],
  ],
  'src/server/routes/system.ts': [['error.message', 'a', 2, 'inside typed guards']],
  'src/server/routes/v1/_helpers.ts': [
    ['error.message', 'a', 4, 'V1NotFoundError and validation branches; the untyped arm routes both log slots'],
  ],
  'src/server/routes/v1/books.ts': [['mapped.message', 'c', 1, 'a mapped lookup-outcome envelope, not a throwable']],
  'src/server/services/book-deletion.service.ts': [['error.message', 'a', 1, 'inside a PathOutsideLibraryError guard']],
  'src/server/services/chapter-corroboration.ts': [['outcome.message', 'c', 1, 'chapter-lookup outcome union']],
  'src/server/services/connector-refresh-queue.ts': [['result.message', 'c', 4, 'connector refresh result union']],
  'src/server/services/connector.service.ts': [['error.message', 'a', 1, 'inside a typed connector-validation guard']],
  'src/server/services/download-client.service.ts': [['result.message', 'c', 1, 'adapter test result union']],
  'src/server/services/download-resolve-adapter-url.ts': [
    ['error.cause.message', 'a', 1, 'typed IndexerError parameter'],
    ['error.message', 'a', 1, 'typed IndexerError parameter; it authors its own message'],
  ],
  'src/server/services/health-check.service.ts': [
    ['breaker?.message', 'c', 1, 'an IndexerBreakerHealth field'],
    ['delivery.message', 'c', 1, 'a notifier delivery record field'],
    ['result.message', 'c', 3, 'health-check result union'],
  ],
  'src/server/services/import-orchestration.helpers.ts': [['containment.message', 'c', 1, 'a containment verdict record']],
  'src/server/services/import-queue-worker.ts': [['parsed.message', 'c', 1, 'JSON.parse of an already-persisted error string']],
  'src/server/services/import.service.ts': [['containment.message', 'c', 1, 'a containment verdict record']],
  'src/server/services/indexer.service.ts': [['result.message', 'c', 2, 'indexer test result union']],
  'src/server/services/merge.service.ts': [['error.message', 'a', 1, 'inside a MergeError guard; the else arm serializes']],
  'src/server/services/metadata-fix-match.ts': [['result.message', 'c', 1, 'fix-match result union']],
  'src/server/services/metadata.service.ts': [['error.message', 'a', 1, 'inside an instanceof TransientError branch']],
  'src/server/services/notifier.service.ts': [['result.message', 'c', 4, 'notifier test result union']],
  'src/server/services/search-grab-attempt.ts': [['skip.message', 'c', 1, "a literal from this module's own GRAB_SKIPS table"]],
  'src/server/utils/hardcover-error.ts': [['error.message', 'a', 6, 'typed HardcoverError branch; the untyped tail calls getErrorMessage']],
  'src/server/utils/post-processing-script.ts': [['error.message', 'a', 1, "execFile's typed callback error, from child_process"]],
  'src/server/utils/sentinel-resolver.ts': [['error.message', 'a', 1, 'inside a SentinelOnNonSecretFieldError guard']],
  'src/server/utils/short-error-text.ts': [
    ['s.cause?.message', 'c', 1, 'reads an already-serialized record'],
    ['s.message', 'c', 1, 'reads an already-serialized record'],
  ],
  'src/shared/db-error.ts': [['value.message', 'c', 1, 'the describer itself — one half of the chokepoint']],
  'src/shared/error-message.ts': [
    ['cause?.message', 'c', 2, 'getErrorMessageWithCause — routed through describeDbError first'],
    ['error.message', 'c', 3, 'the chokepoint itself, plus isUniqueViolation — load-bearing per AC12'],
  ],
  'src/shared/notification-events.ts': [
    ['h.message', 'c', 2, 'a health-check payload field'],
    ['payload.error.message', 'c', 1, 'the typed SSE payload built by import-side-effects'],
  ],
  'src/shared/schemas/connector.ts': [['field.message', 'b', 1, 'Zod field config, not an error']],
  'src/shared/schemas/download-client.ts': [['field.message', 'b', 1, 'Zod field config, not an error']],
  'src/shared/schemas/import-list.ts': [['field.message', 'b', 1, 'Zod field config, not an error']],
  'src/shared/schemas/indexer.ts': [['field.message', 'b', 1, 'Zod field config, not an error']],
  'src/shared/schemas/notifier.ts': [['field.message', 'b', 1, 'Zod field config, not an error']],
};

// ---------------------------------------------------------------------------------------------
// Extraction. Constrains NOTHING but the property name: a read can appear in any expression
// context (`return error.message`, a template interpolation, a call argument, a ternary), and every
// pattern that anchored on the surrounding syntax reported a false clean.

/** Blanks comments and string bodies so only CODE is scanned; template interpolations survive. */
export function stripNonCode(source: string): string {
  let out = '';
  let i = 0;
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      const nl = source.indexOf('\n', i);
      const end = nl === -1 ? source.length : nl;
      out += blank(source.slice(i, end));
      i = end;
      continue;
    }
    if (two === '/*') {
      const close = source.indexOf('*/', i + 2);
      const end = close === -1 ? source.length : close + 2;
      out += blank(source.slice(i, end));
      i = end;
      continue;
    }
    const quote = source[i];
    if (quote === '"' || quote === "'" || quote === '`') {
      let j = i + 1;
      let body = '';
      while (j < source.length) {
        if (source[j] === '\\') { body += '  '; j += 2; continue; }
        if (source[j] === quote) break;
        if (quote === '`' && source.slice(j, j + 2) === '${') {
          let depth = 1;
          let k = j + 2;
          while (k < source.length && depth > 0) {
            if (source[k] === '{') depth++;
            else if (source[k] === '}') depth--;
            k++;
          }
          body += source.slice(j, k);
          j = k;
          continue;
        }
        body += source[j] === '\n' ? '\n' : ' ';
        j++;
      }
      out += quote + body + (source[j] === quote ? quote : '');
      i = j + 1;
      continue;
    }
    out += quote;
    i++;
  }
  return out;
}

/** A member chain ending in `.message`, matching `?.` and `!.` receivers as well as plain ones. */
const CHAIN_RE =
  /[A-Za-z_$][A-Za-z0-9_$]*(?:\s*(?:\?\.|!\.|\.)\s*[A-Za-z_$][A-Za-z0-9_$]*|\s*\[[^\]\n]*\]|!)*\s*(?:\?\.|!\.|\.)\s*message\b/g;
const ANY_MESSAGE_RE = /\.message\b/g;

/**
 * There is NO "routed" escape hatch, and its absence is the point.
 *
 * An earlier version of this guard marked a read as routed when its LINE contained a
 * `getErrorMessage(` / `serializeError(` call. That is unsound twice over. Structurally, routing a
 * value through a chokepoint means not reading `.message` at all — a `.message` read IS the bypass,
 * so "routed read" describes nothing. And same-line presence blessed the exact leak shape
 * `getErrorMessage(error) || error.message`, where the right-hand fallback publishes the raw text.
 *
 * It was not hypothetical: the escape hid three live sites where a serialized record sat in Pino's
 * merge slot while a raw `error.message` sat in its MESSAGE slot, which Pino writes to `msg` — the
 * untyped arms of `error-handler.ts` and `v1/_helpers.ts` were disclosing bound params. Every read
 * is now either absent from the source or carries an allowlist entry.
 */
export interface MessageRead {
  file: string;
  line: number;
  receiver: string;
}

export function extractMessageReads(file: string, source: string): MessageRead[] {
  const reads: MessageRead[] = [];
  stripNonCode(source).split('\n').forEach((line, index) => {
    const spans: Array<[number, number]> = [];
    for (const match of line.matchAll(CHAIN_RE)) {
      spans.push([match.index, match.index + match[0].length]);
      reads.push({ file, line: index + 1, receiver: match[0].replace(/\s+/g, '') });
    }
    // Anything the chain pattern could not shape — `(error as Error).message`, `f({...}).message` —
    // is still a read, and is recorded rather than dropped.
    for (const match of line.matchAll(ANY_MESSAGE_RE)) {
      if (spans.some(([start, end]) => match.index >= start && match.index < end)) continue;
      reads.push({ file, line: index + 1, receiver: '<expr>.message' });
    }
  });
  return reads;
}

function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...productionFiles(path));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.includes('.fixture.')) out.push(path);
  }
  return out;
}

function scanRepo(): MessageRead[] {
  return SCANNED_DIRS.flatMap((dir) =>
    productionFiles(join(REPO_ROOT, dir)).flatMap((path) => {
      const rel = relative(REPO_ROOT, path).split('\\').join('/');
      return extractMessageReads(rel, readFileSync(path, 'utf-8'));
    }),
  );
}

const ALL_READS = scanRepo();

/** `file::receiver` -> live occurrence count, the shape the allowlist is matched against. */
function tally(reads: MessageRead[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const read of reads) {
    const key = `${read.file}::${read.receiver}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

const LIVE = tally(ALL_READS);

describe('every caught error is rendered through a chokepoint (AC14 Rule 1)', () => {
  it('scans a non-trivial surface — the inventory is not vacuously empty', () => {
    expect(ALL_READS.length).toBeGreaterThan(80);
    for (const dir of SCANNED_DIRS) {
      // `src/db` legitimately has no `.message` read; assert coverage, not hits.
      expect(productionFiles(join(REPO_ROOT, dir)).length).toBeGreaterThan(0);
    }
  });

  it('excludes only the client, and says why in code', () => {
    expect(EXCLUDED_DIRS).toEqual(['src/client']);
    expect(SCANNED_DIRS).not.toContain('src/client');
  });

  it('discovers today\'s runtime directories rather than hard-coding them', () => {
    // Every non-client top-level directory is present because it EXISTS, not because it is named.
    expect(SCANNED_DIRS).toEqual(['src/core', 'src/db', 'src/server', 'src/shared']);
    const named = readdirSync(join(REPO_ROOT, 'src'))
      .filter((name) => statSync(join(REPO_ROOT, 'src', name)).isDirectory())
      .map((name) => `src/${name}`);
    expect([...SCANNED_DIRS, ...EXCLUDED_DIRS].sort()).toEqual(named.sort());
  });

  /** `file::receiver` -> allowed occurrence count, from the curated allowlist. */
  const ALLOWED = new Map<string, number>(
    Object.entries(KNOWN_SAFE).flatMap(([file, entries]) =>
      entries.map(([receiver, , occurrences]) => [`${file}::${receiver}`, occurrences] as const),
    ),
  );

  // Both directions from one comparison: an unlisted read, a read count above what was vouched for,
  // and an allowlist entry whose reads have gone away all surface as the same kind of mismatch.
  it('matches every live read against a vouched-for occurrence count', () => {
    const keys = new Set([...LIVE.keys(), ...ALLOWED.keys()]);
    const mismatches = [...keys]
      .map((key) => ({ key, live: LIVE.get(key) ?? 0, allowed: ALLOWED.get(key) ?? 0 }))
      .filter(({ live, allowed }) => live !== allowed)
      .map(({ key, live, allowed }) => `${key} — ${live} live read(s), ${allowed} allowlisted`);

    expect(mismatches).toEqual([]);
  });

  // A second `error.message` added to a file that already vouches for one is the exact shape the
  // previous `{file, receiver}` keying accepted silently.
  it('rejects an extra occurrence of an already-vouched receiver', () => {
    const [key, allowed] = [...ALLOWED.entries()][0]!;
    const inflated = new Map(LIVE);
    inflated.set(key, allowed + 1);

    const mismatches = [...inflated.keys()].filter((k) => (inflated.get(k) ?? 0) !== (ALLOWED.get(k) ?? 0));
    expect(mismatches).toEqual([key]);
  });

  it('gives every allowlist entry a class, a positive count, and a reason', () => {
    for (const [file, entries] of Object.entries(KNOWN_SAFE)) {
      for (const [receiver, safeClass, occurrences, reason] of entries) {
        expect(['a', 'b', 'c', 'm'], `${file} ${receiver}`).toContain(safeClass);
        expect(occurrences, `${file} ${receiver}`).toBeGreaterThan(0);
        expect(reason.length, `${file} ${receiver}`).toBeGreaterThan(10);
      }
    }
  });

  // The three sites AC6 edited, plus the fourth this scan found, must stay routed.
  it.each([
    'src/server/services/search-event-sink.ts',
    'src/server/services/search-pipeline.ts',
    'src/server/services/indexer-failure-state.ts',
    'src/core/metadata/hardcover.ts',
  ])('%s has no raw read of a caught value', (file) => {
    const listed = (KNOWN_SAFE[file] ?? []).map(([receiver]) => receiver);
    expect(listed).not.toContain('error.message');
    expect(listed).not.toContain('grabResult.error.message');
  });
});

describe('the boot catch does not print a raw error (AC7 structural half)', () => {
  // The runtime half cannot reach `main().catch` — it is a module-level side effect — so the call
  // shape is pinned here and the rendering is pinned by crash-logger.test.ts (T45).
  it('src/server/index.ts routes its crash through logCrash', () => {
    const source = readFileSync(join(REPO_ROOT, 'src/server/index.ts'), 'utf-8');
    // Code only: the comment at the call site names the shape it is avoiding.
    expect(stripNonCode(source)).not.toMatch(/console\s*\.\s*error\s*\(/);
    expect(source).toContain("logCrash('Failed to start server', err)");
  });

  it('src/db/migrate.ts renders its CLI failure rather than printing the object', () => {
    const source = readFileSync(join(REPO_ROOT, 'src/db/migrate.ts'), 'utf-8');
    expect(source).not.toMatch(/console\.error\('Migration failed:',\s*err\s*\)/);
    expect(source).toContain('getErrorMessage(err)');
  });
});

// ---------------------------------------------------------------------------------------------
// T43 — the guard is falsifiable. Every bullet is a shape some earlier version of this check
// provably missed, driven against fixture SOURCES so the cases live in the suite permanently
// rather than being a one-off manual procedure.

describe('the extraction sees every shape that defeated an earlier draft (T43)', () => {
  const reads = (source: string) => extractMessageReads('fixture.ts', source);

  it.each([
    ['a bare return in a catch', 'try { f(); } catch (error) { return error.message; }', 'error.message'],
    ['a template interpolation', 'try { f(); } catch (error) { throw new Error(`x ${error.message}`); }', 'error.message'],
    ['a call argument', 'try { f(); } catch (error) { report(error.message); }', 'error.message'],
    ['a ternary narrowed only to Error', "const m = error instanceof Error ? error.message : '';", 'error.message'],
    ['an optional-chained receiver', 'const m = breaker?.message ?? fallback;', 'breaker?.message'],
    ['a non-null-asserted receiver', 'const m = parsed.data.errors[0]!.message;', 'parsed.data.errors[0]!.message'],
    ['a parenthesised cast', 'const m = (error as Error).message;', '<expr>.message'],
  ])('reports %s', (_label, source, expected) => {
    expect(reads(source).map((r) => r.receiver)).toContain(expected);
  });

  it('does not report a comment or a string literal that merely mentions .message', () => {
    const source = ["// error.message is not a read", "const k = 'error.message';", 'const s = `a error.message b`;'].join('\n');
    expect(reads(source)).toEqual([]);
  });

  // F2's shape. An earlier draft asserted this line was fully "routed" and therefore exempt — the
  // right-hand fallback is precisely what publishes the raw params when the summary is empty.
  it('reports a raw fallback sitting beside a chokepoint call', () => {
    const source = 'const m = getErrorMessage(error) || error.message;';
    expect(reads(source).map((r) => r.receiver)).toEqual(['error.message']);
  });

  it('reports a raw read beside an unrelated chokepoint call on the same line', () => {
    const source = "log.error({ error: serializeError(error) }, error.message);";
    expect(reads(source).map((r) => r.receiver)).toEqual(['error.message']);
  });

  // The directory bullets are the structurally important ones: they test the SCOPE, which is the
  // parameter earlier drafts got wrong three separate ways.
  it.each(['src/core', 'src/shared', 'src/db'])('%s is inside the scanned surface', (dir) => {
    expect(SCANNED_DIRS).toContain(dir);
    // And a read placed there would be seen: the scanner walks the real tree, so assert it found files.
    expect(productionFiles(join(REPO_ROOT, dir)).length).toBeGreaterThan(0);
  });

  // The falsifiable half of F1: a sixth runtime layer must enter the scan with no edit here. Driven
  // against a temp tree, because the assertion is about a directory that does not exist yet.
  it('picks up a future top-level runtime directory without an edit', () => {
    const root = mkdtempSync(join(tmpdir(), 'caught-error-scope-'));
    try {
      for (const name of ['client', 'server', 'shared', 'worker']) mkdirSync(join(root, name));
      writeFileSync(join(root, 'notes.md'), 'files are not directories');

      const discovered = discoverScannedDirs(root);

      expect(discovered).toContain('src/worker');
      expect(discovered).not.toContain('src/client');
      expect(discovered).toEqual(['src/server', 'src/shared', 'src/worker']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a raw read living in that future directory', () => {
    // Scope discovery is only worth anything if the extractor then sees the read.
    expect(reads('export function h(e: unknown) { return (e as Error).message; }')).toHaveLength(1);
  });
});
