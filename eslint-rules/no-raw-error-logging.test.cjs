const { RuleTester } = require('eslint');
const rule = require('./no-raw-error-logging.cjs');

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

ruleTester.run('no-raw-error-logging', rule, {
  valid: [
    // Already wrapped with serializeError
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
    // Variable not from catch or .catch callback — plain variable
    {
      code: `
        const message = 'oops';
        log.info({ error: message }, 'info');
      `,
    },
    // Variable not from catch or .catch callback — constructed Error
    {
      code: `
        const error = new Error('test');
        log.error({ error }, 'failed');
      `,
    },
  ],

  invalid: [
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
  ],
});

console.log('All RuleTester cases passed');
