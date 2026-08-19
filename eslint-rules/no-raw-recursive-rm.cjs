/**
 * Routes every recursive tree removal through `removeTree`/`removeTreeSync`
 * (`src/core/utils/remove-tree.ts`), which owns the app's bounded retry for the transient failures
 * Node names as retryable. Keyed on the OPTION SHAPE, not the import: non-recursive
 * `rm(file, { force: true })` is legitimate at ten production sites and must stay reportable-free.
 * The helper itself is required to write the exact shape reported here, so it is exempted by
 * filename in eslint.config.js rather than by anything in this rule.
 *
 * Deliberately narrow: an options argument that is not an object literal is left alone, because a
 * resolved-identifier analysis would trade a false-negative for false positives on shared option
 * objects. Err toward reporting on literals; justify any rule suppression.
 */

const REMOVAL_NAMES = new Set(['rm', 'rmSync']);

/** Returns the import this identifier resolves to, or null for locals, parameters, and globals. */
function importBindingOf(identifierNode, context) {
  let scope = context.sourceCode.getScope(identifierNode);
  while (scope) {
    const variable = scope.variables.find((v) => v.name === identifierNode.name);
    if (variable) {
      const def = variable.defs[0];
      if (!def || def.type !== 'ImportBinding' || def.node.type !== 'ImportSpecifier') return null;
      const imported = def.node.imported;
      return imported && imported.type === 'Identifier' ? imported.name : null;
    }
    scope = scope.upper;
  }
  return null;
}

/** Statically known property name for `fs.rm` and `fs['rm']` alike. */
function staticPropertyName(memberExpression) {
  const { property, computed } = memberExpression;
  if (!computed && property.type === 'Identifier') return property.name;
  if (computed && property.type === 'Literal' && typeof property.value === 'string') return property.value;
  return null;
}

/** The removal this callee names — through a member access or a renamed import binding. */
function removalNameOf(callee, context) {
  if (callee.type === 'MemberExpression') {
    const name = staticPropertyName(callee);
    return name !== null && REMOVAL_NAMES.has(name) ? name : null;
  }
  if (callee.type !== 'Identifier') return null;
  if (REMOVAL_NAMES.has(callee.name)) return callee.name;
  const imported = importBindingOf(callee, context);
  return imported !== null && REMOVAL_NAMES.has(imported) ? imported : null;
}

function keyName(property) {
  if (property.type !== 'Property') return null;
  const { key, computed } = property;
  if (!computed && key.type === 'Identifier') return key.name;
  if (key.type === 'Literal') return typeof key.value === 'string' ? key.value : null;
  return null;
}

/** True only for an explicit `recursive: true` own key; a spread alone proves nothing. */
function declaresRecursive(optionsNode) {
  if (!optionsNode || optionsNode.type !== 'ObjectExpression') return false;
  return optionsNode.properties.some(
    (p) => keyName(p) === 'recursive' && p.value.type === 'Literal' && p.value.value === true,
  );
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require removeTree/removeTreeSync instead of a raw recursive fs.rm, so tree removal keeps one retry policy.',
    },
    // No autofixer: a correct fix must also add the import.
    schema: [],
    messages: {
      rawRecursiveRm:
        'Use removeTree/removeTreeSync from @core/utils/remove-tree.js instead of a raw recursive `{{name}}` — it owns the bounded retry for transient EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM failures (#2370).',
    },
  },

  create(context) {
    return {
      CallExpression(node) {
        const name = removalNameOf(node.callee, context);
        if (name === null) return;
        if (!declaresRecursive(node.arguments[1])) return;
        context.report({ node, messageId: 'rawRecursiveRm', data: { name } });
      },
    };
  },
};

module.exports = rule;
