// Rejects equal literal assertions for toBe/toEqual/toStrictEqual; identifier equality remains valid reference testing.

const TAUTOLOGY_MATCHERS = new Set(['toBe', 'toEqual', 'toStrictEqual']);

function literalValue(node) {
  if (!node) return { kind: 'unknown' };
  if (node.type === 'Literal') {
    return { kind: 'literal', value: node.value };
  }
  if (node.type === 'Identifier' && node.name === 'undefined') {
    return { kind: 'literal', value: undefined };
  }
  if (
    node.type === 'UnaryExpression' &&
    node.operator === '-' &&
    node.argument.type === 'Literal' &&
    typeof node.argument.value === 'number'
  ) {
    return { kind: 'literal', value: -node.argument.value };
  }
  return { kind: 'unknown' };
}

// Deliberately narrow. A blanket `expect.<member>(...)` would pull in the asymmetric-matcher
// factories (`expect.any`, `expect.objectContaining`, …), whose argument is a matcher
// specification, not an assertion subject.
const EXPECT_MEMBERS = new Set(['soft']);

function isExpectCall(node) {
  if (!node || node.type !== 'CallExpression' || node.arguments.length < 1) return false;
  const { callee } = node;
  if (callee.type === 'Identifier') return callee.name === 'expect';
  return (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'expect' &&
    callee.property.type === 'Identifier' &&
    EXPECT_MEMBERS.has(callee.property.name)
  );
}

// Strips at most one `.not`. Traversing further would accept `expect(x).not.not.toBe(x)`,
// which is not a tautology — the second negation restores the original assertion.
function unwrapNegation(node) {
  if (
    node &&
    node.type === 'MemberExpression' &&
    !node.computed &&
    node.property.type === 'Identifier' &&
    node.property.name === 'not'
  ) {
    return { subject: node.object, negated: true };
  }
  return { subject: node, negated: false };
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow tautological expect(<literal>).toBe(<same literal>) assertions in test files',
    },
    schema: [],
    messages: {
      tautology:
        'Tautological assertion: `expect({{lhs}}).{{matcher}}({{rhs}})` always passes regardless of production behavior. Replace with an assertion that exercises the code under test, or remove if the test should rely on absence of exceptions.',
      negatedTautology:
        'Tautological assertion: `expect({{lhs}}).not.{{matcher}}({{rhs}})` always fails regardless of production behavior. Replace with an assertion that exercises the code under test, or remove it.',
    },
  },

  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type !== 'MemberExpression') return;
        const matcherName =
          node.callee.property.type === 'Identifier' ? node.callee.property.name : null;
        if (!matcherName || !TAUTOLOGY_MATCHERS.has(matcherName)) return;
        if (node.arguments.length !== 1) return;

        const { subject: expectCall, negated } = unwrapNegation(node.callee.object);
        if (!isExpectCall(expectCall)) return;

        const lhs = literalValue(expectCall.arguments[0]);
        const rhs = literalValue(node.arguments[0]);
        if (lhs.kind !== 'literal' || rhs.kind !== 'literal') return;
        if (!Object.is(lhs.value, rhs.value)) return;

        const sourceCode = context.sourceCode;
        context.report({
          node,
          messageId: negated ? 'negatedTautology' : 'tautology',
          data: {
            lhs: sourceCode.getText(expectCall.arguments[0]),
            matcher: matcherName,
            rhs: sourceCode.getText(node.arguments[0]),
          },
        });
      },
    };
  },
};

module.exports = rule;
