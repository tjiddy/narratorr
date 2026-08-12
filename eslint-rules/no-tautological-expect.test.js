import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import rule from './no-tautological-expect.cjs';

// Wire RuleTester into Vitest so each case reports independently.
RuleTester.describe = describe;
RuleTester.it = it;

// Under this pnpm layout only the root `typescript-eslint` parser resolves here.
// Untyped on purpose: the rule is purely syntactic, and a TS program would import
// the #2239 single-run crash class for no benefit.
const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  },
});

ruleTester.run('no-tautological-expect', rule, {
  valid: [
    { code: `expect(getValue()).toBe(42);` },
    { code: `expect(x).toBe(x);` },
    { code: `expect(true).toBe(false);` },
    { code: `expect(1).toBe(2);` },
    { code: `expect('a').toBe('b');` },
    { code: `expect(x).toBeTruthy();` },
    { code: `expect(x).toBeDefined();` },
    { code: `expect({}).toEqual({});` },
    { code: `expect([]).toEqual([]);` },
    { code: `expect(true).toBe(value);` },
    { code: `expect(value).toBe(true);` },

    // Comparator and literal-kind boundaries.

    // Paired with the invalid `-0`/`-0` case: only Object.is separates these two.
    { name: 'B1 negative zero against positive zero', code: `expect(-0).toBe(0);` },
    { name: 'B3 NaN is a plain Identifier, not a literal', code: `expect(NaN).toBe(NaN);` },
    { name: 'B4 unary minus over a string argument', code: `expect(-'1').toBe(-'1');` },
    { name: 'B5 void operator', code: `expect(void 0).toBe(undefined);` },
    { name: 'B5 logical-not operator', code: `expect(true).toBe(!false);` },
    { name: 'B6 regex literals are distinct objects', code: `expect(/a/).toBe(/a/);` },
    { name: 'B7 template literal is not a Literal node', code: 'expect(`a`).toBe(`a`);' },

    // Shape guards on `expect(...)` and the matcher.

    { name: 'B10 computed matcher name', code: `expect(true)['toBe'](true);` },
    { name: 'B11 matcher with a second argument', code: `expect(true).toEqual(true, 'msg');` },
    { name: 'B12 toContain is outside the matcher allowlist', code: `expect(true).toContain(true);` },
    {
      name: 'B12 toMatchObject is outside the matcher allowlist',
      code: `expect(true).toMatchObject(true);`,
    },
    { name: 'B15 expect with no arguments', code: `expect().toBe(undefined);` },

    // TypeScript wrapper nodes — only writable at all because of the parser swap.

    { name: 'B16 TS assertion on the expect argument', code: `expect(x as boolean).toBe(true);` },
    { name: 'B16 TS assertion on the matcher argument', code: `expect(true).toBe(true as boolean);` },

    // The `expect.<member>` allowlist is narrow: asymmetric-matcher factories build a
    // matcher argument, not an assertion subject, so their call shape is not an expect call.

    { name: 'B19 expect.any is not an assertion subject', code: `expect.any(1).toBe(1);` },
    {
      name: 'B19 expect.stringContaining is not an assertion subject',
      code: `expect.stringContaining('a').toBe('a');`,
    },

    // Exactly one non-computed `.not` is traversed before the expect call.

    { name: 'B20 computed not property', code: `expect(true)['not'].toBe(true);` },
    { name: 'B20 resolves is not unwrapped', code: `expect(true).resolves.toBe(true);` },
    // The observable proof that the unwrap is one level and not a loop: unwrapping once
    // leaves `expect(true).not`, a MemberExpression, which is not an expect call.
    { name: 'B21 double negation', code: `expect(true).not.not.toBe(true);` },

    // The pre-`.not` shape guards still hold once the unwrap reaches them.

    {
      name: 'B22 negated matcher outside the matcher allowlist',
      code: `expect(true).not.toContain(true);`,
    },
    {
      name: 'B22 negated matcher with a second argument',
      code: `expect(true).not.toEqual(true, 'msg');`,
    },
    { name: 'B22 negated unequal literals', code: `expect(true).not.toBe(false);` },
    { name: 'B22 negated negative zero against positive zero', code: `expect(-0).not.toBe(0);` },
  ],
  invalid: [
    {
      code: `expect(true).toBe(true);`,
      errors: [{ messageId: 'tautology' }],
    },
    {
      code: `expect(false).toBe(false);`,
      errors: [{ messageId: 'tautology' }],
    },
    {
      code: `expect(1).toBe(1);`,
      errors: [{ messageId: 'tautology' }],
    },
    {
      code: `expect('hello').toBe('hello');`,
      errors: [{ messageId: 'tautology' }],
    },
    {
      code: `expect(null).toBe(null);`,
      errors: [{ messageId: 'tautology' }],
    },
    {
      code: `expect(undefined).toBe(undefined);`,
      errors: [{ messageId: 'tautology' }],
    },
    {
      code: `expect(true).toEqual(true);`,
      errors: [{ messageId: 'tautology' }],
    },
    {
      code: `expect(0).toStrictEqual(0);`,
      errors: [{ messageId: 'tautology' }],
    },
    {
      code: `expect(-1).toBe(-1);`,
      errors: [{ messageId: 'tautology' }],
    },

    // Comparator and literal-kind boundaries.

    {
      name: 'B1 negative zero against itself',
      code: `expect(-0).toBe(-0);`,
      errors: [{ messageId: 'tautology' }],
    },
    {
      name: 'B2 bigint literals flow through the Literal arm',
      code: `expect(1n).toBe(1n);`,
      errors: [{ messageId: 'tautology' }],
    },

    // Shape guards on `expect(...)`.

    {
      name: 'B13 extra expect arguments are ignored',
      code: `expect(true, 'x').toBe(true);`,
      errors: [{ messageId: 'tautology' }],
    },
    {
      name: 'B14 optional-call syntax still visits the CallExpression',
      code: `expect(true)?.toBe(true);`,
      errors: [{ messageId: 'tautology' }],
    },

    // Multiple reports and message data.

    {
      name: 'B17 two tautologies in one file report twice',
      code: `expect(1).toBe(1); expect('a').toBe('a');`,
      errors: [{ messageId: 'tautology' }, { messageId: 'tautology' }],
    },
    {
      // Different source text, equal values — a swapped lhs/rhs would change this message.
      name: 'B18 report data carries both operands verbatim',
      code: `expect(1).toBe(1.0);`,
      errors: [
        {
          messageId: 'tautology',
          data: { lhs: '1', matcher: 'toBe', rhs: '1.0' },
        },
      ],
    },

    // Shape widenings: the `expect.soft` subject and the single `.not` unwrap.

    {
      name: 'B9 expect.soft is an allowlisted expect member',
      code: `expect.soft(true).toBe(true);`,
      errors: [{ messageId: 'tautology' }],
    },
    {
      // The negated form always fails rather than always passing, so it carries its own message.
      name: 'B8 negated matcher',
      code: `expect(true).not.toBe(true);`,
      errors: [{ messageId: 'negatedTautology' }],
    },
    {
      name: 'B23 the soft subject and the negation compose',
      code: `expect.soft(true).not.toBe(true);`,
      errors: [{ messageId: 'negatedTautology' }],
    },
    {
      name: 'B23 negated negative zero against itself',
      code: `expect(-0).not.toBe(-0);`,
      errors: [{ messageId: 'negatedTautology' }],
    },
    {
      // The `.not` analogue of B18: a swapped or dropped operand changes only this message.
      name: 'B23 negated report data carries both operands verbatim',
      code: `expect(1).not.toBe(1.0);`,
      errors: [
        {
          messageId: 'negatedTautology',
          data: { lhs: '1', matcher: 'toBe', rhs: '1.0' },
        },
      ],
    },
  ],
});
