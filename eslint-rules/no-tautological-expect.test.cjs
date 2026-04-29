const { RuleTester } = require('eslint');
const rule = require('./no-tautological-expect.cjs');

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

ruleTester.run('no-tautological-expect', rule, {
  valid: [
    // Real assertions comparing against an expression
    { code: `expect(getValue()).toBe(42);` },
    // Identifier-based reference equality (legitimate)
    { code: `expect(x).toBe(x);` },
    // Different literal values
    { code: `expect(true).toBe(false);` },
    { code: `expect(1).toBe(2);` },
    { code: `expect('a').toBe('b');` },
    // Different matchers that aren't equality
    { code: `expect(x).toBeTruthy();` },
    { code: `expect(x).toBeDefined();` },
    // Object/array literals — not in scope (literalValue returns unknown)
    { code: `expect({}).toEqual({});` },
    { code: `expect([]).toEqual([]);` },
    // Mixed literal vs identifier
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

console.log('no-tautological-expect: all tests passed');
