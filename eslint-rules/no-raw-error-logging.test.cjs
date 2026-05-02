const { RuleTester } = require('eslint');
const rule = require('./no-raw-error-logging.cjs');

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

ruleTester.run('no-raw-error-logging', rule, {
  valid: [
    // Canonical shape — already wrapped with serializeError under `error` key
    {
      code: `
        try { foo(); } catch (error) {
          log.error({ error: serializeError(error) }, 'failed');
        }
      `,
    },
    // Error property value is a MemberExpression (result.error), not a catch binding
    {
      code: `
        const result = doSomething();
        log.error({ error: result.error }, 'failed');
      `,
    },
    // Plain variable — not from catch or .catch callback
    {
      code: `
        const message = 'oops';
        log.info({ error: message }, 'info');
      `,
    },
    // Constructed Error — not traced to a catch source
    {
      code: `
        const error = new Error('test');
        log.error({ error }, 'failed');
      `,
    },
    // Plain string message — no error payload
    {
      code: `
        log.info('plain message');
      `,
    },
    // Non-error object payload with unrelated keys
    {
      code: `
        log.error({ msg: 'plain' }, 'top-level');
      `,
    },
    // Local variable bare-first-arg — not traceable to a catch binding
    {
      code: `
        const result = doSomething();
        log.error(result, 'failed');
      `,
    },
    // Bare CallExpression whose callee is NOT serializeError — must not flag
    {
      code: `
        try { foo(); } catch (err) {
          log.error(someOtherHelper(err), 'failed');
        }
      `,
    },
    // `err:` key wrapped with serializeError — already canonical-equivalent, must pass
    {
      code: `
        try { foo(); } catch (err) {
          log.error({ err: serializeError(err) }, 'failed');
        }
      `,
    },
    // `err:` key with an unrelated non-catch identifier — must not flag
    {
      code: `
        const someUnrelatedNonCatchVar = { code: 1 };
        log.warn({ err: someUnrelatedNonCatchVar }, 'msg');
      `,
    },

    // ── MemberExpression negative cases (root is not a catch binding) ─────

    // `result.error` where `result` is a typed result-union, not a catch binding
    {
      code: `
        async function run() {
          const result = await fn();
          if (result.error) log.warn({ error: result.error }, 'msg');
        }
      `,
    },
    // `refresh.error` from an awaited service call — not a catch binding
    {
      code: `
        async function run() {
          const refresh = await this.preSearchRefresh();
          log.warn({ error: refresh.error }, 'msg');
        }
      `,
    },
    // Computed segment at the root — out of scope
    {
      code: `
        const key = 'foo';
        try { foo(); } catch (error) {
          log.error({ error: error[key] }, 'msg');
        }
      `,
    },
    // Computed segment in the chain (root computed) — out of scope
    {
      code: `
        const key = 'foo';
        try { foo(); } catch (error) {
          log.error({ error: error[key].message }, 'msg');
        }
      `,
    },
    // Computed segment in the outermost level — out of scope
    {
      code: `
        const key = 'foo';
        try { foo(); } catch (error) {
          log.error({ error: error.cause[key] }, 'msg');
        }
      `,
    },
    // Call-result base — out of scope
    {
      code: `
        function getError() { return { foo: 1 }; }
        try { foo(); } catch (error) {
          log.error({ error: getError().foo }, 'msg');
        }
      `,
    },
    // Already wrapped with serializeError — value is a CallExpression, not MemberExpression
    {
      code: `
        try { foo(); } catch (error) {
          log.error({ error: serializeError(error.cause) }, 'msg');
        }
      `,
    },
    // Plain string literal value — no identifier at all
    {
      code: `
        log.warn({ error: 'plain string' }, 'msg');
      `,
    },
  ],

  invalid: [
    // ── Case 1: object-key raw ────────────────────────────────────────────

    // Shorthand from catch binding
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
    // Alias from catch binding
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
    // Mixed fields from catch binding
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
    // Promise .catch callback parameter — alias
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
    // Promise .catch callback parameter — shorthand
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

    // ── Case 2: bare Identifier first arg ─────────────────────────────────

    // Bare catch binding — `log.error(err, '…')`
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
    // Bare .catch callback parameter — `log.warn(err, '…')`
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
    // request.log.* receiver
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
    // this.log.* receiver
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
    // deps.log.* receiver
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
    // app.log.* receiver
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
    // All four methods — `debug`
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
    // All four methods — `info`
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
    // Preserves trailing args (pino format placeholders)
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

    // ── Case 3: bare serializeError(...) first arg ────────────────────────

    // Bare `log.error(serializeError(err), '…')` — wrap in { error: … }
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
    // Bare `this.log.warn(serializeError(err), '…')` — covers the pre-existing outlier
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

    // ── Fixer depth cases ─────────────────────────────────────────────────

    // Sibling of helper — file in src/server/utils/
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
    // Depth-1 — file in src/server/services/
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
    // Depth-2 — file in src/server/services/import-adapters/
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
    // Depth-1 — file in src/server/routes/
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

    // ── Case 1 (extension): `err:` key from catch binding ─────────────────

    // Shorthand `{ err }` from catch binding — normalizes to `error:`
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
    // Explicit `err: <catchBinding>` with mixed fields
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
    // `.catch` callback shorthand `{ err }`
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
    // Non-first shorthand position via spread — `{ ...other, err }`
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
    // `this.log` receiver with `err: <alias>` and mixed fields
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
    // Literal property key `'err'` from catch binding — locks in the
    // `Literal` branch of checkObjectArg's keyName resolution
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

    // ── Case 1 (extension): MemberExpression value from catch binding ─────

    // Synthetic catch-root regression fixture — closes the blind spot from #862
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
    // Nested dot chain — `error.cause.message`
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
    // `.catch` callback parameter with MemberExpression — `err.message`
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
    // Literal property key `'error'` with MemberExpression value
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
    // `err:` alias key with MemberExpression value — normalizes key to `error:`
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
  ],
});

console.log('All RuleTester cases passed');
