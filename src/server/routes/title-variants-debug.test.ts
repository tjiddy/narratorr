import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, createMockServices } from '../__tests__/helpers.js';
import { titleVariantsDebugResponseSchema } from '@shared/schemas.js';

// NOTE: no auth/CSRF assertions here on purpose — `createTestApp` registers no
// `authPlugin`, so any such assertion would pass vacuously
// (`createtestapp-omits-auth-plugin`). The route inherits the standard `/api/*`
// hook and adds no auth surface of its own.
describe('POST /api/series/title-variants-debug', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;

  beforeAll(async () => {
    app = await createTestApp(createMockServices());
  });

  afterAll(async () => {
    await app.close();
  });

  function post(payload: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: '/api/series/title-variants-debug', payload });
  }

  it('returns 200 with { input, full, variants } conforming to the shared schema', async () => {
    const res = await post({ title: 'star wars: the high republic: Light of the Jedi (New Order Series)' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(titleVariantsDebugResponseSchema.safeParse(body).success).toBe(true);
    expect(body.input).toBe('star wars: the high republic: Light of the Jedi (New Order Series)');
    expect(body.full).toBe('star wars the high republic light of the jedi new order series');
    expect(body.variants).toEqual([
      { raw: 'star wars the high republic light of the jedi new order series', tag: 'full', parensStripped: false },
      { raw: 'star wars the high republic light of the jedi', tag: 'full', parensStripped: true },
      { raw: 'star wars the high republic', tag: 'prefix(2)', parensStripped: true },
      { raw: 'the high republic light of the jedi', tag: 'suffix(2)', parensStripped: true },
      { raw: 'star wars light of the jedi', tag: 'first+last', parensStripped: true },
      { raw: 'star wars', tag: 'prefix(1)', parensStripped: true },
      { raw: 'light of the jedi', tag: 'suffix(1)', parensStripped: true },
    ]);
  });

  it('echoes the TRIMMED title as input', async () => {
    const res = await post({ title: '  Chapterhouse: Dune  ' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.input).toBe('Chapterhouse: Dune');
    expect(body.full).toBe('chapterhouse dune');
  });

  // The zero-variant arm. Asserted explicitly so it is never "fixed" into a 400:
  // an empty variant set is the diagnostic answer for a title that carries no
  // alphanumerics, and it is exactly why such a member cannot pair on the title path.
  it('returns 200 with variants: [] and full: "" for a title that yields no variants', async () => {
    const res = await post({ title: '[ ]' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(titleVariantsDebugResponseSchema.safeParse(body).success).toBe(true);
    expect(body.full).toBe('');
    expect(body.variants).toEqual([]);
  });

  it.each([
    ['missing title', {}],
    ['empty string', { title: '' }],
    ['whitespace only', { title: '   ' }],
    ['over 1024 characters', { title: 'x'.repeat(1025) }],
  ])('returns 400 for %s', async (_label, payload) => {
    expect((await post(payload)).statusCode).toBe(400);
  });

  it('accepts a title at exactly the 1024-character bound', async () => {
    expect((await post({ title: 'x'.repeat(1024) })).statusCode).toBe(200);
  });
});
