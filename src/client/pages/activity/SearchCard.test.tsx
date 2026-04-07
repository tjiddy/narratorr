import { describe, it } from 'vitest';

describe('SearchCard', () => {
  describe('initial state (all pending)', () => {
    it.todo('renders book title in card header');
    it.todo('shows "searching..." status for each indexer');
    it.todo('shows spinner icon for pending indexers');
  });

  describe('partial completion', () => {
    it.todo('shows checkmark and result count for completed indexer');
    it.todo('shows elapsed time formatted as "X.Xs" for completed indexer');
    it.todo('shows error icon and error message for errored indexer');
    it.todo('shows elapsed time for errored indexer');
    it.todo('pending indexers still show spinner while others are complete');
  });

  describe('grabbed outcome', () => {
    it.todo('shows "Grabbed from {indexer_name}" outcome text');
    it.todo('shows overall status as grabbed');
  });

  describe('no_results outcome', () => {
    it.todo('shows "No results found" outcome text');
  });

  describe('mixed states', () => {
    it.todo('renders card with 2 complete, 1 error, 1 pending indexers correctly');
  });

  describe('multiple cards', () => {
    it.todo('renders multiple search cards for concurrent searches');
  });

  describe('boundary values', () => {
    it.todo('shows "0 results" for indexer with results_found: 0');
    it.todo('shows "0.0s" for indexer with elapsed_ms: 0');
    it.todo('shows single indexer row when only one indexer enabled');
  });
});
