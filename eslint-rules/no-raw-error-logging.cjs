/**
 * Rejects catch-sourced errors passed raw to Pino as object values, bare identifiers,
 * or bare `serializeError` calls. Fixes to `{ error: serializeError(err) }` and inserts
 * a depth-aware import when needed.
 */

const path = require('node:path');

// Every level Pino ships. `fatal` is where losing the error detail costs the most.
const LOG_METHODS = new Set(['error', 'warn', 'info', 'debug', 'fatal', 'trace']);

// Both logger naming conventions are part of the rule's contract.
const LOG_RECEIVERS = new Set(['log', 'logger']);

// The object keys the rule claims. Both fold into `error`, which is the key Pino serializes.
const ERROR_KEYS = new Set(['error', 'err']);

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

// What the fixer found under the name `serializeError` at the report site. It recognises exactly
// one thing — the import it would otherwise write — and treats every other binding as unusable:
// deciding whether some other `serializeError` is a safe serializer needs a type checker.
const SERIALIZER_ABSENT = 'absent';
const SERIALIZER_CANONICAL = 'canonical';
const SERIALIZER_CONFLICTING = 'conflicting';

function classifySerializer(node, context) {
  const variable = findVariable(node, 'serializeError', context);
  if (!variable) return SERIALIZER_ABSENT;
  if (variable.defs.length !== 1) return SERIALIZER_CONFLICTING;

  const def = variable.defs[0];
  if (def.type !== 'ImportBinding') return SERIALIZER_CONFLICTING;

  const specifier = def.node;
  const declaration = def.parent;
  const isCanonical =
    specifier.type === 'ImportSpecifier' &&
    specifier.imported.type === 'Identifier' &&
    specifier.imported.name === 'serializeError' &&
    // Both `importKind` flags: `import type { x }` marks the declaration while the specifier
    // still reads 'value', and `import { type x }` marks the specifier. Either lets a type-only
    // binding through if the other side is not checked.
    specifier.importKind === 'value' &&
    declaration.importKind === 'value' &&
    // "Already imported" means literally "the import we were about to add is already there".
    declaration.source.value === computeImportPath(context.filename);
  return isCanonical ? SERIALIZER_CANONICAL : SERIALIZER_CONFLICTING;
}

function findVariable(node, name, context) {
  let currentScope = context.sourceCode.getScope(node);
  while (currentScope) {
    for (const variable of currentScope.variables) {
      // Closest binding wins, matching `isErrorSource` and case C9.
      if (variable.name === name) return variable;
    }
    currentScope = currentScope.upper;
  }
  return null;
}

function buildImportFixes(fixer, context, serializer) {
  if (serializer === SERIALIZER_CANONICAL) return [];
  const sourceCode = context.sourceCode;

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

/** The key a property reports under. Computed spellings included — matching is frozen. */
function resolveReportKey(key) {
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'Literal') return String(key.value);
  return null;
}

/**
 * The key an entry provably produces at runtime, or null when it is not statically decidable.
 * A spread's keys and a dynamic computed key are both unknowable, and the fixer will not rename
 * anything into an object whose key set it cannot read in full.
 */
function resolveStaticKey(prop) {
  if (prop.type !== 'Property') return null;
  if (prop.key.type === 'Literal') return String(prop.key.value);
  if (!prop.computed && prop.key.type === 'Identifier') return prop.key.name;
  return null;
}

/** Returns the value's source text when it traces to a catch binding, else null. */
function traceErrorValue(value, context) {
  if (value.type === 'Identifier') {
    return isErrorSource(value, context) ? value.name : null;
  }
  if (value.type !== 'MemberExpression') return null;

  // Trace only noncomputed member chains to a root catch binding.
  let cursor = value;
  while (cursor.type === 'MemberExpression') {
    if (cursor.computed) return null;
    cursor = cursor.object;
  }
  if (cursor.type !== 'Identifier' || !isErrorSource(cursor, context)) return null;
  return context.sourceCode.getText(value);
}

/**
 * Whether the fix can be emitted at all, decided from EVERY entry rather than from the matched
 * properties alone: the fix renames a key to `error`, so it is safe only when the resulting
 * object provably carries exactly one entry producing that key.
 */
function isObjectFixable(entries, matches) {
  const seenKeys = new Set();
  for (const entry of entries) {
    if (entry.staticKey === null) return false; // (a) a spread or a dynamic computed key
    // (b) a repeated key means last-one-wins already killed an entry; renaming the dead one
    // would resurrect a value the original object never logged.
    if (seenKeys.has(entry.staticKey)) return false;
    seenKeys.add(entry.staticKey);
  }
  // (c) the matches collapse into one `error` entry, so an unmatched `error` would collide.
  if (entries.some((entry) => entry.valueText === null && entry.staticKey === 'error')) {
    return false;
  }

  // A fold deletes an evaluation, not just a key. That is only inert for a plain local binding:
  // `isErrorSource` guarantees a catch binding, but re-reading a member chain may hit an
  // accessor or a Proxy trap, so identical text is not grounds for collapsing two reads into one.
  const [first] = matches;
  return matches.every(
    (entry) =>
      entry === first ||
      (entry.prop.value.type === 'Identifier' &&
        first.prop.value.type === 'Identifier' &&
        entry.prop.value.name === first.prop.value.name),
  );
}

/**
 * Removes a property together with the comma in front of it. A bare removal would leave
 * `{a, , b}` for a middle property, which does not parse. The preceding comma is always the one
 * to take: the property being removed is the *second* match, so an entry always precedes it —
 * and unlike the trailing comma it carries the removed property's leading whitespace with it.
 */
function removeProperty(fixer, prop, context) {
  const comma = context.sourceCode.getTokenBefore(prop);
  return fixer.removeRange([comma.range[0], prop.range[1]]);
}

function checkObjectArg(node, firstArg, context) {
  const entries = firstArg.properties.map((prop) => ({
    prop,
    staticKey: resolveStaticKey(prop),
    valueText:
      prop.type === 'Property' && ERROR_KEYS.has(resolveReportKey(prop.key))
        ? traceErrorValue(prop.value, context)
        : null,
  }));

  const matches = entries.filter((entry) => entry.valueText !== null);
  if (matches.length === 0) return;

  // (b) caps a fixable object at two matches — only `error` and `err` match and neither key may
  // repeat — so a fold is always 2 -> 1 and exactly one removal range is ever generated.
  const [first, extra] = matches;

  const serializer = classifySerializer(first.prop, context);
  const fixable = serializer !== SERIALIZER_CONFLICTING && isObjectFixable(entries, matches);

  for (const match of matches) {
    context.report({
      node: match.prop,
      messageId: 'rawError',
      fix:
        fixable && match === first
          ? (fixer) => [
              fixer.replaceText(first.prop, `error: serializeError(${first.valueText})`),
              ...(extra ? [removeProperty(fixer, extra.prop, context)] : []),
              ...buildImportFixes(fixer, context, serializer),
            ]
          : null,
    });
  }
}

function checkBareIdentifierArg(node, firstArg, context) {
  if (firstArg.type !== 'Identifier') return;
  if (!isErrorSource(firstArg, context)) return;

  const serializer = classifySerializer(firstArg, context);

  context.report({
    node: firstArg,
    messageId: 'rawError',
    fix:
      serializer === SERIALIZER_CONFLICTING
        ? null
        : (fixer) => [
            fixer.replaceText(firstArg, `{ error: serializeError(${firstArg.name}) }`),
            ...buildImportFixes(fixer, context, serializer),
          ],
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
