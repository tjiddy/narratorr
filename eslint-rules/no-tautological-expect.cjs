/**
 * ESLint rule: no-tautological-expect
 *
 * Disallows tautological assertions of the form `expect(<literal>).toBe(<same literal>)`
 * (or `.toEqual(<same literal>)`, `.toStrictEqual(<same literal>)`).
 *
 * These assertions pass regardless of whether the production code under test works —
 * `expect(true).toBe(true)`, `expect(1).toBe(1)`, `expect(false).toBe(false)`, etc.
 * They give false confidence and let regressions slip through. If a test only needs
 * to check "the function did not throw," omit the assertion and let the test framework
 * fail on uncaught exceptions; if it needs to verify behavior, write an assertion that
 * actually exercises that behavior.
 *
 * Matches literals that compare equal: same primitive value (boolean, number, string,
 * null, undefined). Does NOT flag identifier-based tautologies (`expect(x).toBe(x)`)
 * because those legitimately appear in reference-equality tests.
 */

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

function isExpectCall(node) {
  return (
    node &&
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === 'expect' &&
    node.arguments.length >= 1
  );
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
    },
  },

  create(context) {
    return {
      CallExpression(node) {
        // Match `<expectCall>.<matcher>(<arg>)`
        if (node.callee.type !== 'MemberExpression') return;
        const matcherName =
          node.callee.property.type === 'Identifier' ? node.callee.property.name : null;
        if (!matcherName || !TAUTOLOGY_MATCHERS.has(matcherName)) return;
        if (node.arguments.length !== 1) return;

        const expectCall = node.callee.object;
        if (!isExpectCall(expectCall)) return;

        const lhs = literalValue(expectCall.arguments[0]);
        const rhs = literalValue(node.arguments[0]);
        if (lhs.kind !== 'literal' || rhs.kind !== 'literal') return;
        if (!Object.is(lhs.value, rhs.value)) return;

        const sourceCode = context.sourceCode;
        context.report({
          node,
          messageId: 'tautology',
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
