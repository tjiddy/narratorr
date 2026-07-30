import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode, useLayoutEffect } from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryKeys';
import type { CompanionEbookCandidate, CompanionEbookMetadata, CompanionEbookState } from '@/lib/api';
import type { EpubTocEntry, EpubValidationCode } from '@core/epub/result.js';
import { CompanionEbookSection } from './CompanionEbookSection';
import {
  AMBIGUOUS_QUESTION,
  AMBIGUOUS_SUBMIT,
  DRM_BODY,
  REFRESH_ERROR_TOAST,
  REFRESH_LABEL,
  INVALID_REASONS,
  INVALID_SENTENCE_FALLBACK,
  NONE_BODY,
  SELECTION_ERROR_FALLBACK,
  SELECTION_SUCCESS_TOAST,
  invalidSentence,
} from './companion-ebook-copy.js';

// ============================================================================
// #1963 — the Ebook panel on book details.
//
// `resetAllMocks`, never `clearAllMocks`: several cases below queue two different
// `/state` responses across one test, and `clearAllMocks` does not drain
// `mockResolvedValueOnce` queues (`vitest-clearallmocks-once-queue`).
// ============================================================================

/**
 * Ordering instrumentation for the layout-seam proof. The teardown the section runs in its
 * `useLayoutEffect` cleanup is `selection.reset`; wrap it (behaviour-preserving, still calls
 * through) to record WHEN it fires. The mutation's own suppression is async — react-query
 * awaits the mutationFn, so its callbacks always run post-passive and cannot distinguish the
 * seam by themselves — so this synchronous ordering marker is what proves it
 * (`rtl-layout-vs-passive-seam-testing`).
 */
const { orderMarks } = vi.hoisted(() => ({ orderMarks: [] as string[] }));

vi.mock('./useCompanionEbookSelection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useCompanionEbookSelection.js')>();
  const React = await import('react');
  return {
    ...actual,
    useCompanionEbookSelection: (bookId: number, candidates: CompanionEbookCandidate[]) => {
      const real = actual.useCompanionEbookSelection(bookId, candidates);
      // Stable identity (real.reset is a stable useCallback) so the section's layout effect
      // does not re-run on every render.
      const reset = React.useMemo(
        () => () => { orderMarks.push('A-teardown'); real.reset(); },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- key on the stable reset only
        [real.reset],
      );
      return { ...real, reset };
    },
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getCompanionEbookState: vi.fn(),
      // #2022. MANDATORY here, not optional: this factory SPREADS `actual.api`, so any method
      // it does not name stays REAL and issues a genuine relative-URL fetch from jsdom
      // (`vimock-barrel-replace-drops-named-exports`).
      getCompanionEbookMetadata: vi.fn(),
      putCompanionEbookSelection: vi.fn(),
      refreshCompanionEbook: vi.fn(),
    },
  };
});

import { api, ApiError, formatBytes } from '@/lib/api';
import { toast } from 'sonner';

const mockApi = api as unknown as {
  getCompanionEbookState: ReturnType<typeof vi.fn>;
  getCompanionEbookMetadata: ReturnType<typeof vi.fn>;
  putCompanionEbookSelection: ReturnType<typeof vi.fn>;
  refreshCompanionEbook: ReturnType<typeof vi.fn>;
};
const mockToast = toast as unknown as {
  success: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

const BOOK_ID = 7;
const SIZE = 2_400_000;
/** A second, visibly different size, so a converged render cannot be confused with the first. */
const SIZE2 = 9_900_000;

/** `toc` is never `[]` — `src/core/epub/extract.ts` yields `null` for a zero-row traversal. */
function toc(rows: number): EpubTocEntry[] {
  return Array.from({ length: rows }, (_, index) => ({ title: `Chapter ${index + 1}`, depth: 0 }));
}

/**
 * A `/metadata` response. `filename` is what the SERVER declares it read — the only thing the
 * panel ever compares. `rows` of `null` is `toc: null`: "we could not read one", not zero.
 */
function metadataFor(filename: string, rows: number | null): CompanionEbookMetadata {
  return {
    filename,
    metadata: { title: 'A Title', author: null, language: null },
    toc: rows === null ? null : toc(rows),
  };
}

const META_KEY = (filename: string) => queryKeys.companionEbookMetadata(BOOK_ID, filename);

/** The panel's cold-metadata default, so `available` fixtures render exactly as they did pre-#2022. */
const NO_METADATA = () => new ApiError(404, { error: 'Companion ebook not found' });

function makeState(overrides: Partial<CompanionEbookState> = {}): CompanionEbookState {
  return {
    status: 'none',
    filename: null,
    sizeBytes: null,
    validationCode: null,
    candidateCount: 0,
    selectedFilename: null,
    candidates: [],
    ...overrides,
  };
}

const AVAILABLE = makeState({ status: 'available', filename: 'book.epub', sizeBytes: SIZE });
const NONE = makeState({ status: 'none' });
const INVALID = makeState({ status: 'invalid', filename: 'broken.epub', sizeBytes: SIZE, validationCode: 'empty_spine' });
const DRM = makeState({ status: 'drm_protected', filename: 'locked.epub', sizeBytes: SIZE });

function candidateList(...filenames: string[]): CompanionEbookCandidate[] {
  return filenames.map((filename, index) => ({ index, filename }));
}

function ambiguous(candidates: CompanionEbookCandidate[], candidateCount = candidates.length): CompanionEbookState {
  return makeState({ status: 'ambiguous', candidates, candidateCount });
}

const ALL_STATES: Array<[string, CompanionEbookState]> = [
  ['available', AVAILABLE],
  ['none', NONE],
  ['ambiguous', ambiguous(candidateList('a.epub', 'b.epub'))],
  ['invalid', INVALID],
  ['drm_protected', DRM],
];

/**
 * A production-equivalent client: `main.tsx`'s defaults and NO `retry` override, so only the
 * component can supply the 409-aware predicate. `retryDelay: 0` is supplied solely to keep the
 * retry ladder fast — it changes how long a retry waits, never whether one happens.
 */
function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 1000 * 60, refetchOnWindowFocus: false, retryDelay: 0 },
    },
  });
}

/** Fires `onLayout` during its own layout-effect SETUP; keyed alongside the section. */
function LayoutMarker({ onLayout }: { onLayout: () => void }) {
  // eslint-disable-next-line react-hooks/exhaustive-deps -- fire exactly once at mount (layout phase)
  useLayoutEffect(() => { onLayout(); }, []);
  return null;
}

function renderPanel(
  bookId: number = BOOK_ID,
  client: QueryClient = makeClient(),
  onBookLayout?: () => void,
) {
  const armed = { current: false };
  const tree = (id: number) => (
    <QueryClientProvider client={client}>
      <CompanionEbookSection bookId={id} />
      {onBookLayout && <LayoutMarker key={id} onLayout={() => { if (armed.current) onBookLayout(); }} />}
    </QueryClientProvider>
  );
  const view = render(tree(bookId));
  return {
    ...view,
    client,
    armForNext: () => { armed.current = true; },
    rerenderBook: (id: number) => view.rerender(tree(id)),
    remount: () => {
      view.unmount();
      return render(tree(bookId));
    },
  };
}

function heading(): HTMLElement | null {
  return screen.queryByRole('heading', { name: 'Ebook' });
}

/**
 * The silent-absence contract, in ONE predicate (AC2/AC3): *"no error text, no skeleton, no
 * placeholder, and no retry affordance"*.
 *
 * `toBeEmptyDOMElement` is the load-bearing assertion — it requires the component to have
 * rendered NO node at all. Checking absent text, an absent heading, and an absent `.glass-card`
 * is not the same claim: a bare `<div className="animate-pulse" />` has no text and no heading
 * and is not a card, so it satisfies all three while putting a visible loading/error skeleton
 * on screen. The named absences are kept alongside it because they say what specifically must
 * not come back, and they produce a far more legible failure than "expected element to be
 * empty" when a real panel regresses into one of these paths.
 */
function expectSilentAbsence(container: HTMLElement): void {
  expect(container).toBeEmptyDOMElement();
  expect(heading()).toBeNull();
  expect(container.textContent).toBe('');
  expect(container.querySelector('.glass-card')).toBeNull();
  expect(screen.queryByTestId('badge')).toBeNull();
  expect(screen.queryByRole('link', { name: /download/i })).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
}

function card(container: HTMLElement): HTMLElement {
  return container.querySelector('.glass-card') as HTMLElement;
}

function attributeText(container: HTMLElement): string {
  return Array.from(container.querySelectorAll('[aria-label], [title]'))
    .map((el) => `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''}`)
    .join(' ');
}

function makeDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * Let every already-scheduled effect, query settlement, and timer-0 continuation run.
 *
 * Used for the NEGATIVE assertions (#2022): "no request was issued", "no revalidation fired",
 * "the call count stopped climbing". Those cannot be `waitFor`ed — there is nothing to wait for
 * — so the honest shape is to give the work a real chance to happen and then assert it did not.
 */
async function flush(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  });
}

/** Kick a refetch without awaiting its (possibly retrying) settlement. */
function triggerRefetch(client: QueryClient, bookId = BOOK_ID) {
  return act(async () => {
    void client.invalidateQueries({ queryKey: queryKeys.companionEbook(bookId) });
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  orderMarks.length = 0;
  // Cold-fail `/metadata` by default (#2022 AC17, first arm): no count renders, so every case
  // written before this issue keeps asserting exactly what it asserted. A MISMATCHED resolved
  // value would be wrong here — it would fire AC13's recovery and inflate `/state` call counts
  // across the whole suite.
  mockApi.getCompanionEbookMetadata.mockRejectedValue(NO_METADATA());
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Presence and absence (AC2, AC3)
// ---------------------------------------------------------------------------

describe('CompanionEbookSection — presence and absence', () => {
  it('renders nothing while the state query is pending', () => {
    mockApi.getCompanionEbookState.mockReturnValue(new Promise(() => {}));
    const { container } = renderPanel();
    expectSilentAbsence(container);
  });

  // AC3: on an initial-load failure every cause means the same thing — no panel, no error
  // text, no skeleton, no retry affordance — so this is table-driven over all of them rather
  // than over two hand-picked statuses.
  //
  // Each case waits for the query to reach its TERMINAL error state, not merely for the first
  // request to have been issued. While the retry ladder is still running the query is pending,
  // and a pending query renders nothing for the correct reason — so an assertion made there is
  // blind to what the component does once the failure is final. The expected request count is
  // asserted alongside it so the wait is pinned to the end of the ladder rather than to
  // whatever `waitFor` happened to observe (409 is the one status the predicate never retries).
  const initialFailures: Array<[string, unknown, number]> = [
    ['404 (feature does not apply)', new ApiError(404, { error: 'Companion ebook not found' }), 4],
    ['409 (feature disabled)', new ApiError(409, { error: 'Companion ebooks are disabled' }), 1],
    ['503 (candidates undetermined)', new ApiError(503, { error: 'Companion ebook candidates could not be listed' }), 4],
    ['a plain network rejection', new Error('network down'), 4],
  ];

  for (const [label, failure, expectedRequests] of initialFailures) {
    it(`renders nothing once the first response fails terminally with ${label}`, async () => {
      mockApi.getCompanionEbookState.mockRejectedValue(failure);
      const { container, client } = renderPanel();

      await waitFor(() =>
        expect(client.getQueryState(queryKeys.companionEbook(BOOK_ID))?.status).toBe('error'));
      expect(mockApi.getCompanionEbookState).toHaveBeenCalledTimes(expectedRequests);
      expect(client.getQueryData(queryKeys.companionEbook(BOOK_ID))).toBeUndefined();

      expectSilentAbsence(container);
    });
  }

  // AC2 data-wins. A `return null` on `isError` fails this — it is the exact
  // apparent-data-loss interaction the panel forbids. The 404 case is deliberate: it must
  // stay under data-wins, so generalising the 409 exception to "any 4xx" fails here.
  const transientRefetchFailures: Array<[string, unknown]> = [
    ['503', new ApiError(503, { error: 'Companion ebook candidates could not be listed' })],
    ['a plain Error', new Error('network down')],
    ['404', new ApiError(404, { error: 'Companion ebook not found' })],
  ];

  for (const [label, failure] of transientRefetchFailures) {
    it(`keeps the rendered panel when a refetch fails with ${label}`, async () => {
      mockApi.getCompanionEbookState.mockResolvedValueOnce(AVAILABLE);
      const { client } = renderPanel();
      expect(await screen.findByText('book.epub')).toBeInTheDocument();

      mockApi.getCompanionEbookState.mockRejectedValue(failure);
      await triggerRefetch(client);

      // Wait for the query to actually REACH its error state — the retry ladder means a
      // rejection is not observable as `error` until the last attempt, and asserting before
      // then would pass for an implementation that blanks on error.
      await waitFor(() =>
        expect(client.getQueryState(queryKeys.companionEbook(BOOK_ID))?.status).toBe('error'));

      expect(screen.getByText('book.epub')).toBeInTheDocument();
      expect(screen.getByText(formatBytes(SIZE))).toBeInTheDocument();
    });
  }

  // AC2's retry predicate, proved against a client that does NOT supply it. `renderWithProviders`
  // builds its client with `retry: false`, which makes every rejection terminal on the first
  // attempt and therefore cannot distinguish a correct predicate from a missing one.
  it('never retries a 409 refetch — exactly one request, and the panel hides', async () => {
    mockApi.getCompanionEbookState.mockResolvedValueOnce(AVAILABLE);
    const { client } = renderPanel();
    expect(await screen.findByText('book.epub')).toBeInTheDocument();

    mockApi.getCompanionEbookState.mockClear();
    mockApi.getCompanionEbookState.mockRejectedValue(new ApiError(409, { error: 'Companion ebooks are disabled' }));
    await triggerRefetch(client);

    await waitFor(() => expect(heading()).toBeNull());
    expect(mockApi.getCompanionEbookState).toHaveBeenCalledTimes(1);
  });

  it('keeps the client default of three retries for a 503 refetch — four requests, panel visible throughout', async () => {
    mockApi.getCompanionEbookState.mockResolvedValueOnce(AVAILABLE);
    const { client } = renderPanel();
    expect(await screen.findByText('book.epub')).toBeInTheDocument();

    mockApi.getCompanionEbookState.mockClear();
    mockApi.getCompanionEbookState.mockRejectedValue(new ApiError(503, { error: 'unavailable' }));
    await triggerRefetch(client);

    // failureCount starts at 0 and the client default is three retries, so `failureCount < 3`
    // yields four total failed requests.
    await waitFor(() => expect(mockApi.getCompanionEbookState).toHaveBeenCalledTimes(4));
    expect(screen.getByText('book.epub')).toBeInTheDocument();
  });

  // AC2's durable-disable rule.
  it('hides a cached panel once /state answers 409, and stays hidden across a remount on the same client', async () => {
    mockApi.getCompanionEbookState.mockResolvedValueOnce(AVAILABLE);
    const panel = renderPanel();
    expect(await screen.findByText('book.epub')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download EPUB' })).toBeInTheDocument();

    mockApi.getCompanionEbookState.mockRejectedValue(new ApiError(409, { error: 'Companion ebooks are disabled' }));
    await triggerRefetch(panel.client);

    // The whole panel goes, not just its recognisable parts — a disabled feature leaves no
    // skeleton or placeholder behind either.
    await waitFor(() => expect(heading()).toBeNull());
    expectSilentAbsence(panel.container);

    // The cache survives navigation because the client is created outside the router;
    // `staleTime: 0` is what guarantees the remount re-requests rather than serving the entry.
    mockApi.getCompanionEbookState.mockClear();
    const remounted = panel.remount();
    await waitFor(() => expect(mockApi.getCompanionEbookState).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });

    expectSilentAbsence(remounted.container);
  });

  it('renders exactly one Ebook heading inside a glass-card container', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(NONE);
    const { container } = renderPanel();

    await screen.findByRole('heading', { name: 'Ebook' });
    expect(screen.getAllByRole('heading', { name: 'Ebook' })).toHaveLength(1);
    expect(card(container)).toBeInTheDocument();
  });

  // AC5/AC6 — the only structural test; the per-state tests stay behavior-focused.
  it('matches the AudioInfo shell exactly: heading classes, card classes, a first row containing the badge, and text-sm on every row', async () => {
    // DRM fixture, not AVAILABLE: `available` renders no pill since the badge cut
    // (quiet means healthy), so the first-row-contains-badge half of the shell contract
    // is exercised on a state that still has one.
    mockApi.getCompanionEbookState.mockResolvedValue(DRM);
    const { container } = renderPanel();
    await screen.findByText('DRM-protected');

    // Equality, not toHaveClass — a subset check passes on a partial copy. The h2 lost
    // `mb-3` when the header gained the icon row: the margin lives on the flex wrapper now,
    // exactly like SeriesCard's header.
    expect(container.querySelector('h2')?.getAttribute('class'))
      .toBe('text-sm font-semibold uppercase tracking-wider text-muted-foreground');
    expect(container.querySelector('h2')?.parentElement?.getAttribute('class'))
      .toBe('flex items-center justify-between mb-3');
    expect(card(container).getAttribute('class')).toBe('glass-card rounded-2xl p-4 space-y-2');

    const badge = screen.getByTestId('badge');
    const firstChild = card(container).children[0]!;
    expect(firstChild).not.toBe(badge);
    expect(firstChild.contains(badge)).toBe(true);

    // Iterate every child so a new unclassed row cannot be added later without failing.
    const children = Array.from(card(container).children);
    expect(children.length).toBeGreaterThan(1);
    for (const child of children) {
      expect(child.getAttribute('class') ?? '').toContain('text-sm');
    }
  });
});

// ---------------------------------------------------------------------------
// The five states — copy is verbatim (AC7-AC12)
// ---------------------------------------------------------------------------

describe('CompanionEbookSection — per-state copy', () => {
  // REVERSED (Todd, 2026-07-29, badge cut): `available` renders NO pill. The filename,
  // size, and live download icon are the existence proof; a badge appears only when
  // something needs saying (None / N found / Not readable / DRM-protected).
  it('available: NO pill — the filename leads, then the size, download in the header', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(AVAILABLE);
    const { container } = renderPanel();

    expect(await screen.findByText('book.epub')).toBeInTheDocument();
    expect(screen.queryByText('Available')).toBeNull();
    expect(screen.queryByTestId('badge')).toBeNull();
    // Row order is identity-first: filename, then size.
    expect(card(container).children[0]?.textContent).toBe('book.epub');
    expect(card(container).children[1]?.textContent).toBe(formatBytes(SIZE));
    expect(screen.getByRole('link', { name: 'Download EPUB' })).toBeInTheDocument();
  });

  // REVERSED (Todd, 2026-07-29): this used to assert `available hides the filename
  // entirely`. The filename is the card's identity line — and once a selection has
  // happened it is the only disambiguator for WHICH file won — so it renders, truncated,
  // with the full name as the tooltip.
  it('available renders the filename truncated with the full name as its tooltip', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(
      makeState({ status: 'available', filename: 'ZZ-DISTINCTIVE-FILENAME.epub', sizeBytes: SIZE }),
    );
    renderPanel();

    const el = await screen.findByText('ZZ-DISTINCTIVE-FILENAME.epub');
    expect(el).toHaveClass('truncate');
    expect(el).toHaveAttribute('title', 'ZZ-DISTINCTIVE-FILENAME.epub');
  });

  it('none: a None pill and the drop-a-file sentence verbatim', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(NONE);
    const { container } = renderPanel();

    expect(await screen.findByText('None')).toBeInTheDocument();
    expect(card(container).children[1]?.textContent).toBe(NONE_BODY);
    expect(NONE_BODY).toBe(
      "Drop a single .epub into this book's folder, shown under Location below, then rescan.",
    );
  });

  it('ambiguous: the pill counts the rendered candidates, not candidateCount', async () => {
    // Deliberately mismatched: a fixture whose two counts agree cannot distinguish AC9's
    // required source from the forbidden one.
    mockApi.getCompanionEbookState.mockResolvedValue(
      ambiguous(candidateList('a.epub', 'b.epub', 'c.epub'), 99),
    );
    renderPanel();

    expect(await screen.findByText('3 found')).toBeInTheDocument();
    expect(screen.queryByText('99 found')).toBeNull();
    expect(screen.getByText(AMBIGUOUS_QUESTION)).toBeInTheDocument();
    expect(AMBIGUOUS_QUESTION).toBe('Which one belongs to this book?');
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByRole('button', { name: AMBIGUOUS_SUBMIT })).toBeInTheDocument();
    expect(AMBIGUOUS_SUBMIT).toBe('Use this one');
  });

  it('invalid: a Not readable pill, the filename, and the plan-authored sentence verbatim', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(INVALID);
    renderPanel();

    expect(await screen.findByText('Not readable')).toBeInTheDocument();
    expect(screen.getByText('broken.epub')).toBeInTheDocument();
    expect(
      screen.getByText("This isn't a valid EPUB: it has no reading order. If it's still copying, wait and rescan."),
    ).toBeInTheDocument();
  });

  it('drm_protected: a DRM-protected pill, the size, and the DRM sentence verbatim', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(DRM);
    renderPanel();

    expect(await screen.findByText('DRM-protected')).toBeInTheDocument();
    expect(screen.getByText(formatBytes(SIZE))).toBeInTheDocument();
    expect(screen.getByText(DRM_BODY)).toBeInTheDocument();
    // "downloaded or" dropped (#2038): the owner CAN download a DRM'd file now, and only the
    // Kindle half of the old sentence was ever reasoned.
    expect(DRM_BODY).toBe(
      "Its chapters are encrypted. Narratorr won't remove DRM, so this can't be sent to Kindle.",
    );
  });

  // AC13 — the whole clause table, sentence by sentence. Non-empty/unique assertions are not
  // sufficient: they pass when two clauses are swapped, which is the defect this prevents.
  const CLAUSES: Array<[EpubValidationCode, string]> = [
    ['not_a_zip', "it isn't a readable archive"],
    ['truncated', 'the file is incomplete'],
    ['bad_mimetype', "it isn't marked as an EPUB"],
    ['missing_container', 'it has no index'],
    ['unresolvable_package', "its index points to a file that isn't there"],
    ['empty_manifest', 'it lists no files'],
    ['empty_spine', 'it has no reading order'],
    ['unsafe_entry_path', 'it contains an unsafe file path'],
    ['duplicate_entry', 'it contains duplicate entries'],
    ['malformed_xml', 'its internal structure is damaged'],
    ['limit_exceeded', "it's larger or more complex than Narratorr will read"],
  ];

  it('covers every EpubValidationCode with no extras', () => {
    expect(Object.keys(INVALID_REASONS).sort()).toEqual(CLAUSES.map(([code]) => code).sort());
  });

  for (const [code, clause] of CLAUSES) {
    it(`invalid/${code} renders its own clause verbatim`, async () => {
      mockApi.getCompanionEbookState.mockResolvedValue(
        makeState({ status: 'invalid', filename: 'x.epub', sizeBytes: SIZE, validationCode: code }),
      );
      renderPanel();

      expect(
        await screen.findByText(`This isn't a valid EPUB: ${clause}. If it's still copying, wait and rescan.`),
      ).toBeInTheDocument();
    });
  }

  // AC14 — `validationCode` is `string | null` on the wire and the DB column is unconstrained
  // text. The inherited names are the point: an `in` check or a bare index returns an
  // inherited value for them and would render a function body as owner-facing copy.
  const FALLBACK_CODES = [null, 'not_a_real_code', 'constructor', 'toString', 'hasOwnProperty', '__proto__'];

  for (const code of FALLBACK_CODES) {
    it(`invalid with validationCode ${String(code)} renders the frame with no clause`, async () => {
      mockApi.getCompanionEbookState.mockResolvedValue(
        makeState({ status: 'invalid', filename: 'x.epub', sizeBytes: SIZE, validationCode: code }),
      );
      const { container } = renderPanel();

      expect(await screen.findByText(INVALID_SENTENCE_FALLBACK)).toBeInTheDocument();
      expect(INVALID_SENTENCE_FALLBACK).toBe("This isn't a valid EPUB. If it's still copying, wait and rescan.");
      expect(container.textContent).not.toContain('[object Object]');
      expect(container.textContent).not.toContain('function');
      expect(container.textContent).not.toContain('native code');
    });
  }

  // AC12 — the mechanical half of the copy rule and the naming invariant. `href` is excluded:
  // the download URL legitimately contains the route path `/companion-epub`, which is API
  // vocabulary, not UI copy.
  for (const [label, state] of ALL_STATES) {
    it(`${label} renders no em-dash and never the word "companion"`, async () => {
      mockApi.getCompanionEbookState.mockResolvedValue(state);
      // `available` is the one state carrying #2022's count, so the mechanical invariants below
      // run with that string PRESENT rather than against a cold metadata failure.
      mockApi.getCompanionEbookMetadata.mockResolvedValue(metadataFor('book.epub', 3));
      const { container } = renderPanel();
      await screen.findByRole('heading', { name: 'Ebook' });
      if (state.status === 'available') await screen.findByText(/3 chapters/);

      const visible = container.textContent ?? '';
      expect(visible).not.toContain('—');
      expect(visible.toLowerCase()).not.toContain('companion');

      const attrs = attributeText(container);
      expect(attrs).not.toContain('—');
      expect(attrs.toLowerCase()).not.toContain('companion');
    });
  }

  it('the selection error copy obeys the same two rules', () => {
    const sentences = [
      'That file is no longer in the list. Pick again.',
      "That ebook isn't there anymore. Rescan and try again.",
      'Something changed while you were choosing. Refresh the page and try again.',
      SELECTION_ERROR_FALLBACK,
      SELECTION_SUCCESS_TOAST,
    ];
    for (const sentence of sentences) {
      expect(sentence).not.toContain('—');
      expect(sentence.toLowerCase()).not.toContain('companion');
    }
  });
});

// ---------------------------------------------------------------------------
// Nullable wire fields (AC17, AC18)
// ---------------------------------------------------------------------------

describe('CompanionEbookSection — nullable wire fields', () => {
  it('available with a null size renders no detail row at all, and never "0 B"', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(
      makeState({ status: 'available', filename: 'book.epub', sizeBytes: null }),
    );
    const { container } = renderPanel();
    await screen.findByText('book.epub');

    expect(container.textContent).not.toContain('0 B');
    expect(card(container).children).toHaveLength(1); // filename row alone (no pill on available, download in the header)
    expect(screen.getByRole('link', { name: 'Download EPUB' })).toBeInTheDocument();
  });

  it('drm_protected with a null size renders no size row, and the DRM sentence still renders', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(
      makeState({ status: 'drm_protected', filename: 'locked.epub', sizeBytes: null }),
    );
    const { container } = renderPanel();
    await screen.findByText('DRM-protected');

    expect(container.textContent).not.toContain('0 B');
    expect(card(container).children).toHaveLength(3); // pill row + filename row + DRM sentence
    expect(screen.getByText(DRM_BODY)).toBeInTheDocument();
  });

  it('invalid with a null filename renders no filename row, and the diagnostic still renders', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(
      makeState({ status: 'invalid', filename: null, sizeBytes: null, validationCode: 'empty_spine' }),
    );
    const { container } = renderPanel();

    expect(
      await screen.findByText("This isn't a valid EPUB: it has no reading order. If it's still copying, wait and rescan."),
    ).toBeInTheDocument();
    expect(card(container).children).toHaveLength(2); // pill row + sentence
    for (const child of Array.from(card(container).children)) {
      expect(child.textContent).not.toBe('');
    }
  });

  // Paired with the null cases above, this is what forces `sizeBytes !== null`:
  // `sizeBytes ? formatBytes(sizeBytes) : null` passes those and fails these.
  it('available with a zero size renders exactly "0 B"', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(
      makeState({ status: 'available', filename: 'empty.epub', sizeBytes: 0 }),
    );
    const { container } = renderPanel();
    await screen.findByText('empty.epub');

    // children[0] is the filename row (no pill on available); the size row follows it.
    expect(card(container).children[1]?.textContent).toBe('0 B');
  });

  it('drm_protected with a zero size renders exactly "0 B"', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(
      makeState({ status: 'drm_protected', filename: 'empty.epub', sizeBytes: 0 }),
    );
    const { container } = renderPanel();
    await screen.findByText('DRM-protected');

    expect(card(container).children[2]?.textContent).toBe('0 B');
  });
});

// ---------------------------------------------------------------------------
// The metadata read is gated on `available` (#2022 AC14)
// ---------------------------------------------------------------------------

/** Every state the metadata query must never fire for — AC14's proof set. */
const NON_AVAILABLE_STATES = ALL_STATES.filter(([, state]) => state.status !== 'available');

describe('CompanionEbookSection — the metadata read is gated on `available`', () => {
  // REVERSED (#2022): this used to assert the barrel exposed NO metadata reader. It does now —
  // the count is bound to the file by the server's own declaration of what it read.
  it('exposes getCompanionEbookMetadata on the client API barrel', () => {
    expect(Object.hasOwn(api, 'getCompanionEbookMetadata')).toBe(true);
  });

  for (const [label, state] of NON_AVAILABLE_STATES) {
    it(`${label} issues no request beyond /state`, async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      mockApi.getCompanionEbookState.mockResolvedValue(state);
      renderPanel();
      await screen.findByRole('heading', { name: 'Ebook' });

      expect(mockApi.getCompanionEbookState).toHaveBeenCalledTimes(1);
      expect(mockApi.getCompanionEbookMetadata).not.toHaveBeenCalled();
      // Every other API read would go through the real client; none is issued.
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it(`${label} renders no chapter count`, async () => {
      mockApi.getCompanionEbookState.mockResolvedValue(state);
      const { container } = renderPanel();
      await screen.findByRole('heading', { name: 'Ebook' });

      // A count pattern, deliberately not the bare word: drm_protected legitimately reads
      // "Its chapters are encrypted."
      expect(container.textContent ?? '').not.toMatch(/\d+\s+chapters?\b/i);
      expect(attributeText(container)).not.toMatch(/\d+\s+chapters?\b/i);
    });
  }

  // The wire type permits it even though the DB CHECK does not.
  it('does not fire for `available` with a null filename', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(
      makeState({ status: 'available', filename: null, sizeBytes: SIZE }),
    );
    const { container } = renderPanel();
    await screen.findByRole('heading', { name: 'Ebook' });
    await flush();

    expect(mockApi.getCompanionEbookMetadata).not.toHaveBeenCalled();
    expect(container.textContent ?? '').not.toMatch(/\d+\s+chapters?\b/i);
  });

  /**
   * The gate against a WARM cache. The loop above starts cold, so it cannot see the defect it
   * looks like it covers: `enabled: false` stops FETCHING but does not empty the entry, and
   * TanStack hands a disabled observer whatever that key already holds. Seeded here is exactly
   * what an earlier race leaves behind — a MISMATCHED response under the current filename's key.
   *
   * This is the case that fails when the implementation gates only the query and not the
   * filename AC13 reads: the effect would fire a `/state` invalidation off cached data while the
   * panel renders `drm_protected`.
   */
  it('reads nothing and recovers nothing from a cached response while the panel renders drm_protected', async () => {
    const client = makeClient();
    client.setQueryData(META_KEY('locked.epub'), metadataFor('other.epub', 3));
    mockApi.getCompanionEbookState.mockResolvedValue(DRM); // filename: 'locked.epub'

    const { container } = renderPanel(BOOK_ID, client);
    await screen.findByText('DRM-protected');
    await flush();

    expect(mockApi.getCompanionEbookMetadata).not.toHaveBeenCalled();
    expect(mockApi.getCompanionEbookState).toHaveBeenCalledTimes(1);
    expect(container.textContent ?? '').not.toMatch(/\d+\s+chapters?\b/i);
  });
});

// ---------------------------------------------------------------------------
// The chapter count, bound to the file on screen (#2022)
// ---------------------------------------------------------------------------

const A_STATE = makeState({ status: 'available', filename: 'A.epub', sizeBytes: SIZE });
const B_STATE = makeState({ status: 'available', filename: 'B.epub', sizeBytes: SIZE2 });

/** The `available` card's detail row — filename row is children[0], detail row children[1]. */
function detailRow(container: HTMLElement): string {
  return card(container).children[1]?.textContent ?? '';
}

describe('CompanionEbookSection — the chapter count', () => {
  it('joins the size and the count when the metadata response names the file on screen', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(AVAILABLE);
    mockApi.getCompanionEbookMetadata.mockResolvedValue(metadataFor('book.epub', 3));

    const { container } = renderPanel();

    await screen.findByText(`${formatBytes(SIZE)} · 3 chapters`);
    expect(detailRow(container)).toBe(`${formatBytes(SIZE)} · 3 chapters`);
    expect(mockApi.getCompanionEbookMetadata).toHaveBeenCalledWith(BOOK_ID);
  });

  it('pluralizes on 1', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(AVAILABLE);
    mockApi.getCompanionEbookMetadata.mockResolvedValue(metadataFor('book.epub', 1));

    const { container } = renderPanel();

    await screen.findByText(`${formatBytes(SIZE)} · 1 chapter`);
    expect(detailRow(container)).toBe(`${formatBytes(SIZE)} · 1 chapter`);
    expect(container.textContent).not.toContain('1 chapters');
  });

  it('says "2 chapters" for a two-entry toc', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(AVAILABLE);
    mockApi.getCompanionEbookMetadata.mockResolvedValue(metadataFor('book.epub', 2));

    const { container } = renderPanel();

    await screen.findByText(`${formatBytes(SIZE)} · 2 chapters`);
    expect(detailRow(container)).toBe(`${formatBytes(SIZE)} · 2 chapters`);
  });

  // AC15's four combinations. The `sizeBytes: null` row is the one that fails a naive
  // `${size} · ${count}` template: it would render a leading separator over an absent size.
  it('renders the count alone, with no leading separator, when the size is null', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(
      makeState({ status: 'available', filename: 'book.epub', sizeBytes: null }),
    );
    mockApi.getCompanionEbookMetadata.mockResolvedValue(metadataFor('book.epub', 3));

    const { container } = renderPanel();

    await screen.findByText('3 chapters');
    expect(detailRow(container)).toBe('3 chapters');
    expect(detailRow(container).startsWith('·')).toBe(false);
    expect(detailRow(container).startsWith(' ')).toBe(false);
    expect(container.textContent).not.toContain('0 B');
  });

  it('renders the size alone when the toc is null', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(AVAILABLE);
    mockApi.getCompanionEbookMetadata.mockResolvedValue(metadataFor('book.epub', null));

    const { container } = renderPanel();

    await screen.findByText('book.epub');
    await flush();

    expect(detailRow(container)).toBe(formatBytes(SIZE));
    // The `toc?.length ?? 0` bug, pinned: `toc: null` is "we could not read one", never zero.
    expect(container.textContent).not.toContain('0 chapters');
    expect(container.textContent ?? '').not.toMatch(/\d+\s+chapters?\b/i);
    // The filenames MATCH, so this is AC12's second term, not a mismatch — nothing to recover.
    expect(mockApi.getCompanionEbookState).toHaveBeenCalledTimes(1);
  });

  it('omits the detail row entirely when neither the size nor the count is renderable', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(
      makeState({ status: 'available', filename: 'book.epub', sizeBytes: null }),
    );
    mockApi.getCompanionEbookMetadata.mockResolvedValue(metadataFor('book.epub', null));

    const { container } = renderPanel();
    await screen.findByText('book.epub');
    await flush();

    expect(card(container).children).toHaveLength(1); // the filename row alone
  });

  // Extends the shipped `0 B` case: `sizeBytes !== null`, never a truthiness test.
  it('renders "0 B · 5 chapters" for a zero-byte file with a five-entry toc', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(
      makeState({ status: 'available', filename: 'empty.epub', sizeBytes: 0 }),
    );
    mockApi.getCompanionEbookMetadata.mockResolvedValue(metadataFor('empty.epub', 5));

    const { container } = renderPanel();

    await screen.findByText('0 B · 5 chapters');
    expect(detailRow(container)).toBe('0 B · 5 chapters');
  });

  // -------------------------------------------------------------------------
  // AC12 — detection
  // -------------------------------------------------------------------------

  it('renders no count when the metadata response names a different file', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(AVAILABLE); // filename: 'book.epub'
    mockApi.getCompanionEbookMetadata.mockResolvedValue(metadataFor('other.epub', 3));

    const { container } = renderPanel();
    await screen.findByText('book.epub');
    await flush();

    // The exact row text, not a `not.toMatch` alone: a regression that renders the count
    // somewhere else in the card must fail here.
    expect(detailRow(container)).toBe(formatBytes(SIZE));
    expect(container.textContent ?? '').not.toMatch(/\d+\s+chapters?\b/i);
    expect(screen.getByText('book.epub')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download EPUB' })).toBeInTheDocument();
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // AC13 — recovery
  // -------------------------------------------------------------------------

  /**
   * The regression for the motivating Refresh & Scan race, driven end to end.
   *
   * `useBookActions`'s `onSettled` performs ONE book-prefix invalidation against a
   * fire-and-forget server reconcile, and #2034's poll window is armed only by the panel's own
   * re-check button. So `/state` can refetch BEFORE the reconcile commits — call 2 is
   * deliberately the pre-commit row — while `/metadata` reads the row AFTER it. Nothing but
   * AC13's effect ever re-reads `/state` again, which is exactly what the final assertion pins.
   *
   * The mocks are scripted by CALL INDEX rather than re-pointed mid-test: re-pointing races
   * AC13's own revalidation, which fires as soon as the mismatched pair renders. Call 3 is HELD
   * (`makeDeferred`) for the same reason — an immediately-resolved recovery can settle inside the
   * same `act` cycle, erasing the intermediate size-without-count state before it is observable.
   */
  it('recovers from a mismatch by revalidating /state, and converges in one round trip', async () => {
    const held = makeDeferred<CompanionEbookState>();
    mockApi.getCompanionEbookState
      .mockResolvedValueOnce(A_STATE)   // 1: the mount
      .mockResolvedValueOnce(A_STATE)   // 2: the book-prefix refetch, still pre-commit — the race
      .mockReturnValue(held.promise);   // 3: AC13's recovery, held
    mockApi.getCompanionEbookMetadata
      .mockResolvedValueOnce(metadataFor('A.epub', 3))
      .mockResolvedValue(metadataFor('B.epub', 7));

    const { container, client } = renderPanel();
    await screen.findByText(`${formatBytes(SIZE)} · 3 chapters`);

    // Exactly what `invalidateBookQueries()` does. No pollUntil armed, re-check never clicked.
    await act(async () => {
      void client.invalidateQueries({ queryKey: queryKeys.book(BOOK_ID) });
      await Promise.resolve();
    });

    // While the recovery request is still in flight: A's size, no count.
    await waitFor(() => expect(detailRow(container)).toBe(formatBytes(SIZE)));
    expect(container.textContent ?? '').not.toMatch(/\d+\s+chapters?\b/i);
    await waitFor(() => expect(mockApi.getCompanionEbookState.mock.calls.length).toBe(3));

    // …and nothing else invalidates anything from here on.
    await act(async () => { held.resolve(B_STATE); await Promise.resolve(); });

    await screen.findByText(`${formatBytes(SIZE2)} · 7 chapters`);
    expect(screen.getByText('B.epub')).toBeInTheDocument();
  });

  it('converges the same way under StrictMode', async () => {
    const held = makeDeferred<CompanionEbookState>();
    mockApi.getCompanionEbookState
      .mockResolvedValueOnce(A_STATE)
      .mockResolvedValueOnce(A_STATE)
      .mockReturnValue(held.promise);
    mockApi.getCompanionEbookMetadata
      .mockResolvedValueOnce(metadataFor('A.epub', 3))
      .mockResolvedValue(metadataFor('B.epub', 7));

    const client = makeClient();
    render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <CompanionEbookSection bookId={BOOK_ID} />
        </QueryClientProvider>
      </StrictMode>,
    );

    await screen.findByText(`${formatBytes(SIZE)} · 3 chapters`);
    await act(async () => {
      void client.invalidateQueries({ queryKey: queryKeys.book(BOOK_ID) });
      await Promise.resolve();
    });
    await waitFor(() => expect(mockApi.getCompanionEbookState.mock.calls.length).toBeGreaterThan(2));
    await act(async () => { held.resolve(B_STATE); await Promise.resolve(); });

    // No exact `/state` call count is asserted: AC13 permits StrictMode's development-only
    // double setup, and pinning a number here would encode a guarantee the spec declines to make.
    await screen.findByText(`${formatBytes(SIZE2)} · 7 chapters`);
  });

  /**
   * The no-loop property — NOT an exactly-once count. `/state` keeps answering `A.epub` and
   * `/metadata` keeps answering `B.epub`, so the pair never changes; the effect's dependencies
   * are primitive strings, so a revalidation that returns the same row leaves them
   * `Object.is`-equal and nothing re-fires. Sampled twice around a flush rather than compared to
   * a literal, which StrictMode would make unstable.
   */
  it('stops revalidating once the mismatched pair stops changing', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(A_STATE);
    mockApi.getCompanionEbookMetadata.mockResolvedValue(metadataFor('B.epub', 7));

    renderPanel();
    await screen.findByText('A.epub');
    await waitFor(() => expect(mockApi.getCompanionEbookState.mock.calls.length).toBeGreaterThan(1));
    await flush();

    const settled = mockApi.getCompanionEbookState.mock.calls.length;
    await flush();
    await flush();

    expect(mockApi.getCompanionEbookState.mock.calls.length).toBe(settled);
  });

  /**
   * A NON-consecutive return to the same pair re-fires, and that is correct: React compares
   * dependencies only against the previous render, so `A/B → A/C → A/B` is three distinct
   * observations of the world and re-attempting recovery on the third is right.
   *
   * The observation point is the recovery SIDE EFFECT at the third transition, not the absence
   * of a count. Asserting only "no count, no spin" is vacuous — both stay true for an
   * implementation that wrongly remembers `A/B` and suppresses the third revalidation, which is
   * exactly the handled-pair registry AC13 forbids (`vacuous-assertion-observation-points`).
   */
  it('re-fires when the same mismatched pair returns non-consecutively', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(A_STATE);
    mockApi.getCompanionEbookMetadata
      .mockResolvedValueOnce(metadataFor('B.epub', 7))
      .mockResolvedValueOnce(metadataFor('C.epub', 5))
      .mockResolvedValue(metadataFor('B.epub', 7));

    const { client } = renderPanel();
    await screen.findByText('A.epub');
    // A/B observed at mount → one recovery.
    await waitFor(() => expect(mockApi.getCompanionEbookState.mock.calls.length).toBe(2));

    const refetchMetadata = () =>
      act(async () => {
        void client.invalidateQueries({ queryKey: META_KEY('A.epub'), exact: true });
        await Promise.resolve();
      });

    await refetchMetadata(); // → C.epub, a new pair
    await waitFor(() => expect(mockApi.getCompanionEbookState.mock.calls.length).toBe(3));
    await flush();
    const afterAC = mockApi.getCompanionEbookState.mock.calls.length;

    await refetchMetadata(); // → B.epub again, a pair already seen once

    await waitFor(() => expect(mockApi.getCompanionEbookState.mock.calls.length).toBe(afterAC + 1));
    await flush();
    expect(mockApi.getCompanionEbookState.mock.calls.length).toBe(afterAC + 1);
  });

  /**
   * A retained entry for a RETURNING filename is used, not discarded (AC11/AC17).
   *
   * Phase one's load-bearing assertion is the UNCHANGED metadata call count: asserting only that
   * the count eventually appears would also pass for an implementation that reads a key change
   * as "discard and refetch". Phase two needs an EXPLICIT refetch trigger, because
   * `setQueryData` timestamps the entry fresh and the query inherits the 60s `staleTime`, so the
   * A→B switch serves it synchronously and starts nothing on its own.
   */
  it('serves a retained entry for a returning filename, and keeps the count when its refetch fails', async () => {
    const client = makeClient();
    client.setQueryData(META_KEY('B.epub'), metadataFor('B.epub', 7));
    mockApi.getCompanionEbookState.mockResolvedValueOnce(A_STATE).mockResolvedValue(B_STATE);
    mockApi.getCompanionEbookMetadata.mockResolvedValue(metadataFor('A.epub', 3));

    renderPanel(BOOK_ID, client);
    await screen.findByText(`${formatBytes(SIZE)} · 3 chapters`);
    const afterMount = mockApi.getCompanionEbookMetadata.mock.calls.length;

    // Phase one — move `/state` A→B. B's own entry already holds a coherent response.
    await act(async () => {
      void client.invalidateQueries({ queryKey: queryKeys.companionEbook(BOOK_ID), exact: true });
      await Promise.resolve();
    });
    await screen.findByText(`${formatBytes(SIZE2)} · 7 chapters`);
    expect(mockApi.getCompanionEbookMetadata.mock.calls.length).toBe(afterMount);

    // Phase two — force B's entry to refetch, and fail it. The retained response still governs.
    mockApi.getCompanionEbookMetadata.mockClear();
    mockApi.getCompanionEbookMetadata.mockRejectedValue(NO_METADATA());
    await act(async () => {
      void client.invalidateQueries({ queryKey: META_KEY('B.epub'), exact: true });
      await Promise.resolve();
    });

    await waitFor(() => {
      const entry = client.getQueryState(META_KEY('B.epub'));
      expect(entry?.status).toBe('error');
      expect(entry?.fetchStatus).toBe('idle');
    });
    expect(mockApi.getCompanionEbookMetadata).toHaveBeenCalledTimes(4);
    expect(screen.getByText(`${formatBytes(SIZE2)} · 7 chapters`)).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // AC17 — the failure policy, split on whether a successful response is retained
  // -------------------------------------------------------------------------

  const coldFailures: Array<[string, unknown]> = [
    ['404', new ApiError(404, { error: 'Companion ebook not found' })],
    ['503', new ApiError(503, { error: 'Companion ebook candidates could not be listed' })],
    ['a plain network rejection', new Error('network')],
  ];

  for (const [label, failure] of coldFailures) {
    it(`leaves the panel exactly as it is when a cold metadata read fails with ${label}`, async () => {
      mockApi.getCompanionEbookState.mockResolvedValue(AVAILABLE);
      mockApi.getCompanionEbookMetadata.mockRejectedValue(failure);

      const { container, client } = renderPanel();
      await screen.findByText('book.epub');
      await waitFor(() =>
        expect(client.getQueryState(META_KEY('book.epub'))?.status).toBe('error'));

      expect(heading()).toBeInTheDocument();
      expect(screen.getByText('book.epub')).toBeInTheDocument();
      expect(detailRow(container)).toBe(formatBytes(SIZE));
      expect(screen.getByRole('link', { name: 'Download EPUB' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: REFRESH_LABEL })).toBeInTheDocument();
      expect(container.textContent ?? '').not.toMatch(/\d+\s+chapters?\b/i);
      expect(mockToast.error).not.toHaveBeenCalled();
      // Nothing to compare, so nothing to recover from.
      expect(mockApi.getCompanionEbookState).toHaveBeenCalledTimes(1);
    });
  }

  /**
   * The retained arm, and the test that fails if AC17's first arm is read as "hide the count on
   * any metadata error". Real timers, driven through the real query.
   *
   * The terminal-state wait is mandatory: immediately after the invalidation the count is still
   * rendered, no banner exists, and `/state` has not refetched — all three are already true
   * while the refetch is merely PENDING, so without it this passes without ever reaching the
   * retained-error state (`vacuous-assertion-observation-points`).
   */
  it('keeps the count when a metadata REFETCH fails after a successful response', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(AVAILABLE);
    mockApi.getCompanionEbookMetadata.mockResolvedValue(metadataFor('book.epub', 3));

    const { container, client } = renderPanel();
    await screen.findByText(`${formatBytes(SIZE)} · 3 chapters`);
    const stateCalls = mockApi.getCompanionEbookState.mock.calls.length;

    mockApi.getCompanionEbookMetadata.mockClear();
    mockApi.getCompanionEbookMetadata.mockRejectedValue(NO_METADATA());
    await act(async () => {
      void client.invalidateQueries({ queryKey: META_KEY('book.epub'), exact: true });
      await Promise.resolve();
    });

    await waitFor(() => {
      const entry = client.getQueryState(META_KEY('book.epub'));
      expect(entry?.status).toBe('error');
      expect(entry?.fetchStatus).toBe('idle');
    });
    // `failureCount` starts at 0 and the predicate permits three retries, so the ladder runs to
    // four attempts. The number is what proves it ran to exhaustion rather than the test landing
    // after attempt one.
    expect(mockApi.getCompanionEbookMetadata).toHaveBeenCalledTimes(4);

    expect(detailRow(container)).toBe(`${formatBytes(SIZE)} · 3 chapters`);
    expect(screen.getByText('book.epub')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download EPUB' })).toBeInTheDocument();
    expect(mockToast.error).not.toHaveBeenCalled();
    // The retained filename still matches, so AC13 must not fire.
    expect(mockApi.getCompanionEbookState.mock.calls.length).toBe(stateCalls);
  });

  // AC18 — the same 409-aware predicate the state query uses, proved against a client that does
  // NOT supply one.
  it('never retries a 409 metadata read', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(AVAILABLE);
    mockApi.getCompanionEbookMetadata.mockRejectedValue(
      new ApiError(409, { error: 'Companion ebooks are disabled' }),
    );

    const { client } = renderPanel();
    await screen.findByText('book.epub');
    await waitFor(() =>
      expect(client.getQueryState(META_KEY('book.epub'))?.status).toBe('error'));

    expect(mockApi.getCompanionEbookMetadata).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Download (AC19, AC20)
// ---------------------------------------------------------------------------

describe('CompanionEbookSection — download', () => {
  it('renders a real anchor carrying the helper URL and the download attribute', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(AVAILABLE);
    renderPanel();

    const link = await screen.findByRole('link', { name: 'Download EPUB' });
    expect(link).toHaveAttribute('href', api.getCompanionEbookDownloadUrl(BOOK_ID));
    expect(link).toHaveAttribute('download');
  });

  // `drm_protected` is not here (#2038): it renders a real, live link, asserted below. The
  // remaining three stay absence — `none` has no file, `ambiguous` has no chosen file, and
  // `invalid`'s file is not servable — and absence is accurate for all three.
  const noDownloadStates: Array<[string, CompanionEbookState]> = [
    ['none', NONE],
    ['ambiguous', ambiguous(candidateList('a.epub', 'b.epub'))],
    ['invalid', INVALID],
  ];

  for (const [label, state] of noDownloadStates) {
    it(`${label} renders no download control of any kind`, async () => {
      mockApi.getCompanionEbookState.mockResolvedValue(state);
      renderPanel();
      await screen.findByRole('heading', { name: 'Ebook' });

      expect(screen.queryByRole('link', { name: /download/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /download/i })).toBeNull();
    });
  }

  /**
   * INVERTED by #2038, which is the client half of the exposure split. The server's owner gate
   * now admits a stored `drm_protected` row, so the anchor here resolves rather than 404ing, and
   * the disabled button that stood in for it is gone.
   *
   * Both halves are asserted: a live link with the same href helper and `download` attribute the
   * `available` state uses, AND no download BUTTON anywhere — a component that renders both
   * would satisfy either assertion alone.
   */
  it('drm_protected renders the same real download link as available, and no disabled button', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(DRM);
    renderPanel();
    await screen.findByText('DRM-protected');

    const link = screen.getByRole('link', { name: 'Download EPUB' });
    // The helper, not a bare `/api/...` string: it carries `URL_BASE`, and a hand-built href
    // silently breaks every sub-path deployment.
    expect(link).toHaveAttribute('href', api.getCompanionEbookDownloadUrl(BOOK_ID));
    expect(link).toHaveAttribute('download');
    expect(screen.queryByRole('button', { name: /download/i })).toBeNull();
  });

  it('drm_protected renders the filename truncated with the full name as its tooltip', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(DRM);
    renderPanel();
    await screen.findByText('DRM-protected');

    const el = screen.getByText('locked.epub');
    expect(el).toHaveClass('truncate');
    expect(el).toHaveAttribute('title', 'locked.epub');
  });
});

// ---------------------------------------------------------------------------
// The ambiguous picker (AC21-AC27)
// ---------------------------------------------------------------------------

describe('CompanionEbookSection — the ambiguous picker', () => {
  const TWO = candidateList('A.epub', 'B.epub');

  async function renderPicker(candidates = TWO, client = makeClient(), bookId = BOOK_ID) {
    mockApi.getCompanionEbookState.mockResolvedValueOnce(ambiguous(candidates));
    const panel = renderPanel(bookId, client);
    await screen.findByRole('radio', { name: candidates[0]!.filename });
    return panel;
  }

  it('submits the server-issued index and nothing else', async () => {
    mockApi.putCompanionEbookSelection.mockResolvedValue(AVAILABLE);
    await renderPicker();

    await userEvent.click(screen.getByRole('radio', { name: 'B.epub' }));
    await userEvent.click(screen.getByRole('button', { name: AMBIGUOUS_SUBMIT }));

    await waitFor(() => expect(mockApi.putCompanionEbookSelection).toHaveBeenCalled());
    expect(mockApi.putCompanionEbookSelection.mock.calls[0]).toEqual([BOOK_ID, 1]);
  });

  it('disables submit before a pick and while the mutation is pending', async () => {
    const held = makeDeferred<CompanionEbookState>();
    mockApi.putCompanionEbookSelection.mockReturnValue(held.promise);
    await renderPicker();

    const submit = screen.getByRole('button', { name: AMBIGUOUS_SUBMIT });
    expect(submit).toBeDisabled();

    await userEvent.click(screen.getByRole('radio', { name: 'B.epub' }));
    expect(submit).toBeEnabled();

    await userEvent.click(submit);
    await waitFor(() => expect(submit).toBeDisabled());

    await act(async () => { held.resolve(AVAILABLE); await held.promise; });
  });

  // AC26: "No optimistic pre-write update anywhere: nothing is written to the cache until the
  // server confirms." Asserting only that the submit button is disabled does not reject an
  // `onMutate` that projects the post-selection state — especially one that rolls back on
  // error, which would leave every settled-state test green. So this pins BOTH surfaces while
  // the PUT is still in flight: the picker is still on screen, and the cache still holds the
  // pre-write ambiguous payload.
  it('writes nothing to the UI or the cache while the selection is in flight', async () => {
    const held = makeDeferred<CompanionEbookState>();
    mockApi.putCompanionEbookSelection.mockReturnValue(held.promise);
    const client = makeClient();
    await renderPicker(TWO, client);
    const before = client.getQueryData(queryKeys.companionEbook(BOOK_ID));

    await userEvent.click(screen.getByRole('radio', { name: 'B.epub' }));
    await userEvent.click(screen.getByRole('button', { name: AMBIGUOUS_SUBMIT }));
    await waitFor(() => expect(mockApi.putCompanionEbookSelection).toHaveBeenCalled());

    // Still the picker, unchanged, with the owner's pick intact.
    expect(screen.getByText(AMBIGUOUS_QUESTION)).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByRole('radio', { name: 'B.epub' })).toBeChecked();
    expect(screen.getByText('2 found')).toBeInTheDocument();
    expect(screen.queryByText('book.epub')).toBeNull(); // AVAILABLE's filename: the post-write card must not exist yet
    expect(screen.queryByRole('link', { name: /download/i })).toBeNull();

    // And the cache is byte-for-byte the pre-write payload.
    expect(client.getQueryData(queryKeys.companionEbook(BOOK_ID))).toEqual(ambiguous(TWO));
    expect(client.getQueryData(queryKeys.companionEbook(BOOK_ID))).toEqual(before);

    // Only after the server confirms does the panel move.
    await act(async () => { held.resolve(AVAILABLE); await held.promise; });
    expect(await screen.findByText('book.epub')).toBeInTheDocument();
  });

  // AC22/AC23 — an index-backed implementation fails both assertions.
  it('a reorder keeps the owner\'s file selected and submits that file\'s NEW index', async () => {
    mockApi.putCompanionEbookSelection.mockResolvedValue(AVAILABLE);
    const { client } = await renderPicker();

    await userEvent.click(screen.getByRole('radio', { name: 'B.epub' }));

    mockApi.getCompanionEbookState.mockResolvedValueOnce(ambiguous(candidateList('B.epub', 'A.epub')));
    await triggerRefetch(client);
    await waitFor(() => expect(screen.getAllByRole('radio')[0]).toHaveAccessibleName('B.epub'));

    expect(screen.getByRole('radio', { name: 'B.epub' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'A.epub' })).not.toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: AMBIGUOUS_SUBMIT }));
    await waitFor(() => expect(mockApi.putCompanionEbookSelection).toHaveBeenCalled());
    expect(mockApi.putCompanionEbookSelection.mock.calls[0]).toEqual([BOOK_ID, 0]);
  });

  it('a candidate that disappears from a refetch clears the pick rather than retargeting a sibling', async () => {
    const { client } = await renderPicker();
    await userEvent.click(screen.getByRole('radio', { name: 'B.epub' }));

    mockApi.getCompanionEbookState.mockResolvedValueOnce(ambiguous(candidateList('A.epub', 'C.epub')));
    await triggerRefetch(client);
    await waitFor(() => expect(screen.queryByRole('radio', { name: 'B.epub' })).toBeNull());

    for (const radio of screen.getAllByRole('radio')) expect(radio).not.toBeChecked();
    expect(screen.getByRole('button', { name: AMBIGUOUS_SUBMIT })).toBeDisabled();
  });

  // AC24 — the shared basename is the point: an implementation that keeps `pickedFilename`
  // across books passes a fixture with disjoint names.
  it('a book change clears the pick even when the new book offers the same basename', async () => {
    const client = makeClient();
    mockApi.getCompanionEbookState.mockResolvedValueOnce(ambiguous(TWO));
    const panel = renderPanel(1, client);
    await screen.findByRole('radio', { name: 'B.epub' });

    await userEvent.click(screen.getByRole('radio', { name: 'B.epub' }));
    expect(screen.getByRole('radio', { name: 'B.epub' })).toBeChecked();

    mockApi.getCompanionEbookState.mockResolvedValueOnce(ambiguous(candidateList('B.epub', 'D.epub')));
    await act(async () => { panel.rerenderBook(2); });
    await waitFor(() => expect(screen.getByRole('radio', { name: 'D.epub' })).toBeInTheDocument());

    for (const radio of screen.getAllByRole('radio')) expect(radio).not.toBeChecked();
    expect(screen.getByRole('button', { name: AMBIGUOUS_SUBMIT })).toBeDisabled();
  });

  it('invalidates the companion key, toasts the authored success sentence, and renders the refetched state', async () => {
    mockApi.putCompanionEbookSelection.mockResolvedValue(AVAILABLE);
    const client = makeClient();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    await renderPicker(TWO, client);

    await userEvent.click(screen.getByRole('radio', { name: 'A.epub' }));
    mockApi.getCompanionEbookState.mockResolvedValue(AVAILABLE);
    await userEvent.click(screen.getByRole('button', { name: AMBIGUOUS_SUBMIT }));

    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith(SELECTION_SUCCESS_TOAST));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['books', BOOK_ID, 'companion-epub'] });
    expect(await screen.findByText('book.epub')).toBeInTheDocument();
  });

  // AC26/AC28 — without the setQueryData handoff the panel keeps rendering the stale
  // ambiguous data: a success toast over a live obsolete picker.
  it('installs the PUT body into the cache, so a failing confirmation refetch cannot restore the picker', async () => {
    mockApi.putCompanionEbookSelection.mockResolvedValue(AVAILABLE);
    await renderPicker();

    await userEvent.click(screen.getByRole('radio', { name: 'A.epub' }));
    mockApi.getCompanionEbookState.mockRejectedValue(new ApiError(503, { error: 'unavailable' }));
    await userEvent.click(screen.getByRole('button', { name: AMBIGUOUS_SUBMIT }));

    expect(await screen.findByText('book.epub')).toBeInTheDocument();
    expect(screen.getByText(formatBytes(SIZE))).toBeInTheDocument();
    expect(screen.queryByText(AMBIGUOUS_QUESTION)).toBeNull();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: AMBIGUOUS_SUBMIT })).toBeNull();
    expect(mockToast.success).toHaveBeenCalledWith(SELECTION_SUCCESS_TOAST);
  });

  // AC26 — what the `cancelQueries` before `setQueryData` buys. The ORDER is the assertion:
  // `onSettled`'s invalidation happens to cancel an in-flight GET too, so an end-state-only
  // test passes with the cancel removed and proves nothing about the window between the write
  // and that invalidation, which is exactly where a pre-write response would land.
  it('cancels an in-flight /state GET before installing the post-write body, and a late pre-write response does not win', async () => {
    const inFlight = makeDeferred<CompanionEbookState>();
    const client = makeClient();
    const cancelSpy = vi.spyOn(client, 'cancelQueries');
    const setDataSpy = vi.spyOn(client, 'setQueryData');
    mockApi.getCompanionEbookState
      .mockResolvedValueOnce(ambiguous(TWO))     // initial render
      .mockReturnValueOnce(inFlight.promise)     // the pre-write GET, held
      .mockResolvedValue(AVAILABLE);             // the onSettled confirmation
    renderPanel(BOOK_ID, client);
    await screen.findByRole('radio', { name: 'A.epub' });

    await userEvent.click(screen.getByRole('radio', { name: 'A.epub' }));
    await triggerRefetch(client); // the older GET is now in flight
    cancelSpy.mockClear();
    setDataSpy.mockClear();

    mockApi.putCompanionEbookSelection.mockResolvedValue(AVAILABLE);
    await userEvent.click(screen.getByRole('button', { name: AMBIGUOUS_SUBMIT }));
    await waitFor(() =>
      expect(setDataSpy).toHaveBeenCalledWith(queryKeys.companionEbook(BOOK_ID), AVAILABLE));

    expect(cancelSpy).toHaveBeenCalledWith({ queryKey: queryKeys.companionEbook(BOOK_ID) });
    expect(cancelSpy.mock.invocationCallOrder[0]!)
      .toBeLessThan(setDataSpy.mock.invocationCallOrder[0]!);

    // The stale GET resolves LAST, with pre-write state.
    await act(async () => { inFlight.resolve(ambiguous(TWO)); await inFlight.promise; });

    expect(screen.getByText('book.epub')).toBeInTheDocument();
    expect(screen.queryByText(AMBIGUOUS_QUESTION)).toBeNull();
  });

  it('clears the pending pick on success, so a later ambiguous state starts unchecked', async () => {
    mockApi.putCompanionEbookSelection.mockResolvedValue(AVAILABLE);
    const client = makeClient();
    await renderPicker(TWO, client);

    await userEvent.click(screen.getByRole('radio', { name: 'B.epub' }));
    mockApi.getCompanionEbookState.mockResolvedValue(AVAILABLE);
    await userEvent.click(screen.getByRole('button', { name: AMBIGUOUS_SUBMIT }));
    await waitFor(() => expect(mockToast.success).toHaveBeenCalled());

    mockApi.getCompanionEbookState.mockResolvedValue(ambiguous(TWO));
    await triggerRefetch(client);
    await waitFor(() => expect(screen.getByRole('radio', { name: 'B.epub' })).toBeInTheDocument());

    for (const radio of screen.getAllByRole('radio')) expect(radio).not.toBeChecked();
    expect(screen.getByRole('button', { name: AMBIGUOUS_SUBMIT })).toBeDisabled();
  });

  // AC27 — fixtures use the real shipped server sentences so a passthrough fails loudly. The
  // 500 case matters on its own: without it the default `ApiError` arm never executes.
  const errorCases: Array<[string, unknown, string]> = [
    ['400', new ApiError(400, { error: 'Candidate index is out of range' }), 'That file is no longer in the list. Pick again.'],
    ['404', new ApiError(404, { error: 'Companion ebook not found' }), "That ebook isn't there anymore. Rescan and try again."],
    ['409', new ApiError(409, { error: 'Companion ebook selection conflicted with a concurrent change' }), 'Something changed while you were choosing. Refresh the page and try again.'],
    ['503', new ApiError(503, { error: 'Companion ebook selection could not be completed' }), SELECTION_ERROR_FALLBACK],
    ['an unmapped 500', new ApiError(500, { error: 'Companion ebook selection failed' }), SELECTION_ERROR_FALLBACK],
    ['a non-ApiError rejection', new Error('boom'), SELECTION_ERROR_FALLBACK],
  ];

  for (const [label, failure, expected] of errorCases) {
    it(`maps ${label} to the client's own sentence and leaks no server copy`, async () => {
      mockApi.putCompanionEbookSelection.mockRejectedValue(failure);
      await renderPicker();

      await userEvent.click(screen.getByRole('radio', { name: 'A.epub' }));
      await userEvent.click(screen.getByRole('button', { name: AMBIGUOUS_SUBMIT }));

      await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith(expected));
      const message = mockToast.error.mock.calls[0]![0] as string;
      expect(message.toLowerCase()).not.toContain('companion');
      expect(message).not.toContain('—');
      // The panel stays on ambiguous.
      expect(screen.getByText(AMBIGUOUS_QUESTION)).toBeInTheDocument();
    });
  }
});

// ---------------------------------------------------------------------------
// The stale-settlement guard (AC26)
// ---------------------------------------------------------------------------

describe('CompanionEbookSection — stale settlements', () => {
  const TWO = candidateList('A.epub', 'B.epub');

  const teardowns: Array<[string, (panel: ReturnType<typeof renderPanel>) => void]> = [
    ['unmount', (panel) => panel.unmount()],
    ['a book change', (panel) => panel.rerenderBook(2)],
  ];
  const settlements: Array<[string, boolean]> = [['resolves', true], ['rejects', false]];

  for (const [teardownName, tearDown] of teardowns) {
    for (const [settlementName, resolves] of settlements) {
      it(`a selection that ${settlementName} after ${teardownName} toasts nothing but still reconciles book 1's cache`, async () => {
        const held = makeDeferred<CompanionEbookState>();
        const client = makeClient();
        const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
        mockApi.getCompanionEbookState
          .mockResolvedValueOnce(ambiguous(TWO))    // book 1
          .mockResolvedValue(NONE);                 // book 2, if it mounts
        mockApi.putCompanionEbookSelection.mockReturnValue(held.promise);

        const panel = renderPanel(1, client);
        await screen.findByRole('radio', { name: 'B.epub' });
        await userEvent.click(screen.getByRole('radio', { name: 'B.epub' }));
        await userEvent.click(screen.getByRole('button', { name: AMBIGUOUS_SUBMIT }));
        await waitFor(() => expect(mockApi.putCompanionEbookSelection).toHaveBeenCalled());

        await act(async () => { tearDown(panel); });
        invalidateSpy.mockClear();

        await act(async () => {
          if (resolves) held.resolve(AVAILABLE); else held.reject(new ApiError(503, { error: 'nope' }));
          await held.promise.catch(() => {});
          await Promise.resolve();
        });

        expect(mockToast.success).not.toHaveBeenCalled();
        expect(mockToast.error).not.toHaveBeenCalled();

        // Server truth is reconciled unconditionally, and keyed on the book that was mutated.
        await waitFor(() =>
          expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['books', 1, 'companion-epub'] }));
        if (resolves) {
          expect(client.getQueryData(queryKeys.companionEbook(1))).toEqual(AVAILABLE);
          expect(client.getQueryData(queryKeys.companionEbook(2))).not.toEqual(AVAILABLE);
        }
      });
    }
  }

  // The generation advance must run on the SYNCHRONOUS layout seam. React runs all layout
  // CLEANUPS before all layout SETUPS, so a layout-cleanup seam yields
  // [A-teardown, B-interactive]; a passive `useEffect` cleanup would run A-teardown in the
  // passive phase (after B's setup) and reverse the order.
  it('advances the selection generation before the next book is interactive — layout-seam ordering', async () => {
    const client = makeClient();
    mockApi.getCompanionEbookState.mockResolvedValue(ambiguous(TWO));
    const panel = renderPanel(1, client, () => { orderMarks.push('B-interactive'); });
    await screen.findByRole('radio', { name: 'B.epub' });

    orderMarks.length = 0; // clear mount-time noise; capture only the transition commit
    panel.armForNext();
    panel.rerenderBook(2); // synchronous book-change commit

    expect(orderMarks).toEqual(['A-teardown', 'B-interactive']);
  });
});

// ---------------------------------------------------------------------------
// Hostile filenames (#2026 row 15)
// ---------------------------------------------------------------------------

/**
 * The two sites that render a server-supplied basename: `AmbiguousBody`'s radio list and
 * `InvalidBody`'s panel. A companion basename is whatever the owner named the file on disk, so
 * it is attacker-influenced in exactly the way a filename always is.
 *
 * React escapes text children by default and `companion-ebook-copy.ts` has no
 * `dangerouslySetInnerHTML` — so this passes today for structural reasons, which is precisely
 * why it is asserted rather than assumed. The assumption is what a future refactor breaks: a
 * switch to `dangerouslySetInnerHTML` for highlighting, or a copy helper that interpolates the
 * filename into a markup string, would turn both sites into injection points and neither of
 * this suite's other rows would notice.
 */
describe('CompanionEbookSection — a hostile filename renders as text', () => {
  const HOSTILE = '<img src=x onerror=alert(1)>.epub';

  /** No markup was interpreted anywhere under the panel — the literal is the whole answer. */
  function expectRenderedAsText(container: HTMLElement): void {
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    // Present as a text node, escaped: `getByText` matches on textContent, never on markup.
    expect(screen.getByText(HOSTILE)).toBeInTheDocument();
    // And on the `title` attribute both sites set for the truncated spelling.
    expect(attributeText(container)).toContain(HOSTILE);
  }

  it('escapes it in the ambiguous picker', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(
      ambiguous(candidateList(HOSTILE, 'ordinary.epub')),
    );
    const { container } = renderPanel();

    expect(await screen.findByText(AMBIGUOUS_QUESTION)).toBeInTheDocument();
    expectRenderedAsText(container);
    // The radio carries it as a VALUE, not as parsed markup.
    expect(screen.getByRole('radio', { name: HOSTILE })).toHaveAttribute('value', HOSTILE);
  });

  it('escapes it in the invalid panel', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(
      makeState({ status: 'invalid', filename: HOSTILE, sizeBytes: SIZE, validationCode: 'empty_spine' }),
    );
    const { container } = renderPanel();

    expect(await screen.findByText(invalidSentence('empty_spine'))).toBeInTheDocument();
    expectRenderedAsText(container);
  });
});

// ---------------------------------------------------------------------------
// Invalidation (AC29)
// ---------------------------------------------------------------------------

describe('companion-ebook query key', () => {
  it('is a prefix-child of queryKeys.book(id), so invalidating the book cascades to it', async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.companionEbook(BOOK_ID), AVAILABLE);

    await client.invalidateQueries({ queryKey: queryKeys.book(BOOK_ID) });

    const entry = client.getQueryCache().find({ queryKey: queryKeys.companionEbook(BOOK_ID) });
    expect(entry?.state.isInvalidated).toBe(true);
  });

  // #2022 AC10 — the metadata key is a prefix-child of BOTH, so `invalidateBookQueries()` and
  // #2034's forced-refresh invalidation each cascade to it with no new invalidateQueries call.
  it.each<[string, (id: number) => readonly unknown[]]>([
    ['queryKeys.book(id)', queryKeys.book],
    ['queryKeys.companionEbook(id)', queryKeys.companionEbook],
  ])('companionEbookMetadata is a prefix-child of %s', async (_label, prefix) => {
    const client = new QueryClient();
    client.setQueryData(META_KEY('book.epub'), metadataFor('book.epub', 3));

    await client.invalidateQueries({ queryKey: prefix(BOOK_ID) });

    expect(client.getQueryCache().find({ queryKey: META_KEY('book.epub') })?.state.isInvalidated)
      .toBe(true);
  });

  /**
   * AC13's `exact: true`, in the direction that actually pins it. Without `exact` the recovery
   * invalidation would also refetch `/metadata` under the still-stale filename — re-reading the
   * same newer row, returning the same mismatched answer, and burning a second `inspectEpub`.
   * This is the assertion that fails if `exact` is dropped.
   */
  it('an exact invalidation of the state key leaves the metadata entry untouched', async () => {
    const client = new QueryClient();
    client.setQueryData(META_KEY('book.epub'), metadataFor('book.epub', 3));

    await client.invalidateQueries({ queryKey: queryKeys.companionEbook(BOOK_ID), exact: true });

    expect(client.getQueryCache().find({ queryKey: META_KEY('book.epub') })?.state.isInvalidated)
      .toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The header re-check button (#2034 — client half)
// ---------------------------------------------------------------------------

describe('CompanionEbookSection — the re-check button', () => {
  for (const [label, state] of ALL_STATES) {
    it(`${label} renders the re-check button`, async () => {
      mockApi.getCompanionEbookState.mockResolvedValue(state);
      renderPanel();
      await screen.findByRole('heading', { name: 'Ebook' });

      expect(screen.getByRole('button', { name: REFRESH_LABEL })).toBeInTheDocument();
    });
  }

  it('click posts the refresh for THIS book and disables the button while pending', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(AVAILABLE);
    let settle!: () => void;
    mockApi.refreshCompanionEbook.mockImplementation(
      () => new Promise<void>((resolve) => { settle = resolve; }),
    );
    renderPanel();
    const user = userEvent.setup();

    const button = await screen.findByRole('button', { name: REFRESH_LABEL });
    await user.click(button);

    expect(mockApi.refreshCompanionEbook).toHaveBeenCalledExactlyOnceWith(BOOK_ID);
    expect(button).toBeDisabled();

    settle();
    await waitFor(() => expect(button).toBeEnabled());
  });

  it('a 202 re-reads /state — the accepted refresh must be observable, not fire-and-forget', async () => {
    // The server answers 202 BEFORE the reconcile runs; the onSuccess invalidation is what
    // makes the panel re-read. The observation point is the /state CALL COUNT growing after
    // the mutation settles — asserting on the mutation alone would prove queuing, not effect.
    mockApi.getCompanionEbookState.mockResolvedValue(AVAILABLE);
    mockApi.refreshCompanionEbook.mockResolvedValue(undefined);
    renderPanel();
    const user = userEvent.setup();

    await screen.findByText('book.epub');
    const callsBefore = mockApi.getCompanionEbookState.mock.calls.length;

    await user.click(screen.getByRole('button', { name: REFRESH_LABEL }));

    await waitFor(() =>
      expect(mockApi.getCompanionEbookState.mock.calls.length).toBeGreaterThan(callsBefore),
    );
    // The polling window beyond this first invalidation refetch is deliberately untested:
    // driving react-query's interval needs fake timers, and full fake timers deadlock
    // TanStack (vitest-faketimers-react-query) while partial fakes have produced the
    // full-suite flake class this repo already documents (#2033). The invalidation refetch
    // is the load-bearing observable; the window only shortens the stale tail.
  });

  it('an instantly-settled POST still shows the spinner for the minimum window', async () => {
    // The bug this pins: the POST answers 202 in tens of milliseconds, so a spinner keyed on
    // `isPending` alone never visibly rendered and the click looked like a no-op. By the time
    // `user.click` resolves, the mutation has settled — so this disabled state is attributable
    // ONLY to the min-spin latch, which is what makes the assertion fail if the latch goes.
    mockApi.getCompanionEbookState.mockResolvedValue(AVAILABLE);
    mockApi.refreshCompanionEbook.mockResolvedValue(undefined);
    renderPanel();
    const user = userEvent.setup();

    const button = await screen.findByRole('button', { name: REFRESH_LABEL });
    await user.click(button);

    expect(button).toBeDisabled();
    await waitFor(() => expect(button).toBeEnabled(), { timeout: 2_000 });
  });

  it('a failed refresh POST toasts and re-enables', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(AVAILABLE);
    mockApi.refreshCompanionEbook.mockRejectedValue(new ApiError(503, 'busy'));
    renderPanel();
    const user = userEvent.setup();

    const button = await screen.findByRole('button', { name: REFRESH_LABEL });
    await user.click(button);

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledExactlyOnceWith(REFRESH_ERROR_TOAST));
    // Re-enables only after the minimum spin elapses — failure holds the latch too, so a
    // instant rejection still reads as "it tried" rather than a dead click.
    await waitFor(() => expect(button).toBeEnabled(), { timeout: 2_000 });
    // The failure is the POST itself; nothing was accepted, so nothing re-reads /state
    // beyond the initial load.
    expect(mockApi.getCompanionEbookState.mock.calls.length).toBe(1);
  });
});
