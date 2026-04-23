/**
 * ESLint rule: no-raw-error-logging
 *
 * Pino serializes `catch (error: unknown)` bindings to `"error":{}` in JSON logs —
 * the standard serializers only run for `err` (Error instances). This rule flags
 * three non-canonical shapes for the four `log.(debug|info|warn|error)` methods:
 *
 *   1. Object-key raw: `log.error({ error }, '…')` / `{ error: err }` where the
 *      value traces back to a catch binding or `.catch` callback parameter.
 *   2. Bare identifier: `log.error(err, '…')` where `err` traces back to a catch
 *      binding or `.catch` callback parameter.
 *   3. Bare serializeError call: `log.error(serializeError(err), '…')` — the
 *      serialized object must live under an `error` key on the log record, not
 *      at the top level.
 *
 * All three autofix to the canonical shape:
 *   `log.error({ error: serializeError(err) }, '…')`
 *
 * The `serializeError` import is inserted at the top of the file when missing,
 * with a depth-aware relative path from the source file to
 * `src/server/utils/serialize-error.js`.
 */

const path = require('node:path');

const LOG_METHODS = new Set(['error', 'warn', 'info', 'debug']);

/**
 * Check if a node is a log method call like `log.error(...)`, `this.log.warn(...)`,
 * `request.log.error(...)`, `app.log.warn(...)`, `deps.log.warn(...)`.
 */
function isLogCall(node) {
  if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') {
    return false;
  }
  const { property, object } = node.callee;
  if (property.type !== 'Identifier' || !LOG_METHODS.has(property.name)) {
    return false;
  }
  if (object.type === 'Identifier' && object.name === 'log') return true;
  if (
    object.type === 'MemberExpression' &&
    object.property.type === 'Identifier' &&
    object.property.name === 'log'
  ) {
    return true;
  }
  return false;
}

function isCatchParam(variable) {
  for (const def of variable.defs) {
    if (def.type === 'CatchClause') return true;
  }
  return false;
}

function isCatchCallbackParam(variable) {
  for (const def of variable.defs) {
    if (def.type !== 'Parameter') continue;
    const fnNode = def.node;
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

function isErrorSource(identifierNode, context) {
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

/**
 * Compute the relative import path from the source file to
 * `src/server/utils/serialize-error.js`. Depth-aware — works at any depth under
 * `src/server/**`. Falls back to `../utils/serialize-error.js` if the file
 * isn't under `src/server/`.
 */
function computeImportPath(filePath) {
  const normalized = (filePath || '').replace(/\\/g, '/');
  const marker = '/src/server/';
  const idx = normalized.lastIndexOf(marker);
  if (idx === -1) {
    return '../utils/serialize-error.js';
  }
  const serverRoot = normalized.slice(0, idx + marker.length - 1); // strip trailing '/'
  const helperAbs = `${serverRoot}/utils/serialize-error.js`;
  const sourceDir = path.posix.dirname(normalized);
  let rel = path.posix.relative(sourceDir, helperAbs);
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

/**
 * Build fixes that add `import { serializeError } from '…';` when missing.
 */
function buildImportFixes(fixer, context) {
  const sourceCode = context.sourceCode;
  const text = sourceCode.getText();
  if (text.includes('serializeError')) return [];

  const importPath = computeImportPath(context.filename || context.getFilename());
  const importText = `import { serializeError } from '${importPath}';\n`;

  const program = sourceCode.ast;
  let lastImport = null;
  for (const stmt of program.body) {
    if (stmt.type === 'ImportDeclaration') lastImport = stmt;
    else if (lastImport) break;
  }
  if (lastImport) {
    return [fixer.insertTextAfter(lastImport, '\n' + importText)];
  }
  return [fixer.insertTextBefore(program.body[0], importText + '\n')];
}

/**
 * Case 1: Object-key raw — `log.error({ error: <catchBinding> }, '…')`.
 */
function checkObjectArg(node, firstArg, context) {
  for (const prop of firstArg.properties) {
    if (prop.type !== 'Property') continue;

    const keyName =
      prop.key.type === 'Identifier'
        ? prop.key.name
        : prop.key.type === 'Literal'
          ? String(prop.key.value)
          : null;
    if (keyName !== 'error') continue;

    const value = prop.value;
    if (value.type !== 'Identifier') continue;
    if (!isErrorSource(value, context)) continue;

    context.report({
      node: prop,
      messageId: 'rawError',
      fix(fixer) {
        const fixText = `error: serializeError(${value.name})`;
        return [fixer.replaceText(prop, fixText), ...buildImportFixes(fixer, context)];
      },
    });
  }
}

/**
 * Case 2: Bare identifier — `log.error(err, '…')` where `err` is a catch binding
 * or `.catch` callback parameter.
 */
function checkBareIdentifierArg(node, firstArg, context) {
  if (firstArg.type !== 'Identifier') return;
  if (!isErrorSource(firstArg, context)) return;

  context.report({
    node: firstArg,
    messageId: 'rawError',
    fix(fixer) {
      const fixText = `{ error: serializeError(${firstArg.name}) }`;
      return [fixer.replaceText(firstArg, fixText), ...buildImportFixes(fixer, context)];
    },
  });
}

/**
 * Case 3: Bare `serializeError(...)` call — `log.error(serializeError(err), '…')`.
 * Wrap the existing call in `{ error: ... }` without double-wrapping.
 */
function checkBareSerializeErrorArg(node, firstArg, context) {
  if (firstArg.type !== 'CallExpression') return;
  if (firstArg.callee.type !== 'Identifier' || firstArg.callee.name !== 'serializeError') {
    return;
  }

  context.report({
    node: firstArg,
    messageId: 'rawError',
    fix(fixer) {
      const original = context.sourceCode.getText(firstArg);
      return [fixer.replaceText(firstArg, `{ error: ${original} }`)];
    },
  });
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow passing raw or bare error values to Pino log calls — wrap with serializeError() under the `error` key',
    },
    fixable: 'code',
    schema: [],
    messages: {
      rawError:
        'Raw error value passed to log call — Pino serializes unknown values to {}. Wrap with serializeError() under the `error` key.',
    },
  },

  create(context) {
    return {
      CallExpression(node) {
        if (!isLogCall(node)) return;
        const firstArg = node.arguments[0];
        if (!firstArg) return;

        if (firstArg.type === 'ObjectExpression') {
          checkObjectArg(node, firstArg, context);
        } else if (firstArg.type === 'Identifier') {
          checkBareIdentifierArg(node, firstArg, context);
        } else if (firstArg.type === 'CallExpression') {
          checkBareSerializeErrorArg(node, firstArg, context);
        }
      },
    };
  },
};

module.exports = rule;
