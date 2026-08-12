import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
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

    {
      name: 'C1 log.fatal is outside LOG_METHODS',
      code: `
        try { foo(); } catch (err) {
          log.fatal(err, 'x');
        }
      `,
    },
    {
      name: 'C1 log.trace is outside LOG_METHODS',
      code: `
        try { foo(); } catch (err) {
          log.trace(err, 'x');
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
      code: `
        const other = { ctx: 1 };
        p.catch(err => log.error({ ...other, err }, 'msg'));
      `,
      output: `
        import { serializeError } from '../utils/serialize-error.js';

const other = { ctx: 1 };
        p.catch(err => log.error({ ...other, error: serializeError(err) }, 'msg'));
      `,
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
      name: 'C16 an unrelated serializeError binding suppresses the import',
      code: `const serializeError = 1;
try{f()}catch(e){log.error(e,'x')}`,
      filename: '/project/src/server/services/foo.ts',
      output: `const serializeError = 1;
try{f()}catch(e){log.error({ error: serializeError(e) },'x')}`,
      errors: [{ messageId: 'rawError' }],
    },
    {
      // Documented false negative: the short-circuit is textual, so the fix
      // leaves serializeError unresolved. Pinned here, filed separately.
      name: 'C17 a serializeError mention in a comment suppresses the import',
      code: `// serializeError lives in ../utils
try{f()}catch(e){log.error(e,'x')}`,
      filename: '/project/src/server/services/foo.ts',
      output: `// serializeError lives in ../utils
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
      // Under ESLint's real multi-pass loop this converges to a duplicate
      // `error` key. Pinned as-is; the defect is filed separately.
      name: 'C19 error and err in one object report twice and only the first is rewritten',
      code: `try{f()}catch(e){log.error({error: e, err: e},'x')}`,
      filename: '/project/src/server/services/a.ts',
      output: `import { serializeError } from '../utils/serialize-error.js';

try{f()}catch(e){log.error({error: serializeError(e), err: e},'x')}`,
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
  ],
});
