/**
 * Rejects catch-sourced errors passed raw to Pino as object values, bare identifiers,
 * or bare `serializeError` calls. Fixes to `{ error: serializeError(err) }` and inserts
 * a depth-aware import when needed.
 */

const path = require('node:path');

const LOG_METHODS = new Set(['error', 'warn', 'info', 'debug']);

// Both logger naming conventions are part of the rule's contract.
const LOG_RECEIVERS = new Set(['log', 'logger']);

// Recognizes direct receivers and one-level `.log`/`.logger` members.
function isLogCall(node) {
  if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') {
    return false;
  }
  const { property, object } = node.callee;
  if (property.type !== 'Identifier' || !LOG_METHODS.has(property.name)) {
    return false;
  }
  if (object.type === 'Identifier' && LOG_RECEIVERS.has(object.name)) return true;
  if (
    object.type === 'MemberExpression' &&
    object.property.type === 'Identifier' &&
    LOG_RECEIVERS.has(object.property.name)
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

/** Computes a depth-aware helper import under `src/server`, with a legacy fallback outside it. */
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

function buildImportFixes(fixer, context) {
  const sourceCode = context.sourceCode;
  const text = sourceCode.getText();
  if (text.includes('serializeError')) return [];

  const importPath = computeImportPath(context.filename);
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

function checkObjectArg(node, firstArg, context) {
  for (const prop of firstArg.properties) {
    if (prop.type !== 'Property') continue;

    const keyName =
      prop.key.type === 'Identifier'
        ? prop.key.name
        : prop.key.type === 'Literal'
          ? String(prop.key.value)
          : null;
    if (keyName !== 'error' && keyName !== 'err') continue;

    const value = prop.value;
    let traceTarget;
    let valueText;
    if (value.type === 'Identifier') {
      traceTarget = value;
      valueText = value.name;
    } else if (value.type === 'MemberExpression') {
      // Trace only noncomputed member chains to a root catch binding.
      let cursor = value;
      let bail = false;
      while (cursor.type === 'MemberExpression') {
        if (cursor.computed) {
          bail = true;
          break;
        }
        cursor = cursor.object;
      }
      if (bail || cursor.type !== 'Identifier') continue;
      traceTarget = cursor;
      valueText = context.sourceCode.getText(value);
    } else {
      continue;
    }
    if (!isErrorSource(traceTarget, context)) continue;

    context.report({
      node: prop,
      messageId: 'rawError',
      fix(fixer) {
        const fixText = `error: serializeError(${valueText})`;
        return [fixer.replaceText(prop, fixText), ...buildImportFixes(fixer, context)];
      },
    });
  }
}

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
