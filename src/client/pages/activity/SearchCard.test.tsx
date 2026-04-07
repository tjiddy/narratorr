import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SearchCard } from './SearchCard';
import type { SearchCardState, IndexerState } from '@/hooks/useSearchProgress';

function makeState(overrides: Partial<SearchCardState> = {}): SearchCardState {
  return {
    bookId: 1,
    bookTitle: 'The Way of Kings',
    indexers: new Map<number, IndexerState>([
      [10, { name: 'MAM', status: 'pending' }],
      [20, { name: 'ABB', status: 'pending' }],
    ]),
    ...overrides,
  };
}

describe('SearchCard', () => {
  describe('initial state (all pending)', () => {
    it('renders book title in card header', () => {
      render(<SearchCard state={makeState()} />);
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    it('shows "searching..." for each pending indexer', () => {
      render(<SearchCard state={makeState()} />);
      const searchingItems = screen.getAllByText('searching...');
      expect(searchingItems).toHaveLength(2);
    });

    it('shows indexer names', () => {
      render(<SearchCard state={makeState()} />);
      expect(screen.getByText('MAM')).toBeInTheDocument();
      expect(screen.getByText('ABB')).toBeInTheDocument();
    });
  });

  describe('partial completion', () => {
    it('shows result count for completed indexer', () => {
      const state = makeState({
        indexers: new Map([
          [10, { name: 'MAM', status: 'complete', resultsFound: 3, elapsedMs: 1200 }],
          [20, { name: 'ABB', status: 'pending' }],
        ]),
      });
      render(<SearchCard state={state} />);
      expect(screen.getByText(/3 results/)).toBeInTheDocument();
      expect(screen.getByText(/1\.2s/)).toBeInTheDocument();
    });

    it('shows error message for errored indexer', () => {
      const state = makeState({
        indexers: new Map([
          [10, { name: 'MAM', status: 'error', error: 'timeout', elapsedMs: 30000 }],
        ]),
      });
      render(<SearchCard state={state} />);
      expect(screen.getByText(/timeout/)).toBeInTheDocument();
      expect(screen.getByText(/30\.0s/)).toBeInTheDocument();
    });
  });

  describe('grabbed outcome', () => {
    it('shows "Grabbed from {indexer_name}" outcome text', () => {
      const state = makeState({
        outcome: 'grabbed',
        grabbedFrom: 'MAM',
      });
      render(<SearchCard state={state} />);
      expect(screen.getByText(/Grabbed from MAM/)).toBeInTheDocument();
    });
  });

  describe('no_results outcome', () => {
    it('shows "No results found" outcome text', () => {
      const state = makeState({ outcome: 'no_results' });
      render(<SearchCard state={state} />);
      expect(screen.getByText(/No results found/)).toBeInTheDocument();
    });
  });

  describe('mixed states', () => {
    it('renders card with 2 complete, 1 error, 1 pending indexers correctly', () => {
      const state = makeState({
        indexers: new Map([
          [10, { name: 'MAM', status: 'complete', resultsFound: 3, elapsedMs: 500 }],
          [20, { name: 'ABB', status: 'complete', resultsFound: 0, elapsedMs: 200 }],
          [30, { name: 'TL', status: 'error', error: 'timeout', elapsedMs: 30000 }],
          [40, { name: 'NZB', status: 'pending' }],
        ]),
      });
      render(<SearchCard state={state} />);
      expect(screen.getByText(/3 results/)).toBeInTheDocument();
      expect(screen.getByText(/0 results/)).toBeInTheDocument();
      expect(screen.getByText(/timeout/)).toBeInTheDocument();
      expect(screen.getByText('searching...')).toBeInTheDocument();
    });
  });

  describe('boundary values', () => {
    it('shows "0 results" for indexer with results_found: 0', () => {
      const state = makeState({
        indexers: new Map([
          [10, { name: 'MAM', status: 'complete', resultsFound: 0, elapsedMs: 100 }],
        ]),
      });
      render(<SearchCard state={state} />);
      expect(screen.getByText(/0 results/)).toBeInTheDocument();
    });

    it('shows "0.0s" for indexer with elapsed_ms: 0', () => {
      const state = makeState({
        indexers: new Map([
          [10, { name: 'MAM', status: 'complete', resultsFound: 1, elapsedMs: 0 }],
        ]),
      });
      render(<SearchCard state={state} />);
      expect(screen.getByText(/0\.0s/)).toBeInTheDocument();
    });

    it('shows single indexer row when only one indexer', () => {
      const state = makeState({
        indexers: new Map([
          [10, { name: 'MAM', status: 'pending' }],
        ]),
      });
      render(<SearchCard state={state} />);
      expect(screen.getByText('MAM')).toBeInTheDocument();
      expect(screen.getAllByText('searching...')).toHaveLength(1);
    });
  });
});
