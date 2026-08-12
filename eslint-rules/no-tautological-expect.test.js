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
  ],
});
