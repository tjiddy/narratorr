import { describe, it, expect } from 'vitest';
import { getRowsAffected } from './db-helpers.js';

describe('getRowsAffected', () => {
  it('returns the numeric rowsAffected for typical update results', () => {
    expect(getRowsAffected({ rowsAffected: 1 })).toBe(1);
    expect(getRowsAffected({ rowsAffected: 0 })).toBe(0);
    expect(getRowsAffected({ rowsAffected: 5 })).toBe(5);
  });

  it('tolerates additional libSQL result fields without misreading', () => {
    const libSqlShape = {
      rowsAffected: 3,
      lastInsertRowid: 42n,
      columns: ['id', 'name'],
      columnTypes: ['INTEGER', 'TEXT'],
      rows: [],
      toJSON: () => ({}),
    };
    expect(getRowsAffected(libSqlShape)).toBe(3);
  });

  it('throws a descriptive error when rowsAffected is missing', () => {
    expect(() => getRowsAffected({})).toThrow(/rowsAffected/);
  });

  it('throws a descriptive error when rowsAffected is explicitly undefined', () => {
    expect(() => getRowsAffected({ rowsAffected: undefined })).toThrow(/rowsAffected/);
  });

  it('throws a descriptive error when rowsAffected is non-numeric', () => {
    expect(() => getRowsAffected({ rowsAffected: '1' })).toThrow(/rowsAffected/);
    expect(() => getRowsAffected({ rowsAffected: null })).toThrow(/rowsAffected/);
  });

  it('throws when input is null or undefined', () => {
    expect(() => getRowsAffected(null)).toThrow(/rowsAffected/);
    expect(() => getRowsAffected(undefined)).toThrow(/rowsAffected/);
  });
});
