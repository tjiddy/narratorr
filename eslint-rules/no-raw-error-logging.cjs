/**
 * Rejects raw error values passed to a printer — Pino (`log`/`logger`) or `console` — as object
 * values, bare identifiers, or bare `serializeError` calls. Fixes Pino sites to
 * `{ error: serializeError(err) }` with a depth-aware import; console sites report without a fix,
 * because their remedy is per-site (`logCrash` for the boot catch, `getErrorMessage` for the
 * migration CLI, which wants readable text rather than a JSON record).
 *
 * The contract this implements is the behaviour table in #2604 AC7, executed by the RuleTester
 * suite next door. Extend the table and the suite, not this prose.
 */

const path = require('node:path');

// Every level Pino ships. `fatal` is where losing the error detail costs the most.
const LOG_METHODS = new Set(['error', 'warn', 'info', 'debug', 'fatal', 'trace']);

// Both logger naming conventions are part of the rule's contract.
const LOG_RECEIVERS = new Set(['log', 'logger']);

// `console.error(msg, err)` hands the object to util.inspect, which prints own enumerable
// properties — a DrizzleQueryError's `query` and `params` included (#2604 AC7).
const CONSOLE_METHODS = new Set(['error', 'warn', 'info', 'debug', 'log', 'trace']);

/**
 * A BARE printer argument is claimed only under these spellings. Name-agnostic was measured
 * against HEAD and flags ~25 ordinary structured-log objects, and separating them needs type
 * information a syntactic rule does not have. The object-property arm carries no such gate: a
 * property literally keyed `error` is unambiguous whatever its value is named.
 */
const BARE_ERROR_NAMES = new Set(['error', 'err', 'e']);

const PINO = 'pino';
const CONSOLE = 'console';

// The object keys the rule claims. Both fold into `error`, which is the key Pino serializes.
const ERROR_KEYS = new Set(['error', 'err']);

/** Direct receivers, one-level `.log`/`.logger` members, and `console`. */
function classifyPrinter(node) {
  if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return null;
  const { property, object } = node.callee;
  if (property.type !== 'Identifier') return null;

  if (object.type === 'Identifier' && object.name === 'console') {
    return CONSOLE_METHODS.has(property.name) ? CONSOLE : null;
  }
  if (!LOG_METHODS.has(property.name)) return null;
  if (object.type === 'Identifier' && LOG_RECEIVERS.has(object.name)) return PINO;
  if (
    object.type === 'MemberExpression' &&
    object.property.type === 'Identifier' &&
    LOG_RECEIVERS.has(object.property.name)
  ) {
    return PINO;
  }
  return null;
}

/** The innermost binding for a name, or null. Closest binding wins — case C9. */
function resolveBinding(identifierNode, context) {
  let currentScope = context.sourceCode.getScope(identifierNode);
  while (currentScope) {
    for (const variable of currentScope.variables) {
      if (variable.name === identifierNode.name) return variable;
    }
    currentScope = currentScope.upper;
  }
  return null;
}

/** The `.catch(err => …)` callback parameter — a caught value that is not a CatchClause binding. */
function isCatchCallbackParam(variable) {
  return variable.defs.some((def) => {
    if (def.type !== 'Parameter') return false;
    const call = def.node.parent;
    return (
      call &&
      call.type === 'CallExpression' &&
      call.callee.type === 'MemberExpression' &&
      call.callee.property.type === 'Identifier' &&
      call.callee.property.name === 'catch'
    );
  });
}

/** A value the program CAUGHT: a catch clause binding or a `.catch()` callback parameter. */
function isCaughtBinding(identifierNode, context) {
  const variable = resolveBinding(identifierNode, context);
  if (variable === null) return false;
  return variable.defs.some((def) => def.type === 'CatchClause') || isCatchCallbackParam(variable);
}

/**
 * A catch binding or ANY function parameter. The parameter arm is what reaches Fastify's
 * `setErrorHandler((error, req, reply) => …)` and the named `v1ErrorHandler` — both real leaks
 * this rule could not see while it traced catch bindings only (#2604 AC7 R5/R6). It is purely
 * syntactic: `getScope` resolves parameters natively, so no type checker is involved.
 */
function isErrorSource(identifierNode, context) {
  const variable = resolveBinding(identifierNode, context);
  if (variable === null) return false;
  return variable.defs.some((def) => def.type === 'CatchClause' || def.type === 'Parameter');
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

/** The root identifier of a non-computed member chain, or null. */
function memberChainRoot(node) {
  let cursor = node;
  while (cursor.type === 'MemberExpression') {
    if (cursor.computed) return null;
    cursor = cursor.object;
  }
  return cursor.type === 'Identifier' ? cursor : null;
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

/**
 * Returns the value's source text when it traces to an error source, else null.
 *
 * Noncomputed member chains are traced only to a CAUGHT binding. An ordinary function parameter is
 * accepted as a WHOLE value only — measured narrowing (#2604): a typed handler's `error.message`
 * is a rendered string the site authored on purpose (`download-resolve-adapter-url.ts:81`), and a
 * syntactic rule cannot tell that from a raw read. The whole-value shape is unambiguous either way,
 * which is what R7 needs.
 */
function traceErrorValue(value, context) {
  if (value.type === 'Identifier') {
    return isErrorSource(value, context) ? value.name : null;
  }
  if (value.type !== 'MemberExpression') return null;

  const root = memberChainRoot(value);
  if (!root || !isCaughtBinding(root, context)) return null;
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

function checkObjectArg(objectArg, context, fixable) {
  const entries = objectArg.properties.map((prop) => ({
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
  const canFix = fixable && serializer !== SERIALIZER_CONFLICTING && isObjectFixable(entries, matches);

  for (const match of matches) {
    context.report({
      node: match.prop,
      messageId: 'rawError',
      fix:
        canFix && match === first
          ? (fixer) => [
              fixer.replaceText(first.prop, `error: serializeError(${first.valueText})`),
              ...(extra ? [removeProperty(fixer, extra.prop, context)] : []),
              ...buildImportFixes(fixer, context, serializer),
            ]
          : null,
    });
  }
}

function checkBareIdentifierArg(identifierArg, context, fixable) {
  if (!BARE_ERROR_NAMES.has(identifierArg.name)) return;
  if (!isErrorSource(identifierArg, context)) return;

  const serializer = classifySerializer(identifierArg, context);

  context.report({
    node: identifierArg,
    messageId: 'rawError',
    fix:
      !fixable || serializer === SERIALIZER_CONFLICTING
        ? null
        : (fixer) => [
            fixer.replaceText(identifierArg, `{ error: serializeError(${identifierArg.name}) }`),
            ...buildImportFixes(fixer, context, serializer),
          ],
  });
}

/**
 * A bare member chain — `log.error(error.cause, 'x')`. `traceErrorValue` has always understood
 * these; the visitor simply never handed it one (#2604 AC7 R4). Reported without a fix: wrapping
 * in place would collide with the object arm's fixer for no benefit at a live site count of zero.
 */
function checkBareMemberArg(memberArg, context) {
  const root = memberChainRoot(memberArg);
  if (!root || !BARE_ERROR_NAMES.has(root.name)) return;
  if (traceErrorValue(memberArg, context) === null) return;

  context.report({ node: memberArg, messageId: 'rawError' });
}

function checkBareSerializeErrorArg(firstArg, context) {
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
        const printer = classifyPrinter(node);
        if (!printer) return;

        // The autofix inserts `serializeError` under an `error` key, which is only correct in
        // Pino's merge-object slot. Console remedies are per-site, so that arm reports fixless.
        const fixable = printer === PINO;

        // Pino's signature is `(mergeObject, message, ...interpolation)`, so only argument 0 can
        // carry an error. `console.error(msg, err)` has no merge slot at all and both live leaks
        // pass the error at argument 1 — hence the split (#2604 AC7 R1/R2, F18).
        const inspected = printer === CONSOLE ? node.arguments : node.arguments.slice(0, 1);

        inspected.forEach((arg, index) => {
          if (arg.type === 'ObjectExpression') {
            checkObjectArg(arg, context, fixable);
          } else if (arg.type === 'Identifier') {
            checkBareIdentifierArg(arg, context, fixable && index === 0);
          } else if (arg.type === 'MemberExpression') {
            checkBareMemberArg(arg, context);
          } else if (arg.type === 'CallExpression' && fixable && index === 0) {
            checkBareSerializeErrorArg(arg, context);
          }
        });
      },
    };
  },
};

module.exports = rule;
