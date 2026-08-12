import { describe, expect, it } from 'vitest';
import { Linter, RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import rule from './no-raw-error-logging.cjs';

// Wire RuleTester into Vitest so each case reports independently.
RuleTester.describe = describe;
RuleTester.it = it;

// Under this pnpm layout only the root `typescript-eslint` parser resolves here.
// Untyped on purpose: the rule is purely syntactic, and a TS program would import
// the #2239 single-run crash class for no benefit.
const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  },
});

// Shared with the convergence checks below, so those assert against the same pins the
// RuleTester cases carry rather than a hand-copied restatement of them.
const FATAL_BARE_IDENTIFIER = {
  code: `
        try { foo(); } catch (err) {
          log.fatal(err, 'x');
        }
      `,
  output: `
        import { serializeError } from '../utils/serialize-error.js';

try { foo(); } catch (err) {
          log.fatal({ error: serializeError(err) }, 'x');
        }
      `,
};

const TRACE_BARE_IDENTIFIER = {
  code: `
        try { foo(); } catch (err) {
          log.trace(err, 'x');
        }
      `,
  output: `
        import { serializeError } from '../utils/serialize-error.js';

try { foo(); } catch (err) {
          log.trace({ error: serializeError(err) }, 'x');
        }
      `,
};

// Relative to cwd on purpose: a flat config's `files` globs do not match an absolute path
// outside the base path, and an unmatched file lints clean rather than erroring (#2280).
// `computeImportPath` returns the same fallback string for this spelling as for the absolute
// one the older cases use — coincidence, not design, so don't collapse the two.
const FIX_FILENAME = 'src/server/services/a.ts';
const CANONICAL_IMPORT = "import { serializeError } from '../utils/serialize-error.js';";

const objectCall = (objectSource, level = 'error') =>
  `try{f()}catch(e){log.${level}(${objectSource},'x')}`;
const importedObjectCall = (objectSource, level = 'error') =>
  `${CANONICAL_IMPORT}\n\n${objectCall(objectSource, level)}`;

// An object with exactly one matching property is the common case; the merge path must not
// leak into it. Shared so the single-pass pin and the converged pin are literally one string.
const SINGLE_MATCH_PINS = {
  'C21 an identifier under the error key': {
    code: objectCall('{error: e}'),
    output: importedObjectCall('{error: serializeError(e)}'),
  },
  'C21 an identifier under the err key': {
    code: objectCall('{err: e}'),
    output: importedObjectCall('{error: serializeError(e)}'),
  },
  // The control for AC2 row 3: withholding the *fold* must not withhold the rewrite.
  'C21 a member expression under the error key': {
    code: objectCall('{error: e.cause}'),
    output: importedObjectCall('{error: serializeError(e.cause)}'),
  },
};

ruleTester.run('no-raw-error-logging', rule, {
  valid: [
    {
      code: `
        try { foo(); } catch (error) {
          log.error({ error: serializeError(error) }, 'failed');
        }
      `,
    },
    // A member value is valid when its root is not a catch binding.
    {
      code: `
        const result = doSomething();
        log.error({ error: result.error }, 'failed');
      `,
    },
    // Plain variables are not catch sources.
    {
      code: `
        const message = 'oops';
        log.info({ error: message }, 'info');
      `,
    },
    // Constructed errors are not catch sources.
    {
      code: `
        const error = new Error('test');
        log.error({ error }, 'failed');
      `,
    },
    {
      code: `
        log.info('plain message');
      `,
    },
    {
      code: `
        log.error({ msg: 'plain' }, 'top-level');
      `,
    },
    // A bare local is valid when it is not traceable to a catch binding.
    {
      code: `
        const result = doSomething();
        log.error(result, 'failed');
      `,
    },
    // Bare calls whose callee is not `serializeError` are out of scope.
    {
      code: `
        try { foo(); } catch (err) {
          log.error(someOtherHelper(err), 'failed');
        }
      `,
    },
    {
      code: `
        try { foo(); } catch (err) {
          log.error({ err: serializeError(err) }, 'failed');
        }
      `,
    },
    // The `err` alias still requires a catch-sourced value.
    {
      code: `
        const someUnrelatedNonCatchVar = { code: 1 };
        log.warn({ err: someUnrelatedNonCatchVar }, 'msg');
      `,
    },

    // MemberExpression negative cases whose root is not a catch binding.

    {
      code: `
        async function run() {
          const result = await fn();
          if (result.error) log.warn({ error: result.error }, 'msg');
        }
      `,
    },
    {
      code: `
        async function run() {
          const refresh = await this.preSearchRefresh();
          log.warn({ error: refresh.error }, 'msg');
        }
      `,
    },
    // Computed access at any chain depth is out of scope.
    {
      code: `
        const key = 'foo';
        try { foo(); } catch (error) {
          log.error({ error: error[key] }, 'msg');
        }
      `,
    },
    {
      code: `
        const key = 'foo';
        try { foo(); } catch (error) {
          log.error({ error: error[key].message }, 'msg');
        }
      `,
    },
    {
      code: `
        const key = 'foo';
        try { foo(); } catch (error) {
          log.error({ error: error.cause[key] }, 'msg');
        }
      `,
    },
    // Call-result roots are out of scope.
    {
      code: `
        function getError() { return { foo: 1 }; }
        try { foo(); } catch (error) {
          log.error({ error: getError().foo }, 'msg');
        }
      `,
    },
    {
      code: `
        try { foo(); } catch (error) {
          log.error({ error: serializeError(error.cause) }, 'msg');
        }
      `,
    },
    {
      code: `
        log.warn({ error: 'plain string' }, 'msg');
      `,
    },

    // `logger` receiver symmetry with `log`.

    {
      code: `
        try { foo(); } catch (err) {
          logger.error({ error: serializeError(err) }, 'failed');
        }
      `,
    },
    {
      code: `
        const result = doSomething();
        logger.error({ error: result.error }, 'failed');
      `,
    },
    // Adding `logger` must not broaden the trigger beyond catch-traced values.
    {
      code: `
        const logger = { warn(x){} };
        const result = doSomething();
        logger.warn(result, 'x');
      `,
    },

    // Receiver and method scope.

    // The `fatal`/`trace` levels are in scope, but only under the same gates as every
    // other level: a catch-traced value, an allowlisted receiver, the first argument.

    {
      name: 'C1 log.fatal on a value that is not catch-traced',
      code: `
        const result = doSomething();
        log.fatal(result, 'x');
      `,
    },
    {
      name: 'C1 fatal on a receiver outside LOG_RECEIVERS',
      code: `
        try { foo(); } catch (err) {
          notALog.fatal(err, 'x');
        }
      `,
    },
    {
      name: 'C1 log.fatal with a plain object argument',
      code: `
        try { foo(); } catch (err) {
          log.fatal({ msg: 'plain' }, 'x');
        }
      `,
    },
    {
      name: 'C5 a fatal call with no arguments',
      code: `
        try { foo(); } catch (err) {
          log.fatal();
        }
      `,
    },
    {
      name: 'C6 the error is not the first argument of a fatal call',
      code: `
        try { foo(); } catch (err) {
          log.fatal('msg', err);
        }
      `,
    },
    {
      // The shape all five live `log.trace` sites use — this is what makes the AC1 audit's
      // zero a real zero rather than the rule failing to visit those calls.
      name: 'C1 log.trace with a string-literal first argument',
      code: `
        try { foo(); } catch (err) {
          log.trace('No completed downloads to import');
        }
      `,
    },
    {
      name: 'C2 receiver identifier is outside LOG_RECEIVERS',
      code: `
        try { foo(); } catch (err) {
          notALog.error(err, 'x');
        }
      `,
    },
    {
      name: 'C3 one-level member receiver whose property is not log/logger',
      code: `
        try { foo(); } catch (err) {
          a.b.error(err, 'x');
        }
      `,
    },
    {
      name: 'C5 a log call with no arguments',
      code: `
        try { foo(); } catch (err) {
          log.error();
        }
      `,
    },
    {
      name: 'C6 the error is not the first argument',
      code: `
        try { foo(); } catch (err) {
          log.error('msg', err);
        }
      `,
    },

    // Object-argument value shapes.

    {
      name: 'C7 a spread-only object has no error property to report',
      code: `
        try { foo(); } catch (e) {
          log.error({ ...e }, 'x');
        }
      `,
    },
    {
      name: 'C8 TSAsExpression value',
      code: `
        try { foo(); } catch (e) {
          log.error({ error: e as Error }, 'x');
        }
      `,
    },
    {
      name: 'C8 TSNonNullExpression value',
      code: `
        try { foo(); } catch (e) {
          log.error({ error: e! }, 'x');
        }
      `,
    },
    {
      name: 'C8 TSSatisfiesExpression value',
      code: `
        try { foo(); } catch (e) {
          log.error({ error: e satisfies unknown }, 'x');
        }
      `,
    },

    // Scope resolution.

    {
      name: 'C9 the innermost scope declaring the name wins over an outer catch',
      code: `
        try { foo(); } catch (e) {
          function inner(e) {
            log.error({ error: e }, 'x');
          }
          inner(1);
        }
      `,
    },
  ],

  invalid: [
    // Object-key raw values.

    {
      code: `
        try { foo(); } catch (error) {
          log.error({ error }, 'failed');
        }
      `,
      output: `
        import { serializeError } from '../utils/serialize-error.js';

try { foo(); } catch (error) {
          log.error({ error: serializeError(error) }, 'failed');
        }
      `,
      errors: [{ messageId: 'rawError' }],
    },
    {
      code: `
        try { foo(); } catch (err) {
          this.log.warn({ error: err }, 'failed');
        }
      `,
      output: `
        import { serializeError } from '../utils/serialize-error.js';

try { foo(); } catch (err) {
          this.log.warn({ error: serializeError(err) }, 'failed');
        }
      `,
      errors: [{ messageId: 'rawError' }],
    },
    {
      code: `
        try { foo(); } catch (error) {
          request.log.error({ error, bookId: 42 }, 'failed');
        }
      `,
      output: `
        import { serializeError } from '../utils/serialize-error.js';

try { foo(); } catch (error) {
          request.log.error({ error: serializeError(error), bookId: 42 }, 'failed');
        }
      `,
      errors: [{ messageId: 'rawError' }],
    },
    {
      code: `
        promise.catch((rmError) => {
          log.warn({ error: rmError, targetPath: '/tmp' }, 'cleanup failed');
        });
      `,
      output: `
        import { serializeError } from '../utils/serialize-error.js';

promise.catch((rmError) => {
          log.warn({ error: serializeError(rmError), targetPath: '/tmp' }, 'cleanup failed');
        });
      `,
      errors: [{ messageId: 'rawError' }],
    },
    {
      code: `
        promise.catch((error) => {
          log.error({ error }, 'failed');
        });
      `,
      output: `
        import { serializeError } from '../utils/serialize-error.js';

promise.catch((error) => {
          log.error({ error: serializeError(error) }, 'failed');
        });
      `,
      errors: [{ messageId: 'rawError' }],
    },

    // Bare identifier first arguments.

    {
      code: `
        try { foo(); } catch (err) {
          log.error(err, 'failed');
        }
      `,
      output: `
        import { serializeError } from '../utils/serialize-error.js';

try { foo(); } catch (err) {
          log.error({ error: serializeError(err) }, 'failed');
        }
      `,
      errors: [{ messageId: 'rawError' }],
    },
    {
      code: `
        promise.catch((err) => {
          log.warn(err, 'cleanup failed');
        });
      `,
      output: `
        import { serializeError } from '../utils/serialize-error.js';

promise.catch((err) => {
          log.warn({ error: serializeError(err) }, 'cleanup failed');
        });
      `,
      errors: [{ messageId: 'rawError' }],
    },
    {
      code: `
        try { foo(); } catch (err) {
          request.log.error(err, 'failed');
        }
      `,
      output: `
        import { serializeError } from '../utils/serialize-error.js';

try { foo(); } catch (err) {
          request.log.error({ error: serializeError(err) }, 'failed');
        }
      `,
      errors: [{ messageId: 'rawError' }],
    },
    {
      code: `
        try { foo(); } catch (err) {
          this.log.warn(err, 'failed');
        }
      `,
      output: `
        import { serializeError } from '../utils/serialize-error.js';

try { foo(); } catch (err) {
          this.log.warn({ error: serializeError(err) }, 'failed');
        }
      `,
      errors: [{ messageId: 'rawError' }],
    },
    {
      code: `
        try { foo(); } catch (err) {
          deps.log.warn(err, 'failed');
        }
      `,
      output: `
        import { serializeError } from '../utils/serialize-error.js';

try { foo(); } catch (err) {
          deps.log.warn({ error: serializeError(err) }, 'failed');
        }
      `,
      errors: [{ messageId: 'rawError' }],
    },
    {
      code: `
        try { foo(); } catch (err) {
          app.log.warn(err, 'failed');
        }
      `,
      output: `
        import { serializeError } from '../utils/serialize-error.js';

try { foo(); } catch (err) {
          app.log.warn({ error: serializeError(err) }, 'failed');
        }
      `,
      errors: [{ messageId: 'rawError' }],
    },
    {
      code: `
        try { foo(); } catch (err) {
          log.debug(err, 'failed');
        }
      `,
      output: `
        import { serializeError } from '../utils/serialize-error.js';

try { foo(); } catch (err) {
          log.debug({ error: serializeError(err) }, 'failed');
        }
      `,
      errors: [{ messageId: 'rawError' }],
    },
    {
      code: `
        try { foo(); } catch (err) {
          log.info(err, 'failed');
        }
      `,
      output: `
        import { serializeError } from '../utils/serialize-error.js';

try { foo(); } catch (err) {
          log.info({ error: serializeError(err) }, 'failed');
        }
      `,
      errors: [{ messageId: 'rawError' }],
    },
    // Fixes must preserve Pino format arguments.
    {
      code: `
        try { foo(); } catch (error) {
          this.log.error(error, 'Merge failed for book %d', bookId);
        }
      `,
      output: `
        import { serializeError } from '../utils/serialize-error.js';

try { foo(); } catch (error) {
          this.log.error({ error: serializeError(error) }, 'Merge failed for book %d', bookId);
        }
      `,
      errors: [{ messageId: 'rawError' }],
    },

    // Bare `serializeError` first arguments.

    {
      code: `
        try { foo(); } catch (err) {
          log.error(serializeError(err), 'failed');
        }
      `,
      output: `
        try { foo(); } catch (err) {
          log.error({ error: serializeError(err) }, 'failed');
        }
      `,
      errors: [{ messageId: 'rawError' }],
    },
    {
      code: `
        try { foo(); } catch (error) {
          this.log.warn(serializeError(error), 'Discovery: expiry step failed');
        }
      `,
      output: `
        try { foo(); } catch (error) {
          this.log.warn({ error: serializeError(error) }, 'Discovery: expiry step failed');
        }
      `,
      errors: [{ messageId: 'rawError' }],
    },

    // Depth-aware import fixes.

    {
      code: `
        try { foo(); } catch (err) {
          log.error(err, 'failed');
        }
      `,
      filename: '/project/src/server/utils/foo.ts',
      output: `
        import { serializeError } from './serialize-error.js';

try { foo(); } catch (err) {
          log.error({ error: serializeError(err) }, 'failed');
        }
      `,
      errors: [{ messageId: 'rawError' }],
    },
    {
      code: `
        try { foo(); } catch (err) {
          log.error(err, 'failed');
        }
      `,
      filename: '/project/src/server/services/foo.ts',
      output: `
        import { serializeError } from '../utils/serialize-error.js';

try { foo(); } catch (err) {
          log.error({ error: serializeError(err) }, 'failed');
        }
      `,
      errors: [{ messageId: 'rawError' }],
    },
    {
      code: `
        try { foo(); } catch (err) {
          log.error(err, 'failed');
        }
      `,
      filename: '/project/src/server/services/import-adapters/foo.ts',
      output: `
        import { serializeError } from '../../utils/serialize-error.js';

try { foo(); } catch (err) {
          log.error({ error: serializeError(err) }, 'failed');
        }
      `,
      errors: [{ messageId: 'rawError' }],
    },
    {
      code: `
        try { foo(); } catch (err) {
          request.log.error(err, 'failed');
        }
      `,
      filename: '/project/src/server/routes/foo.ts',
      output: `
        import { serializeError } from '../utils/serialize-error.js';

try { foo(); } catch (err) {
          request.log.error({ error: serializeError(err) }, 'failed');
        }
      `,
      errors: [{ messageId: 'rawError' }],
    },

    // Catch bindings under the `err` alias.

    {
      code: `
        try { foo(); } catch (err) {
          log.error({ err }, 'failed');
        }
      `,
      output: `
        import { serializeError } from '../utils/serialize-error.js';

try { foo(); } catch (err) {
          log.error({ error: serializeError(err) }, 'failed');
        }
      `,
      errors: [{ messageId: 'rawError' }],
    },
    {
      code: `
        try { foo(); } catch (error) {
          log.warn({ err: error, ctx: 1 }, 'msg');
        }
      `,
      output: `
        import { serializeError } from '../utils/serialize-error.js';

try { foo(); } catch (error) {
          log.warn({ error: serializeError(error), ctx: 1 }, 'msg');
        }
      `,
      errors: [{ messageId: 'rawError' }],
    },
    {
      code: `
        p.catch(err => log.warn({ err }, 'msg'));
      `,
      output: `
        import { serializeError } from '../utils/serialize-error.js';

p.catch(err => log.warn({ error: serializeError(err) }, 'msg'));
      `,
      errors: [{ messageId: 'rawError' }],
    },
    {
      // A spread's runtime keys are not statically decidable, so renaming a sibling into
      // `error` could collide with `other.error`. The report stays; the fix does not.
      name: 'a spread sibling makes the object unfixable',
      code: `
        const other = { ctx: 1 };
        p.catch(err => log.error({ ...other, err }, 'msg'));
      `,
      output: null,
      errors: [{ messageId: 'rawError' }],
    },
    {
      code: `
        try { foo(); } catch (e) {
          this.log.error({ err: e, jobId: 7 }, 'msg');
        }
      `,
      output: `
        import { serializeError } from '../utils/serialize-error.js';

try { foo(); } catch (e) {
          this.log.error({ error: serializeError(e), jobId: 7 }, 'msg');
        }
      `,
      errors: [{ messageId: 'rawError' }],
    },
    // Literal `err` locks the property-key resolution branch.
    {
      code: `
        try { foo(); } catch (err) {
          log.error({ 'err': err }, 'msg');
        }
      `,
      output: `
        import { serializeError } from '../utils/serialize-error.js';

try { foo(); } catch (err) {
          log.error({ error: serializeError(err) }, 'msg');
        }
      `,
      errors: [{ messageId: 'rawError' }],
    },

    // MemberExpression values from catch bindings.

    {
      code: `
        try { foo(); } catch (error) {
          log.warn({ error: error.cause }, 'msg');
        }
      `,
      output: `
        import { serializeError } from '../utils/serialize-error.js';

try { foo(); } catch (error) {
          log.warn({ error: serializeError(error.cause) }, 'msg');
        }
      `,
      errors: [{ messageId: 'rawError' }],
    },
    {
      code: `
        try { foo(); } catch (error) {
          log.error({ error: error.cause.message }, 'msg');
        }
      `,
      output: `
        import { serializeError } from '../utils/serialize-error.js';

try { foo(); } catch (error) {
          log.error({ error: serializeError(error.cause.message) }, 'msg');
        }
      `,
      errors: [{ messageId: 'rawError' }],
    },
    {
      code: `
        someAsync().catch(err => log.warn({ error: err.message }, 'msg'));
      `,
      output: `
        import { serializeError } from '../utils/serialize-error.js';

someAsync().catch(err => log.warn({ error: serializeError(err.message) }, 'msg'));
      `,
      errors: [{ messageId: 'rawError' }],
    },
    {
      code: `
        try { foo(); } catch (error) {
          log.error({ 'error': error.cause }, 'msg');
        }
      `,
      output: `
        import { serializeError } from '../utils/serialize-error.js';

try { foo(); } catch (error) {
          log.error({ error: serializeError(error.cause) }, 'msg');
        }
      `,
      errors: [{ messageId: 'rawError' }],
    },
    {
      code: `
        try { foo(); } catch (error) {
          log.warn({ err: error.cause, ctx: 1 }, 'msg');
        }
      `,
      output: `
        import { serializeError } from '../utils/serialize-error.js';

try { foo(); } catch (error) {
          log.warn({ error: serializeError(error.cause), ctx: 1 }, 'msg');
        }
      `,
      errors: [{ messageId: 'rawError' }],
    },

    // `logger` receiver symmetry with `log`.

    {
      code: `
        try { foo(); } catch (err) {
          logger.error(err, 'failed');
        }
      `,
      output: `
        import { serializeError } from '../utils/serialize-error.js';

try { foo(); } catch (err) {
          logger.error({ error: serializeError(err) }, 'failed');
        }
      `,
      errors: [{ messageId: 'rawError' }],
    },
    {
      code: `
        try { foo(); } catch (error) {
          this.logger.warn({ error }, 'failed');
        }
      `,
      output: `
        import { serializeError } from '../utils/serialize-error.js';

try { foo(); } catch (error) {
          this.logger.warn({ error: serializeError(error) }, 'failed');
        }
      `,
      errors: [{ messageId: 'rawError' }],
    },

    // Optional-chained receiver. The `?.` sits on the callee MemberExpression,
    // not on the CallExpression the rule visits.

    {
      name: 'C4 optional-chained log receiver',
      code: `try{f()}catch(e){log?.error(e,'x')}`,
      filename: '/project/src/server/services/a.ts',
      output: `import { serializeError } from '../utils/serialize-error.js';

try{f()}catch(e){log?.error({ error: serializeError(e) },'x')}`,
      errors: [{ messageId: 'rawError' }],
    },

    // Import-path computation.

    {
      name: 'C10 the src/server root resolves through utils/',
      code: `try{f()}catch(e){log.error(e,'x')}`,
      filename: '/project/src/server/foo.ts',
      output: `import { serializeError } from './utils/serialize-error.js';

try{f()}catch(e){log.error({ error: serializeError(e) },'x')}`,
      errors: [{ messageId: 'rawError' }],
    },
    {
      // Same expected value as the forward-slash `utils/` case above: both
      // separator spellings of one path must resolve identically. The `utils/`
      // depth is load-bearing — at any one-level-below depth the correct answer
      // coincides with the marker-not-found fallback and observes nothing.
      name: 'C11 a backslash-separated filename normalizes before the marker lookup',
      code: `try{f()}catch(e){log.error(e,'x')}`,
      filename: 'C:\\project\\src\\server\\utils\\foo.ts',
      output: `import { serializeError } from './serialize-error.js';

try{f()}catch(e){log.error({ error: serializeError(e) },'x')}`,
      errors: [{ messageId: 'rawError' }],
    },
    {
      name: 'C12 a repeated /src/server/ marker resolves against the last one',
      code: `try{f()}catch(e){log.error(e,'x')}`,
      filename: '/project/src/server/x/src/server/services/foo.ts',
      output: `import { serializeError } from '../utils/serialize-error.js';

try{f()}catch(e){log.error({ error: serializeError(e) },'x')}`,
      errors: [{ messageId: 'rawError' }],
    },
    {
      name: 'C13 a path outside src/server falls back rather than computing',
      code: `try{f()}catch(e){log.error(e,'x')}`,
      filename: '/project/src/core/foo.ts',
      output: `import { serializeError } from '../utils/serialize-error.js';

try{f()}catch(e){log.error({ error: serializeError(e) },'x')}`,
      errors: [{ messageId: 'rawError' }],
    },

    // Import insertion against a file that already has imports.

    {
      name: 'C14 the import lands after the last leading import',
      code: `
        import { db } from '../../db/client.js';
        import { z } from 'zod';

        try { foo(); } catch (err) {
          log.error({ error: err }, 'failed');
        }
      `,
      filename: '/project/src/server/services/foo.ts',
      output: `
        import { db } from '../../db/client.js';
        import { z } from 'zod';
import { serializeError } from '../utils/serialize-error.js';


        try { foo(); } catch (err) {
          log.error({ error: serializeError(err) }, 'failed');
        }
      `,
      errors: [{ messageId: 'rawError' }],
    },
    {
      name: 'C15 the scan stops at the first non-import, so a later import is not the anchor',
      code: `
        import { db } from '../../db/client.js';

        const x = 1;
        import { z } from 'zod';

        try { foo(); } catch (err) {
          log.error({ error: err }, 'failed');
        }
      `,
      filename: '/project/src/server/services/foo.ts',
      output: `
        import { db } from '../../db/client.js';
import { serializeError } from '../utils/serialize-error.js';


        const x = 1;
        import { z } from 'zod';

        try { foo(); } catch (err) {
          log.error({ error: serializeError(err) }, 'failed');
        }
      `,
      errors: [{ messageId: 'rawError' }],
    },
    {
      // Reclassified by #2260: a same-name binding that is not the canonical import is
      // unusable, and inserting the import beside it would be a redeclaration. Report only.
      name: 'C16 an unrelated serializeError binding withdraws the fix',
      code: `const serializeError = 1;
try{f()}catch(e){log.error(e,'x')}`,
      filename: '/project/src/server/services/foo.ts',
      output: null,
      errors: [{ messageId: 'rawError' }],
    },
    {
      // The lookup resolves a binding, so a mention in a comment is not one.
      name: 'C16b the canonical import in scope suppresses a second import',
      code: `import { serializeError } from '../utils/serialize-error.js';
try{f()}catch(e){log.error(e,'x')}`,
      filename: '/project/src/server/services/foo.ts',
      output: `import { serializeError } from '../utils/serialize-error.js';
try{f()}catch(e){log.error({ error: serializeError(e) },'x')}`,
      errors: [{ messageId: 'rawError' }],
    },
    {
      name: 'C17 a serializeError mention in a comment still gets the import',
      code: `// serializeError lives in ../utils
try{f()}catch(e){log.error(e,'x')}`,
      filename: '/project/src/server/services/foo.ts',
      output: `// serializeError lives in ../utils
import { serializeError } from '../utils/serialize-error.js';

try{f()}catch(e){log.error({ error: serializeError(e) },'x')}`,
      errors: [{ messageId: 'rawError' }],
    },

    // Multiple reports under RuleTester's single fix pass. Both fixes carry the
    // same import insertion, so the second report's fix is discarded as
    // overlapping and its call is left untouched.

    {
      name: 'C18 two violating calls report twice and only the first is rewritten',
      code: `try{f()}catch(e){log.error(e,'a');log.warn(e,'b')}`,
      filename: '/project/src/server/services/a.ts',
      output: `import { serializeError } from '../utils/serialize-error.js';

try{f()}catch(e){log.error({ error: serializeError(e) },'a');log.warn(e,'b')}`,
      errors: [{ messageId: 'rawError' }, { messageId: 'rawError' }],
    },
    {
      // Both properties still report, but only the first carries a fix and that one fix
      // folds the pair — so the single pass and the converged result now agree, which is
      // exactly what #2260 changed. The convergence pin lives below.
      name: 'C19 error and err in one object report twice and fold into one property',
      code: `try{f()}catch(e){log.error({error: e, err: e},'x')}`,
      filename: '/project/src/server/services/a.ts',
      output: `import { serializeError } from '../utils/serialize-error.js';

try{f()}catch(e){log.error({error: serializeError(e)},'x')}`,
      errors: [{ messageId: 'rawError' }, { messageId: 'rawError' }],
    },

    // Bare `serializeError` first argument.

    {
      name: 'C20 a bare serializeError call reports without consulting the catch trace',
      code: `const x = 1;
log.error(serializeError(x), 'x');`,
      filename: '/project/src/server/services/a.ts',
      output: `const x = 1;
log.error({ error: serializeError(x) }, 'x');`,
      errors: [{ messageId: 'rawError' }],
    },

    // Pino's `fatal` and `trace` levels. Both the reporter and the fixer reach them.

    {
      name: 'C1 log.fatal is inside LOG_METHODS',
      ...FATAL_BARE_IDENTIFIER,
      errors: [{ messageId: 'rawError' }],
    },
    {
      name: 'C1 log.trace is inside LOG_METHODS',
      ...TRACE_BARE_IDENTIFIER,
      errors: [{ messageId: 'rawError' }],
    },
    // Single-match objects, shared with the convergence checks below.

    ...Object.entries(SINGLE_MATCH_PINS).map(([name, pin]) => ({
      name,
      ...pin,
      filename: FIX_FILENAME,
      errors: [{ messageId: 'rawError' }],
    })),

    {
      name: 'C1 the object-key arm is reached at the fatal level',
      code: `
        try { foo(); } catch (err) {
          log.fatal({ error: err }, 'x');
        }
      `,
      output: `
        import { serializeError } from '../utils/serialize-error.js';

try { foo(); } catch (err) {
          log.fatal({ error: serializeError(err) }, 'x');
        }
      `,
      errors: [{ messageId: 'rawError' }],
    },
  ],
});


// --- Multi-pass convergence -------------------------------------------------------------
//
// RuleTester applies exactly ONE fix pass, so a green `output` pin says nothing about what
// `eslint --fix` (Linter.verifyAndFix, up to 10 passes) actually leaves on disk. Every #2260
// arm is a claim about the converged result, so it is asserted through this harness.

const RULE_ID = 'narratorr/no-raw-error-logging';

const flatConfig = {
  // ESLint 10 defaults a `files`-less flat config to JS extensions only, so a `.ts`
  // filename matches nothing and the rule silently never runs (#2280).
  files: ['**/*.ts'],
  plugins: { narratorr: { rules: { 'no-raw-error-logging': rule } } },
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  },
  rules: { [RULE_ID]: 'error' },
};

const lint = (code, filename = FIX_FILENAME) =>
  new Linter().verify(code, flatConfig, filename).filter((m) => m.ruleId === RULE_ID);

const fixAll = (code, filename = FIX_FILENAME) =>
  new Linter().verifyAndFix(code, flatConfig, filename);

const converge = (code, filename = 'file.ts') => fixAll(code, filename).output;

// AC1's promise stated directly, so a fold is observed as "one error key" rather than only as
// string equality against a hand-written expectation.
const errorKeyCount = (source) => (source.match(/\berror:/g) ?? []).length;

/** Converges `code`, pins the exact result, and proves re-running the fixer is a no-op. */
function expectConverges(code, expected, filename = FIX_FILENAME) {
  const first = fixAll(code, filename);
  // #2280: an unmatched filename lints nothing and hands back the input verbatim, so prove
  // the rule ran before trusting any equality.
  expect(first.fixed).toBe(true);
  expect(first.output).toContain('serializeError(');
  expect(first.output).toBe(expected);

  const second = fixAll(first.output, filename);
  expect(second.fixed).toBe(false);
  expect(lint(first.output, filename)).toHaveLength(0);
}

/** Pins the report-only arm: every match still reports, and the source is left untouched. */
function expectReportOnly(code, reports, filename = FIX_FILENAME) {
  // "Source unchanged" is also what an inert lint produces, so the report count is the guard.
  expect(lint(code, filename)).toHaveLength(reports);
  const result = fixAll(code, filename);
  expect(result.fixed).toBe(false);
  expect(result.output).toBe(code);
}

describe('multi-pass convergence', () => {
  it('converges a bare fatal binding to the single-pass output', () => {
    expect(converge(FATAL_BARE_IDENTIFIER.code)).toBe(FATAL_BARE_IDENTIFIER.output);
  });

  it('converges a bare trace binding to the single-pass output', () => {
    expect(converge(TRACE_BARE_IDENTIFIER.code)).toBe(TRACE_BARE_IDENTIFIER.output);
  });

  it('inserts the import and rewrites the property in one pass on a file with no imports', () => {
    // The insertion point nests inside the statement being edited; the two ranges must still
    // merge into one applied fix.
    expectConverges(objectCall('{err: e}'), importedObjectCall('{error: serializeError(e)}'));
  });

  it.each(Object.entries(SINGLE_MATCH_PINS))(
    'converges %s byte-identically to its single-pass pin',
    (_name, pin) => {
      expectConverges(pin.code, pin.output);
    },
  );

  it('leaves the fatal level exactly as well off as the pinned error level', () => {
    const atError = converge(objectCall('{error: e, err: e}'), FIX_FILENAME);
    const atFatal = converge(objectCall('{error: e, err: e}', 'fatal'), FIX_FILENAME);

    // The widening extends one behaviour to a new level rather than introducing a second,
    // differently-shaped one — now that the behaviour is a fold rather than #2260's defect.
    expect(atFatal).toContain('serializeError(e)');
    expect(atFatal).toBe(atError.replaceAll('log.error', 'log.fatal'));
  });

  it.each(['error', 'warn', 'info', 'debug', 'fatal', 'trace'])(
    'folds a duplicated catch binding at the %s level',
    (level) => {
      expectConverges(
        objectCall('{error: e, err: e}', level),
        importedObjectCall('{error: serializeError(e)}', level),
      );
    },
  );
});

describe('folding a multi-match object (AC1, AC2)', () => {
  it('folds error and err on the same identifier into one property', () => {
    const expected = importedObjectCall('{error: serializeError(e)}');
    expectConverges(objectCall('{error: e, err: e}'), expected);
    expect(errorKeyCount(expected)).toBe(1);
  });

  it('keeps the first property in source order regardless of which key it carries', () => {
    // Reverse of the case above: the kept property is chosen by position, not by key name.
    expectConverges(objectCall('{err: e, error: e}'), importedObjectCall('{error: serializeError(e)}'));
  });

  it('takes exactly one separator when the removed property is last', () => {
    const expected = importedObjectCall('{error: serializeError(e), ctx: 1}');
    expectConverges(objectCall('{err: e, ctx: 1, error: e}'), expected);
    expect(errorKeyCount(expected)).toBe(1);
    expect(expected).toContain('ctx: 1');
  });

  it('takes exactly one separator when the removed property is in the middle', () => {
    // A bare property removal here leaves `{a, , b}`, which does not parse.
    expectConverges(
      objectCall('{error: e, err: e, ctx: 1}'),
      importedObjectCall('{error: serializeError(e), ctx: 1}'),
    );
  });

  it('declines a three-match object, so only one property is ever removed', () => {
    // A third match necessarily repeats a resolved key, which AC12(b) refuses before the fold
    // is consulted. This is what keeps the removal count at one and the separators unambiguous.
    expectReportOnly(objectCall(`{error: e, err: e, 'err': e}`), 3);
  });

  it('declines to fold two distinct error values', () => {
    // Dropping either one loses data the original logged.
    expectReportOnly(objectCall('{err: e, ctx: 1, error: e.cause}'), 2);
  });

  it.each([['{error: e.cause, err: e.cause}'], ['{error: e.response.data, err: e.response.data}']])(
    'declines to fold identical member expressions in %s',
    (objectSource) => {
      expectReportOnly(objectCall(objectSource), 2);
    },
  );

  it('folding identical member expressions would delete one evaluation', () => {
    // The syntactic assertions above cannot show what the fold costs — the loss is a runtime
    // property. `e.cause` may be an accessor or a Proxy trap, so two reads are not one read.
    let reads = 0;
    const makeError = () => ({
      get cause() {
        reads += 1;
        return 'boom';
      },
    });

    const unfolded = makeError();
    void { error: unfolded.cause, err: unfolded.cause };
    const beforeFold = reads;

    reads = 0;
    const folded = makeError();
    void { error: folded.cause };

    expect(beforeFold).toBe(2);
    expect(reads).toBe(1);
  });
});

describe('whole-object fixability (AC12)', () => {
  it.each([['{err: e, error: 1}'], ["{error: 'context', err: e}"]])(
    'declines %s because an unmatched sibling already produces the error key',
    (objectSource) => {
      // Before #2260 this converged to two `error` keys in which the sibling won, so the
      // serialized error never reached the log at all.
      expectReportOnly(objectCall(objectSource), 1);
    },
  );

  it.each([
    ["{error: e, err: 'lit'}", "{error: serializeError(e), err: 'lit'}"],
    ["{err: 'lit', error: e}", "{err: 'lit', error: serializeError(e)}"],
  ])('fixes %s because the unmatched err keeps its own key', (objectSource, expected) => {
    // The control for (c): naming both keys is not itself a collision.
    expectConverges(objectCall(objectSource), importedObjectCall(expected));
    expect(errorKeyCount(importedObjectCall(expected))).toBe(1);
  });

  it.each([
    ['{err: e, ...ctx}', 1],
    ['{...ctx, err: e}', 1],
    ['{error: e, ...ctx, err: e}', 2],
  ])('declines %s because a spread hides its keys', (objectSource, reports) => {
    // Position does not rescue it: whichever side loses, an entry of the original object is
    // gone from the fixed one.
    expectReportOnly(objectCall(objectSource), reports);
  });

  it.each([["{err: e, [key]: 'context'}"], ['{[error]: e}']])(
    'declines %s because a dynamic computed key is not statically known',
    (objectSource) => {
      expectReportOnly(objectCall(objectSource), 1);
    },
  );

  it.each([
    ['{error: e, error: e}', 2],
    ["{err: e, err: 'lit'}", 1],
    ["{err: 'lit', err: e}", 1],
    ["{err: e, ['err']: 'lit'}", 1],
    ["{error: e, err: e, error: 'lit'}", 2],
  ])('declines %s because a resolved key repeats', (objectSource, reports) => {
    // Last-one-wins already made some entry dead. Renaming the dead one to `error` would
    // resurrect a value the original object discarded, so the rule touches none of it.
    expectReportOnly(objectCall(objectSource), reports);
  });

  it.each([
    ['{err: e, ctx: 1}', '{error: serializeError(e), ctx: 1}'],
    ["{['error']: e}", '{error: serializeError(e)}'],
    [`{[  'err'  ]: e}`, '{error: serializeError(e)}'],
    // The spread sits inside a *value*, so it cannot change the logged object's key set.
    ['{err: e, meta: {...ctx}}', '{error: serializeError(e), meta: {...ctx}}'],
  ])('still fixes %s', (objectSource, expected) => {
    expectConverges(objectCall(objectSource), importedObjectCall(expected));
  });
});

describe('computed keys (AC11)', () => {
  it.each([["{['error']: e}"], ["{['err']: e}"]])(
    'reports %s once and rewrites it as today',
    (objectSource) => {
      expect(lint(objectCall(objectSource))).toHaveLength(1);
      expectConverges(objectCall(objectSource), importedObjectCall('{error: serializeError(e)}'));
    },
  );

  it('leaves a computed key that cannot resolve to error or err unreported', () => {
    const code = objectCall('{[key]: e}');
    expect(lint(code)).toHaveLength(0);
    expect(fixAll(code).fixed).toBe(false);
    // The harness is live: the same shape with a resolvable key does report.
    expect(lint(objectCall(`{['err']: e}`))).toHaveLength(1);
  });

  it.each([['{[error]: e}'], ['{[err]: e}']])(
    'reports %s but no longer rewrites its dynamic key to a literal one',
    (objectSource) => {
      expectReportOnly(objectCall(objectSource), 1);
    },
  );
});

describe('canonical serializeError recognition (AC3, AC4, AC5)', () => {
  const bareCall = `try{f()}catch(e){log.error(e,'x')}`;
  const fixedBareCall = `try{f()}catch(e){log.error({ error: serializeError(e) },'x')}`;

  it.each([
    ['no mention of the identifier', ''],
    ['a mention in a comment', '// serializeError lives in ../utils'],
    ['a mention in a string literal', `const msg = 'serializeError';`],
    ['a mention as a member property', 'const s = utils.serializeError;'],
  ])('inserts the import when the only %s is present', (_label, prelude) => {
    const code = prelude ? `${prelude}\n${bareCall}` : bareCall;
    const body = prelude ? `${prelude}\n${fixedBareCall}` : fixedBareCall;
    // A comment is not a statement, so the import lands after it but before the first one.
    const expected = prelude.startsWith('//')
      ? `${prelude}\n${CANONICAL_IMPORT}\n\n${fixedBareCall}`
      : `${CANONICAL_IMPORT}\n\n${body}`;
    expectConverges(code, expected);
  });

  it('inserts the import beside an aliased import of the same symbol', () => {
    // `serializeError as se` binds `se`, so no variable named serializeError is in scope.
    const alias = `import { serializeError as se } from '../utils/serialize-error.js';`;
    expectConverges(`${alias}\n${bareCall}`, `${alias}\n${CANONICAL_IMPORT}\n\n${fixedBareCall}`);
  });

  it('rewrites without a second import when the canonical import is already in scope', () => {
    const code = `${CANONICAL_IMPORT}\n${bareCall}`;
    expectConverges(code, `${CANONICAL_IMPORT}\n${fixedBareCall}`);
    expect(fixAll(code).output.match(/^import /gm)).toHaveLength(1);
  });

  it.each([
    ['a numeric local (the reclassified C16)', 'const serializeError = 1;'],
    ['a function declaration', 'function serializeError(e){ return e }'],
    ['an ambient declaration', 'declare function serializeError(e: unknown): unknown;'],
    ['an async function', 'async function serializeError(e){ return e }'],
    ['a generator function', 'function* serializeError(e){ yield e }'],
    ['an async arrow initialiser', 'const serializeError = async (e) => e;'],
    ['an arrow initialiser', 'const serializeError = (e) => e;'],
    [
      'a type-only import declaration',
      `import type { serializeError } from '../utils/serialize-error.js';`,
    ],
    [
      'a type-only import specifier',
      `import { type serializeError } from '../utils/serialize-error.js';`,
    ],
    ['a namespace import', `import * as serializeError from '../utils/serialize-error.js';`],
    ['a default import', `import serializeError from '../utils/serialize-error.js';`],
    ['a type alias', 'type serializeError = string;'],
    ['the right name from the wrong module', `import { serializeError } from './constants.js';`],
    [
      'the wrong imported symbol under the right name',
      `import { other as serializeError } from '../utils/serialize-error.js';`,
    ],
    [
      'an equivalent path spelled differently',
      `import { serializeError } from '../utils/serialize-error';`,
    ],
    [
      'the canonical import carrying a second declaration',
      `import { serializeError } from '../utils/serialize-error.js';\ninterface serializeError {}`,
    ],
  ])('reports without fixing beside %s', (_label, binding) => {
    // Row 3 is the default, not a list: rewriting without an import leaves an unresolved
    // identifier, and inserting one beside a conflicting binding is a redeclaration.
    expectReportOnly(`${binding}\n${bareCall}`, 1);
  });

  it('applies the closest binding, so an inner shadow beats an outer canonical import', () => {
    expectReportOnly(
      `${CANONICAL_IMPORT}
function run(serializeError) {
  try{f()}catch(e){log.error(e,'x')}
}`,
      1,
    );
  });
});

describe('arm interaction', () => {
  it('folds one object and rewrites a second call under one shared import', () => {
    // Pass 1 lands the fold plus the import; pass 2 sees the canonical import already in
    // scope and rewrites the second call without adding another.
    expectConverges(
      `try{f()}catch(e){log.error({error: e, err: e},'a');log.warn(e,'b')}`,
      `${CANONICAL_IMPORT}\n\ntry{f()}catch(e){log.error({error: serializeError(e)},'a');log.warn({ error: serializeError(e) },'b')}`,
    );
  });

  it('withholds the fold when the file also carries a conflicting serializeError binding', () => {
    expectReportOnly(`const serializeError = 1;\n${objectCall('{error: e, err: e}')}`, 2);
  });
});
