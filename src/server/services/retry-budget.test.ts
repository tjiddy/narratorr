import { describe, it, expect, beforeEach } from 'vitest';
import { RetryBudget } from './retry-budget.js';

describe('RetryBudget', () => {
  let budget: RetryBudget;

  beforeEach(() => {
    budget = new RetryBudget();
  });

  describe('consumeAttempt', () => {
    it('increments and returns current count', () => {
      expect(budget.consumeAttempt(1)).toBe(1);
    });

    it('increments correctly across multiple calls for same bookId', () => {
      expect(budget.consumeAttempt(1)).toBe(1);
      expect(budget.consumeAttempt(1)).toBe(2);
      expect(budget.consumeAttempt(1)).toBe(3);
    });

    it('tracks different bookIds independently', () => {
      expect(budget.consumeAttempt(1)).toBe(1);
      expect(budget.consumeAttempt(2)).toBe(1);
      expect(budget.consumeAttempt(1)).toBe(2);
    });
  });

  describe('reset', () => {
    it('clears single bookId entry', () => {
      budget.consumeAttempt(1);
      budget.consumeAttempt(1);
      budget.reset(1);
      expect(budget.hasRemaining(1)).toBe(true);
      expect(budget.consumeAttempt(1)).toBe(1);
    });

    it('does not affect other bookId entries', () => {
      budget.consumeAttempt(1);
      budget.consumeAttempt(2);
      budget.reset(1);
      expect(budget.consumeAttempt(2)).toBe(2);
    });
  });

  describe('resetAll', () => {
    it('clears all entries', () => {
      budget.consumeAttempt(1);
      budget.consumeAttempt(2);
      budget.consumeAttempt(3);
      budget.resetAll();
      expect(budget.hasRemaining(1)).toBe(true);
      expect(budget.hasRemaining(2)).toBe(true);
      expect(budget.hasRemaining(3)).toBe(true);
      expect(budget.consumeAttempt(1)).toBe(1);
    });
  });

  describe('hasRemaining', () => {
    it('returns true when count is below max', () => {
      budget.consumeAttempt(1);
      expect(budget.hasRemaining(1)).toBe(true);
    });

    it('returns false when count equals max', () => {
      budget.consumeAttempt(1);
      budget.consumeAttempt(1);
      budget.consumeAttempt(1);
      expect(budget.hasRemaining(1)).toBe(false);
    });

    it('returns true for unknown bookId (no attempts yet)', () => {
      expect(budget.hasRemaining(999)).toBe(true);
    });

    it('uses default max of 3', () => {
      budget.consumeAttempt(1);
      budget.consumeAttempt(1);
      expect(budget.hasRemaining(1)).toBe(true);
      budget.consumeAttempt(1);
      expect(budget.hasRemaining(1)).toBe(false);
    });

    it('respects custom max parameter', () => {
      budget.consumeAttempt(1);
      expect(budget.hasRemaining(1, 1)).toBe(false);
      expect(budget.hasRemaining(1, 2)).toBe(true);
    });
  });

  describe('boundary values', () => {
    it('attempt at exactly max (3 of 3) — hasRemaining returns false', () => {
      budget.consumeAttempt(1);
      budget.consumeAttempt(1);
      budget.consumeAttempt(1);
      expect(budget.hasRemaining(1)).toBe(false);
    });

    it('fresh bookId (count 0) allows full retry budget', () => {
      expect(budget.hasRemaining(42)).toBe(true);
      expect(budget.consumeAttempt(42)).toBe(1);
      expect(budget.hasRemaining(42)).toBe(true);
      expect(budget.consumeAttempt(42)).toBe(2);
      expect(budget.hasRemaining(42)).toBe(true);
      expect(budget.consumeAttempt(42)).toBe(3);
      expect(budget.hasRemaining(42)).toBe(false);
    });
  });
});
