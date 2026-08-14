import { describe, it, expect, expectTypeOf } from 'vitest';
import { mamUserStatusSchema, type MAMUserStatus } from './mam-schemas.js';

// The fields the operator's live account returned for jsonLoad.php?snatch_summary (#2322).
const SNATCH_SUMMARY_RESPONSE = {
  username: 'testuser',
  classname: 'VIP',
  wedges: 7,
  uid: 12345,
  ratio: 4.2,
  seedbonus: 91234,
  vip_until: '2027-01-01',
  unsat: { count: 139, limit: 150, size: 73954762929, red: false },
  seedUnsat: { count: 139, red: false, size: 73954762929 },
  inactUnsat: { count: 0, red: true, size: null },
  seedHnr: { count: 0, red: true, size: null },
  inactHnr: { count: 0, red: true, size: null },
  sSat: { count: 578, red: false, size: 459359749269 },
  connectable: 'yes',
};

describe('mamUserStatusSchema — snatch_summary (#2322)', () => {
  it('parses the documented payload and exposes the unsatisfied pair', () => {
    const parsed = mamUserStatusSchema.parse(SNATCH_SUMMARY_RESPONSE);
    expect(parsed.unsat?.count).toBe(139);
    expect(parsed.unsat?.limit).toBe(150);
  });

  // .passthrough() would surface `unsat` at runtime regardless, so the schema-owned shape is
  // only observable at the type level — this is what refreshStatus reads.
  it('declares unsat as a schema field rather than leaving it to passthrough', () => {
    expectTypeOf<NonNullable<MAMUserStatus['unsat']>['count']>().toEqualTypeOf<number | null | undefined>();
    expectTypeOf<NonNullable<MAMUserStatus['unsat']>['limit']>().toEqualTypeOf<number | null | undefined>();
  });

  it('keeps every previously parsed field intact on the wider response', () => {
    const parsed = mamUserStatusSchema.parse(SNATCH_SUMMARY_RESPONSE);
    expect(parsed.username).toBe('testuser');
    expect(parsed.classname).toBe('VIP');
    expect(parsed.wedges).toBe(7);
  });

  it('passes through the unrelated snatch_summary groups', () => {
    const parsed = mamUserStatusSchema.parse(SNATCH_SUMMARY_RESPONSE) as Record<string, unknown>;
    expect(parsed.sSat).toEqual({ count: 578, red: false, size: 459359749269 });
    expect(parsed.connectable).toBe('yes');
  });

  describe('a malformed unsat never fails the whole parse', () => {
    // .optional() rejects null, and MAM returns null for absent values — a rejected parse
    // becomes an IndexerError that disables searching entirely.
    const cases: Array<{ name: string; unsat: unknown }> = [
      { name: 'absent', unsat: undefined },
      { name: 'null', unsat: null },
      { name: 'a string', unsat: '139/150' },
      { name: 'a number', unsat: 139 },
      { name: 'null members', unsat: { count: null, limit: null } },
      { name: 'string members', unsat: { count: '139', limit: '150' } },
    ];

    for (const { name, unsat } of cases) {
      it(`parses successfully when unsat is ${name}, still delivering classname and username`, () => {
        const body = { username: 'testuser', classname: 'VIP', wedges: 7, ...(unsat !== undefined && { unsat }) };
        const parsed = mamUserStatusSchema.safeParse(body);
        expect(parsed.success).toBe(true);
        expect(parsed.data?.username).toBe('testuser');
        expect(parsed.data?.classname).toBe('VIP');
        expect(parsed.data?.wedges).toBe(7);
      });
    }

    it('drops a wrong-typed unsat instead of passing the junk through', () => {
      const parsed = mamUserStatusSchema.parse({ username: 'u', classname: 'VIP', unsat: '139/150' });
      expect(parsed.unsat).toBeUndefined();
    });
  });

  it('still rejects a response whose classname is the wrong type', () => {
    expect(mamUserStatusSchema.safeParse({ username: 'u', classname: 42 }).success).toBe(false);
  });
});
