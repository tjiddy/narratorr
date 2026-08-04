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

  // AC20 — exhaustion suppresses the relaxed rungs for the window.
  it('restricts to rung 1 for a book whose ladder exhausted, inside the window', () => {
    cooldown.recordExhausted(1, KEY, T0);
    expect(cooldown.shouldRestrict(1, KEY, T0)).toBe(true);
    expect(cooldown.shouldRestrict(1, KEY, T0 + LADDER_COOLDOWN_MS - 1)).toBe(true);
  });

  // AC22 — past the window the full ladder runs again.
  it('stops restricting once LADDER_COOLDOWN_MS has elapsed', () => {
    cooldown.recordExhausted(1, KEY, T0);
    expect(cooldown.shouldRestrict(1, KEY, T0 + LADDER_COOLDOWN_MS)).toBe(false);
  });

  it('scopes entries per book', () => {
    cooldown.recordExhausted(1, KEY, T0);
    expect(cooldown.shouldRestrict(2, KEY, T0)).toBe(false);
  });

  // AC22 — a title or primary-author change through EITHER BookService.update
  // OR fixMatch changes the rung-1 key, so the entry is stale. No mutation-seam
  // wiring exists or is needed; the key IS the invalidation.
  it('treats a stale-key entry as absent AND drops it (AC22)', () => {
    cooldown.recordExhausted(1, KEY, T0);

    expect(cooldown.shouldRestrict(1, 'the churn james s a corey|1', T0)).toBe(false);
    // Deletion, not a pass-through read: a second consult under the ORIGINAL key
    // must also report the full ladder. COUNTERFACTUAL: return false without
    // deleting and this line reads `true`.
    expect(cooldown.shouldRestrict(1, KEY, T0)).toBe(false);
  });

  it('drops an expired entry rather than leaving it to be re-read', () => {
    cooldown.recordExhausted(1, KEY, T0);
    expect(cooldown.shouldRestrict(1, KEY, T0 + LADDER_COOLDOWN_MS)).toBe(false);
    expect(cooldown.shouldRestrict(1, KEY, T0)).toBe(false);
  });

  // AC23 — a rung-1 hit means the canonical query works again.
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
