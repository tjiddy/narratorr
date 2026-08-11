/**
 * Shared type-aware RuleTester cases for no-direct-duplicate-check.
 *
 * Not a `.test.js`, so `vitest.config.ts`'s `eslint-rules/**\/*.test.js` glob does not collect it.
 * Both entries — `no-direct-duplicate-check.test.js` (ambient parser mode) and
 * `no-direct-duplicate-check.single-run.test.js` (forced single-run) — call `runSharedCases`, so
 * coverage cannot drift between the two modes.
 *
 * The rule reads `parserServices`, so every case needs a real TS program and a `filename` that
 * EXISTS on disk and is included by the fixture tsconfig. A virtual filename fails to parse, and the
 * case then either reds for the wrong reason or — because the rule bails when services are absent —
 * silently passes as valid. The invalid block below is what proves the type wiring is live: if it
 * went dead, those cases would stop reporting and the suite reds.
 *
 * `projectService: true`, NOT `project` (#2239). In single-run mode — which typescript-eslint infers
 * whenever `CI === 'true'` — the parser counts `parseAndGenerateServices` calls per `filePath` and,
 * from the second call for the same path onwards, abandons the ahead-of-time project program for a
 * one-file `createIsolatedProgram`. That is correct for ESLint's autofix cycle and wrong for a
 * RuleTester suite, where eleven cases deliberately share the `caller.ts` filename: in the isolated
 * program the injected `./book.service.js` import resolves to nothing, and TypeScript crashes with
 * `Cannot read properties of undefined (reading 'includes')` while naming the module symbol. The
 * isolated-program fallback is gated on `!parseSettings.projectService`, so the language service
 * path never takes it. `disallowAutomaticSingleRunInference` was rejected: it suppresses only the
 * CI inference, leaving the crash one `TSESTREE_SINGLE_RUN=true` away.
 *
 * No import cases here: imports are the config layer's job (eslint.config.js), and RuleTester runs
 * only the rule it is given, so an import case could never report.
 */
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import rule from './no-direct-duplicate-check.cjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(HERE, 'fixtures', 'no-direct-duplicate-check');
const fixture = (rel) => path.join(FIXTURE_ROOT, 'src', 'server', rel);

const CALLER = fixture('services/caller.ts');
const TEST_FILE = fixture('services/caller.test.ts');
const BOOK_SERVICE_SOURCE = readFileSync(fixture('services/book.service.ts'), 'utf8');
const SERVICE_IMPORT = "import { BookService, EventHistory, type CrudService } from './book.service.js';";
const INTAKE_IMPORT = "import { BookService } from '../book.service.js';";
const V1_IMPORT = "import { BookService } from '../../services/book.service.js';";

const error = (method) => [{ messageId: 'directDuplicateCheck', data: { method } }];

const valid = [
  // Over-reporting controls. These fail a rule that keys only on "declared on BookService"
  // without the method-name filter, or that keys on the receiver merely being Pick-shaped.
  {
    name: 'getById through a Pick receiver is unguarded (merge-eligibility / companion-ebook-gate shape)',
    filename: CALLER,
    code: `${SERVICE_IMPORT}
      export async function f(deps: { bookService: Pick<BookService, 'getById'> }) {
        return deps.bookService.getById(1);
      }`,
  },
  {
    name: 'getById through a direct BookService receiver is unguarded',
    filename: CALLER,
    code: `${SERVICE_IMPORT}
      export async function f(bookService: BookService) { return bookService.getById(1); }`,
  },
  {
    name: 'EventHistory.create resolves to a different declaration',
    filename: CALLER,
    code: `${SERVICE_IMPORT}
      export async function f(deps: { eventHistory: EventHistory }) {
        return deps.eventHistory.create({ kind: 'book_added' });
      }`,
  },
  {
    name: 'the generic crud-routes service.create(data) resolves to its own declaration',
    filename: CALLER,
    code: `${SERVICE_IMPORT}
      export async function f<T>(service: CrudService<T>, data: T) { return service.create(data); }`,
  },
  {
    // The series-add-all.service.ts:16 shape — it must need no exemption.
    name: 'a Pick<BookService, ...> TYPE ANNOTATION with no call is not a call',
    filename: CALLER,
    code: `${SERVICE_IMPORT}
      export interface AddAllDeps { bookService: Pick<BookService, 'findDuplicate' | 'create'> }
      export function forward(deps: AddAllDeps): AddAllDeps { return deps; }`,
  },

  {
    // The import-list.service.ts:216 shape — a whole BookService forwarded into `addBook`'s deps.
    name: 'a whole BookService forwarded into a deps object is not a call',
    filename: CALLER,
    code: `${SERVICE_IMPORT}
      export function forward(bookService: BookService) { return { bookService }; }`,
  },

  // Allowlist: the new home, the three other sanctioned production paths, and test files.
  {
    name: 'the call inside book-intake — the sanctioned home',
    filename: fixture('services/book-intake/decide-intake.ts'),
    code: `${INTAKE_IMPORT}
      export async function decideIntake(deps: { bookService: Pick<BookService, 'findDuplicate'> }) {
        return deps.bookService.findDuplicate({ title: 'x' });
      }`,
  },
  {
    // Fed back verbatim (#2238): the language service adopts each case's code for its filename, so
    // an inlined short redeclaration of this class would erase methods for every later case that
    // resolves through it. `projectService` keeps the program FRESH, not immutable. The file's own
    // `create` calls `this.createResolved`, which is the call this exemption exists for.
    name: 'book.service.ts own internal createResolved call',
    filename: fixture('services/book.service.ts'),
    code: BOOK_SERVICE_SOURCE,
  },
  {
    name: 'import-submission-runner transaction-owning create',
    filename: fixture('services/import-submission-runner.ts'),
    code: `${SERVICE_IMPORT}
      export async function f(bookService: BookService) { return bookService.createResolved({ title: 'x' }); }`,
  },
  {
    name: 'routes/v1/books.ts — deferred write path',
    filename: fixture('routes/v1/books.ts'),
    code: `${V1_IMPORT}
      export async function f(bookService: BookService) { return bookService.findDuplicate({ title: '' }); }`,
  },
  {
    name: 'a .test.ts file mocking findDuplicate — the seventh pattern',
    filename: TEST_FILE,
    code: `${SERVICE_IMPORT}
      export async function f(bookService: BookService) { return bookService.findDuplicate({ title: 'x' }); }`,
  },
];

const invalid = [
  // The Pick-receiver matrix. This is the set that decides whether the rule enforces anything:
  // a rule that resolves the RECEIVER's type and compares it to BookService reports on none of
  // these, and would pass a suite that only tested a direct receiver.
  {
    name: 'bare Pick<BookService, ...> parameter receiver',
    filename: CALLER,
    code: `${SERVICE_IMPORT}
      export async function f(bookService: Pick<BookService, 'findDuplicate'>) {
        return bookService.findDuplicate({ title: 'x' });
      }`,
    errors: error('findDuplicate'),
  },
  {
    name: 'nested deps.bookService receiver — the shape every deps-injected caller has',
    filename: CALLER,
    code: `${SERVICE_IMPORT}
      export async function f(deps: { bookService: Pick<BookService, 'findDuplicate'> }) {
        return deps.bookService.findDuplicate({ title: 'x' });
      }`,
    errors: error('findDuplicate'),
  },
  {
    name: 'aliased receiver from a Pick — a name-based rule misses this twice over',
    filename: CALLER,
    code: `${SERVICE_IMPORT}
      export async function f(deps: { bookService: Pick<BookService, 'create'> }) {
        const svc = deps.bookService;
        return svc.create({ title: 'x' });
      }`,
    errors: error('create'),
  },
  {
    name: 'this.bookService.createResolved through a Pick field',
    filename: CALLER,
    code: `${SERVICE_IMPORT}
      export class Runner {
        constructor(private bookService: Pick<BookService, 'createResolved'>) {}
        async run() { return this.bookService.createResolved({ title: 'x' }); }
      }`,
    errors: error('createResolved'),
  },

  // #2243 removed book-add-ladder.ts's exemption when `POST /api/books` moved onto `addBook`. The
  // fixture stays on disk and its case moves here rather than being deleted: an absent case leaves
  // the removal unpinned, and the suite would stay green if the exemption were ever restored.
  {
    name: 'book-add-ladder — the exemption #2243 removed',
    filename: fixture('services/book-add-ladder.ts'),
    code: `${SERVICE_IMPORT}
      export async function f(deps: { bookService: Pick<BookService, 'findDuplicate' | 'create'> }) {
        return deps.bookService.findDuplicate({ title: 'x' });
      }`,
    errors: error('findDuplicate'),
  },
  {
    name: 'book-add-resolved — the exemption #2246 removed',
    filename: fixture('services/book-add-resolved.ts'),
    code: `${SERVICE_IMPORT}
      export async function f(deps: { bookService: Pick<BookService, 'findDuplicate' | 'create'> }) {
        return deps.bookService.findDuplicate({ title: 'x' });
      }`,
    errors: error('findDuplicate'),
  },

  // Direct receivers, so both shapes stay pinned.
  {
    name: 'direct BookService receiver calling findDuplicate',
    filename: CALLER,
    code: `${SERVICE_IMPORT}
      export async function f(bookService: BookService) { return bookService.findDuplicate({ title: 'x' }); }`,
    errors: error('findDuplicate'),
  },
  {
    name: 'direct BookService receiver calling create',
    filename: CALLER,
    code: `${SERVICE_IMPORT}
      export async function f(bookService: BookService) { return bookService.create({ title: 'x' }); }`,
    errors: error('create'),
  },
];

/**
 * Registers the shared case set against the caller's Vitest `describe`/`it`. Everything parser-
 * related happens here rather than at module scope, so an entry that sets `TSESTREE_SINGLE_RUN`
 * before calling is guaranteed to have done so before the first parse — ESM hoists the import of
 * this module above that assignment.
 */
export function runSharedCases({ describe, it }) {
  RuleTester.describe = describe;
  RuleTester.it = it;

  // Under this pnpm layout only the root `typescript-eslint` parser resolves here.
  const ruleTester = new RuleTester({
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        projectService: true,
        tsconfigRootDir: FIXTURE_ROOT,
      },
    },
  });

  ruleTester.run('no-direct-duplicate-check', rule, { valid, invalid });
}
