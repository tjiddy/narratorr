import { describe, it, expect, beforeEach } from 'vitest';
import { SearchLadderCooldown, LADDER_COOLDOWN_MS } from './search-ladder-cooldown.js';

const KEY = 'the churn an expanse novella james s a corey|1';
const T0 = 1_700_000_000_000;

describe('SearchLadderCooldown', () => {
  let cooldown: SearchLadderCooldown;
  beforeEach(() => {
    cooldown = new SearchLadderCooldown();
  });

  it('does not restrict a book it has never seen', () => {
    expect(cooldown.shouldRestrict(1, KEY, T0)).toBe(false);
  });

  it('restricts to rung 1 for a book whose ladder exhausted, inside the window', () => {
    cooldown.recordExhausted(1, KEY, T0);
    expect(cooldown.shouldRestrict(1, KEY, T0)).toBe(true);
    expect(cooldown.shouldRestrict(1, KEY, T0 + LADDER_COOLDOWN_MS - 1)).toBe(true);
  });

  it('stops restricting once LADDER_COOLDOWN_MS has elapsed', () => {
    cooldown.recordExhausted(1, KEY, T0);
    expect(cooldown.shouldRestrict(1, KEY, T0 + LADDER_COOLDOWN_MS)).toBe(false);
  });

  it('scopes entries per book', () => {
    cooldown.recordExhausted(1, KEY, T0);
    expect(cooldown.shouldRestrict(2, KEY, T0)).toBe(false);
  });

  it('treats a stale-key entry as absent AND drops it (AC22)', () => {
    cooldown.recordExhausted(1, KEY, T0);

    expect(cooldown.shouldRestrict(1, 'the churn james s a corey|1', T0)).toBe(false);
    expect(cooldown.shouldRestrict(1, KEY, T0)).toBe(false);
  });

  it('drops an expired entry rather than leaving it to be re-read', () => {
    cooldown.recordExhausted(1, KEY, T0);
    expect(cooldown.shouldRestrict(1, KEY, T0 + LADDER_COOLDOWN_MS)).toBe(false);
    expect(cooldown.shouldRestrict(1, KEY, T0)).toBe(false);
  });

  it('clear() re-enables the full ladder', () => {
    cooldown.recordExhausted(1, KEY, T0);
    cooldown.clear(1);
    expect(cooldown.shouldRestrict(1, KEY, T0)).toBe(false);
  });

  it('clear() on an unknown book is a no-op', () => {
    expect(() => cooldown.clear(99)).not.toThrow();
  });

  it('re-recording refreshes the window', () => {
    cooldown.recordExhausted(1, KEY, T0);
    cooldown.recordExhausted(1, KEY, T0 + LADDER_COOLDOWN_MS);
    expect(cooldown.shouldRestrict(1, KEY, T0 + LADDER_COOLDOWN_MS)).toBe(true);
  });
});
