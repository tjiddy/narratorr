const { RuleTester } = require('eslint');
const rule = require('./no-raw-error-logging.cjs');

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
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
  ],
});

console.log('All RuleTester cases passed');
