/**
 * Type-aware RuleTester suite for no-direct-duplicate-check.
 *
 * The rule reads `parserServices`, so every case needs a real TS program: `parserOptions.project`
 * plus a `filename` that EXISTS on disk and is included by the fixture tsconfig. A virtual filename
 * fails to parse, and the case then either reds for the wrong reason or — because the rule bails
 * when services are absent — silently passes as valid. The invalid block below is what proves the
 * type wiring is live: if it went dead, those cases would stop reporting and the suite reds.
 *
 * No import cases here: imports are the config layer's job (eslint.config.js), and RuleTester runs
 * only the rule it is given, so an import case could never report.
 */
import { describe, it, expect } from 'vitest';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import rule from './no-direct-duplicate-check.cjs';

// Wire RuleTester into Vitest so each case reports independently.
RuleTester.describe = describe;
RuleTester.it = it;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(HERE, 'fixtures', 'no-direct-duplicate-check');
const fixture = (rel) => path.join(FIXTURE_ROOT, 'src', 'server', rel);

// Under this pnpm layout only the root `typescript-eslint` parser resolves here.
const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      project: './tsconfig.json',
      tsconfigRootDir: FIXTURE_ROOT,
    },
  },
});

const CALLER = fixture('services/caller.ts');
const TEST_FILE = fixture('services/caller.test.ts');
const BOOK_SERVICE_SOURCE = readFileSync(fixture('services/book.service.ts'), 'utf8');
const SERVICE_IMPORT = "import { BookService, EventHistory, type CrudService } from './book.service.js';";
const INTAKE_IMPORT = "import { BookService } from '../book.service.js';";
const V1_IMPORT = "import { BookService } from '../../services/book.service.js';";

const error = (method) => [{ messageId: 'directDuplicateCheck', data: { method } }];

ruleTester.run('no-direct-duplicate-check', rule, {
  valid: [
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

    // Allowlist: the new home, the five other sanctioned production paths, and test files.
    {
      name: 'the call inside book-intake — the sanctioned home',
      filename: fixture('services/book-intake/decide-intake.ts'),
      code: `${INTAKE_IMPORT}
        export async function decideIntake(deps: { bookService: Pick<BookService, 'findDuplicate'> }) {
          return deps.bookService.findDuplicate({ title: 'x' });
        }`,
    },
    {
      // Fed back verbatim: project mode keeps one program across cases, so redeclaring this class
      // inline would erase methods for every later case. The file's own `create` calls
      // `this.createResolved`, which is the call this exemption exists for.
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
      name: 'book-add-ladder — deferred write path',
      filename: fixture('services/book-add-ladder.ts'),
      code: `${SERVICE_IMPORT}
        export async function f(deps: { bookService: Pick<BookService, 'findDuplicate' | 'create'> }) {
          return deps.bookService.findDuplicate({ title: 'x' });
        }`,
    },
    {
      name: 'book-add-resolved — deferred write path',
      filename: fixture('services/book-add-resolved.ts'),
      code: `${SERVICE_IMPORT}
        export async function f(deps: { bookService: Pick<BookService, 'findDuplicate' | 'create'> }) {
          return deps.bookService.findDuplicate({ title: 'x' });
        }`,
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
  ],

  invalid: [
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
      name: 'nested deps.bookService receiver — the book-add-ladder.ts:68 shape',
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
  ],
});

// Path handling is separator-agnostic. A backslash filename cannot be a RuleTester case — it would
// not resolve to a real file in the TS program — so observe `create()` directly: it returns an
// empty visitor object for an exempt path and a live CallExpression visitor otherwise.
describe('exemption matching is separator-agnostic', () => {
  const visitorKeys = (filename) => Object.keys(rule.create({ filename, sourceCode: {} }));

  it.each([
    ['book.service.ts', 'C:\\repo\\src\\server\\services\\book.service.ts'],
    ['book-intake', 'C:\\repo\\src\\server\\services\\book-intake\\decide-intake.ts'],
    ['routes/v1/books.ts', 'C:\\repo\\src\\server\\routes\\v1\\books.ts'],
    ['a test file', 'C:\\repo\\src\\server\\services\\caller.test.ts'],
  ])('exempts a backslash-separated %s', (_label, filename) => {
    expect(visitorKeys(filename)).toEqual([]);
  });

  it('still watches a backslash-separated NON-exempt path', () => {
    expect(visitorKeys('C:\\repo\\src\\server\\services\\match-job.helpers.ts')).toEqual(['CallExpression']);
  });

  it('watches the same path spelled with forward slashes', () => {
    expect(visitorKeys('/repo/src/server/services/match-job.helpers.ts')).toEqual(['CallExpression']);
  });
});
