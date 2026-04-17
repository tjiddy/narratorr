/**
 * ESLint rule: no-raw-error-logging
 *
 * Pino serializes `catch (error: unknown)` bindings to `"error":{}` in JSON logs —
 * the standard serializers only run for `err` (Error instances). This rule flags log
 * calls that pass an untyped error source (catch binding or promise .catch() callback
 * parameter) under the `error` key, and auto-fixes by wrapping with `serializeError()`.
 *
 * Covers: shorthand `{ error }`, alias `{ error: err }`, mixed `{ error, bookId }`.
 * Does NOT flag: `{ error: serializeError(error) }`, `{ error: result.error }`,
 * `{ error: message }` where message is a plain variable.
 */

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow passing raw catch/callback error bindings as the `error` property in Pino log calls',
    },
    fixable: 'code',
    schema: [],
    messages: {
      rawError:
        'Raw error value passed to log `error` property — Pino serializes unknown values to {}. Wrap with serializeError().',
    },
  },

  create(context) {
    const LOG_METHODS = new Set(['error', 'warn', 'info', 'debug']);

    /**
     * Check if a node is a log method call like `log.error(...)`, `this.log.warn(...)`,
     * `request.log.error(...)`.
     */
    function isLogCall(node) {
      if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') {
        return false;
      }
      const { property, object } = node.callee;
      if (property.type !== 'Identifier' || !LOG_METHODS.has(property.name)) {
        return false;
      }
      // Direct: log.error(...)
      if (object.type === 'Identifier' && object.name === 'log') return true;
      // Member: this.log.error(...), request.log.error(...)
      if (
        object.type === 'MemberExpression' &&
        object.property.type === 'Identifier' &&
        object.property.name === 'log'
      ) {
        return true;
      }
      return false;
    }

    /**
     * Check if a variable was defined as a catch clause parameter.
     */
    function isCatchParam(variable) {
      for (const def of variable.defs) {
        if (def.type === 'CatchClause') return true;
      }
      return false;
    }

    /**
     * Check if a variable was defined as a callback parameter of a .catch() call.
     * Matches: `.catch((err) => ...)` and `.catch(function(err) { ... })`
     */
    function isCatchCallbackParam(variable) {
      for (const def of variable.defs) {
        if (def.type !== 'Parameter') continue;
        const fnNode = def.node;
        // The function (arrow or regular) should be the argument of a .catch() call
        if (fnNode.parent && fnNode.parent.type === 'CallExpression') {
          const callNode = fnNode.parent;
          if (
            callNode.callee.type === 'MemberExpression' &&
            callNode.callee.property.type === 'Identifier' &&
            callNode.callee.property.name === 'catch'
          ) {
            return true;
          }
        }
      }
      return false;
    }

    /**
     * Check if an identifier refers to an error source (catch param or .catch callback param).
     */
    function isErrorSource(identifierNode) {
      const scope = context.sourceCode.getScope(identifierNode);
      let currentScope = scope;
      while (currentScope) {
        for (const variable of currentScope.variables) {
          if (variable.name === identifierNode.name) {
            return isCatchParam(variable) || isCatchCallbackParam(variable);
          }
        }
        currentScope = currentScope.upper;
      }
      return false;
    }

    return {
      CallExpression(node) {
        if (!isLogCall(node)) return;

        // First argument should be an object expression
        const firstArg = node.arguments[0];
        if (!firstArg || firstArg.type !== 'ObjectExpression') return;

        for (const prop of firstArg.properties) {
          if (prop.type !== 'Property') continue;

          // Find properties with key name 'error'
          const keyName =
            prop.key.type === 'Identifier'
              ? prop.key.name
              : prop.key.type === 'Literal'
                ? String(prop.key.value)
                : null;
          if (keyName !== 'error') continue;

          const value = prop.value;

          // Only flag simple Identifiers (not CallExpressions like serializeError() or
          // MemberExpressions like result.error)
          if (value.type !== 'Identifier') continue;

          // Check if this identifier traces back to a catch clause or .catch() callback param
          if (!isErrorSource(value)) continue;

          context.report({
            node: prop,
            messageId: 'rawError',
            fix(fixer) {
              const valueName = value.name;
              // For shorthand `{ error }`, expand to `{ error: serializeError(error) }`
              // For alias `{ error: err }`, wrap to `{ error: serializeError(err) }`
              const fixText = prop.shorthand
                ? `error: serializeError(${valueName})`
                : `error: serializeError(${valueName})`;

              const fixes = [fixer.replaceText(prop, fixText)];

              // Add import if not already present
              const sourceCode = context.sourceCode;
              const text = sourceCode.getText();
              if (!text.includes('serializeError')) {
                // Determine correct relative import path based on file location
                const filePath = context.filename || context.getFilename();
                const isUtilFile = filePath.replace(/\\/g, '/').includes('/utils/');
                const importPath = isUtilFile
                  ? './serialize-error.js'
                  : '../utils/serialize-error.js';

                // Find last import in the top-level import block to insert after
                const program = sourceCode.ast;
                let lastImport = null;
                for (const stmt of program.body) {
                  if (stmt.type === 'ImportDeclaration') lastImport = stmt;
                  else if (!lastImport) continue;
                  else break; // stop at first non-import after the import block
                }
                const importText =
                  `import { serializeError } from '${importPath}';\n`;
                if (lastImport) {
                  fixes.push(fixer.insertTextAfter(lastImport, '\n' + importText));
                } else {
                  fixes.push(
                    fixer.insertTextBefore(program.body[0], importText + '\n'),
                  );
                }
              }

              return fixes;
            },
          });
        }
      },
    };
  },
};

module.exports = rule;
