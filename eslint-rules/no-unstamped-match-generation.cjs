/**
 * Requires row constructions that install, replace, or clear `matchResult` to reach trusted
 * `stampRow` argument zero, preventing stale generations from promoting rebuilt evidence.
 * Producers are object literals with an own `matchResult` key and trusted `mergeMatchIntoRow`
 * calls; trust follows import bindings through result-preserving wrappers and one object spread.
 * Mutations are invisible, argument one only proves identifier shape rather than React locality,
 * and unrelated stamps cannot be rejected. Err toward reporting; justify any rule suppression.
 */

const TRACKED_KEY = 'matchResult';

// Trust exact import roots; a same-named symbol from another module is unrelated.
const TRUSTED_STAMP = { imported: 'stampRow', module: '@/lib/repick-corroboration.js' };
const TRUSTED_MERGE = { imported: 'mergeMatchIntoRow', module: '@/components/manual-import' };

// Exempt the terminal corroboration write and the sanctioned merge producer themselves.
const PRODUCER_FILES = new Set(['repick-corroboration.ts', 'mergeMatchIntoRow.ts']);

// Only result-producing branches preserve flow; the parser erases parentheses.
const WRAPPER_STEPS = {
  LogicalExpression: (child, parent) => child === parent.left || child === parent.right,
  ConditionalExpression: (child, parent) => child === parent.consequent || child === parent.alternate,
  TSAsExpression: (child, parent) => child === parent.expression,
  TSSatisfiesExpression: (child, parent) => child === parent.expression,
  TSNonNullExpression: (child, parent) => child === parent.expression,
};

function basenameOf(filePath) {
  const normalized = (filePath || '').replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

/** Returns a statically known string key, including shorthand/literal/computed-constant forms. */
function ownKeyName(property) {
  if (property.type !== 'Property') return null;
  const { key, computed } = property;
  if (!computed && key.type === 'Identifier') return key.name;
  if (key.type === 'Literal') return typeof key.value === 'string' ? key.value : null;
  return null;
}

function installsMatchResult(objectExpression) {
  return objectExpression.properties.some((p) => ownKeyName(p) === TRACKED_KEY);
}

/** Returns the import this identifier resolves to through the scope chain, or null for locals, parameters, and globals. */
function importBindingOf(identifierNode, context) {
  let scope = context.sourceCode.getScope(identifierNode);
  while (scope) {
    const variable = scope.variables.find((v) => v.name === identifierNode.name);
    if (variable) {
      const def = variable.defs[0];
      if (!def || def.type !== 'ImportBinding' || def.node.type !== 'ImportSpecifier') return null;
      const imported = def.node.imported;
      const declaration = def.parent;
      if (!imported || imported.type !== 'Identifier' || !declaration || !declaration.source) return null;
      return { imported: imported.name, module: declaration.source.value };
    }
    scope = scope.upper;
  }
  return null;
}

function isTrustedCallee(calleeNode, trusted, context) {
  if (!calleeNode || calleeNode.type !== 'Identifier') return false;
  const binding = importBindingOf(calleeNode, context);
  return binding !== null && binding.imported === trusted.imported && binding.module === trusted.module;
}

/**
 * Walks only result-preserving wrappers to trusted `stampRow` argument zero. Object spread may
 * hoist a producer once; ordinary property values must never count as installing a row key.
 */
function isStamped(producer, context) {
  let child = producer;
  let parent = producer.parent;
  while (parent) {
    if (parent.type === 'CallExpression') {
      return parent.arguments[0] === child && isTrustedCallee(parent.callee, TRUSTED_STAMP, context);
    }
    if (parent.type === 'SpreadElement') {
      if (parent.argument !== child) return false;
      // Only an object-literal spread hoists row keys.
      const spreadTarget = parent.parent;
      if (!spreadTarget || spreadTarget.type !== 'ObjectExpression') return false;
      child = spreadTarget;
      parent = spreadTarget.parent;
      continue;
    }
    const step = WRAPPER_STEPS[parent.type];
    if (!step || !step(child, parent)) return false;
    child = parent;
    parent = parent.parent;
  }
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require every row construction that installs, replaces or clears `matchResult` to route through `stampRow`, so the row carries a fresh `matchGeneration`. Errs toward reporting: suppress a legitimate shape with `// eslint-disable-next-line narratorr/no-unstamped-match-generation` plus a justifying comment.',
    },
    schema: [],
    messages: {
      unstamped:
        'This builds a row with `matchResult` installed, replaced or cleared without routing through `stampRow`, so the row keeps a stale `matchGeneration` and an in-flight chapter corroboration can promote it on rebuilt evidence (#2055 B7). Wrap it: `stampRow(<this>, generation)`, with `generation` taken from `nextGeneration()` OUTSIDE the updater.',
      generationNotIdentifier:
        "`stampRow`'s second argument must be a plain identifier holding a generation allocated OUTSIDE the `setRows` updater — StrictMode double-invokes updaters, so a stamp computed in there is not the value a concurrent dispatch captured (#2055 B11). Hoist it: `const generation = nextGeneration();` before the `setRows` call.",
    },
  },

  create(context) {
    if (PRODUCER_FILES.has(basenameOf(context.filename))) return {};

    function reportIfUnstamped(node) {
      if (isStamped(node, context)) return;
      context.report({ node, messageId: 'unstamped' });
    }

    return {
      ObjectExpression(node) {
        if (installsMatchResult(node)) reportIfUnstamped(node);
      },

      CallExpression(node) {
        if (isTrustedCallee(node.callee, TRUSTED_STAMP, context)) {
          // Enforce absence too; the invariant must survive a future optional/default parameter.
          const generation = node.arguments[1];
          if (!generation || generation.type !== 'Identifier') {
            context.report({ node: generation ?? node, messageId: 'generationNotIdentifier' });
          }
          return;
        }
        if (isTrustedCallee(node.callee, TRUSTED_MERGE, context)) reportIfUnstamped(node);
      },
    };
  },
};

module.exports = rule;
