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

// `clearAllMocks` leaves queued once-responses behind; this suite requires `resetAllMocks`.

/** Records selection teardown synchronously; async mutation callbacks cannot prove layout ordering. */
const { orderMarks } = vi.hoisted(() => ({ orderMarks: [] as string[] }));

vi.mock('./useCompanionEbookSelection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useCompanionEbookSelection.js')>();
  const React = await import('react');
  return {
    ...actual,
    useCompanionEbookSelection: (bookId: number, candidates: CompanionEbookCandidate[]) => {
      const real = actual.useCompanionEbookSelection(bookId, candidates);
      // Preserve reset's stable identity so instrumentation does not retrigger the layout effect.
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
      // This partial mock spreads actual.api; omitting this method would issue a real jsdom fetch.
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
const SIZE2 = 9_900_000;

/** `toc` is never `[]` — `src/core/epub/extract.ts` yields `null` for a zero-row traversal. */
function toc(rows: number): EpubTocEntry[] {
  return Array.from({ length: rows }, (_, index) => ({ title: `Chapter ${index + 1}`, depth: 0 }));
}

/** Filename declares what the server read; null rows mean an unreadable TOC, not zero. */
function metadataFor(filename: string, rows: number | null): CompanionEbookMetadata {
  return {
    filename,
    metadata: { title: 'A Title', author: null, language: null },
    toc: rows === null ? null : toc(rows),
  };
}

const META_KEY = (filename: string) => queryKeys.companionEbookMetadata(BOOK_ID, filename);

/** Cold metadata failure prevents unrelated available fixtures from gaining a chapter row. */
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

/** Production defaults without a retry override; zero delay speeds the unchanged retry ladder. */
function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 1000 * 60, refetchOnWindowFocus: false, retryDelay: 0 },
    },
  });
}

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
 * Pins true DOM absence, not merely missing copy: a bare loading node passes the named checks.
 * Named checks remain for useful failure messages (AC2/AC3).
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

/** Gives scheduled work a chance to violate negative assertions that cannot use `waitFor`. */
async function flush(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  });
}

function triggerRefetch(client: QueryClient, bookId = BOOK_ID) {
  return act(async () => {
    void client.invalidateQueries({ queryKey: queryKeys.companionEbook(bookId) });
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  orderMarks.length = 0;
  // A mismatched default would trigger recovery and contaminate state-call assertions.
  mockApi.getCompanionEbookMetadata.mockRejectedValue(NO_METADATA());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CompanionEbookSection — presence and absence', () => {
  it('renders nothing while the state query is pending', () => {
    mockApi.getCompanionEbookState.mockReturnValue(new Promise(() => {}));
    const { container } = renderPanel();
    expectSilentAbsence(container);
  });

  // Wait for terminal error and assert attempts; pending absence cannot prove terminal behavior.
  // A 409 is the only failure that skips retries.
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

  // Cached data wins over transient errors. The 404 case prevents widening the 409 exception.
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

      // Wait for the query to reach terminal error; asserting while pending would miss error blanking.
      await waitFor(() =>
        expect(client.getQueryState(queryKeys.companionEbook(BOOK_ID))?.status).toBe('error'));

      expect(screen.getByText('book.epub')).toBeInTheDocument();
      expect(screen.getByText(formatBytes(SIZE))).toBeInTheDocument();
    });
  }

  // This client supplies no retry override, so the component's 409 predicate is observable.
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

    // Three retries produce four total attempts.
    await waitFor(() => expect(mockApi.getCompanionEbookState).toHaveBeenCalledTimes(4));
    expect(screen.getByText('book.epub')).toBeInTheDocument();
  });

  it('hides a cached panel once /state answers 409, and stays hidden across a remount on the same client', async () => {
    mockApi.getCompanionEbookState.mockResolvedValueOnce(AVAILABLE);
    const panel = renderPanel();
    expect(await screen.findByText('book.epub')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download EPUB' })).toBeInTheDocument();

    mockApi.getCompanionEbookState.mockRejectedValue(new ApiError(409, { error: 'Companion ebooks are disabled' }));
    await triggerRefetch(panel.client);

    await waitFor(() => expect(heading()).toBeNull());
    expectSilentAbsence(panel.container);

    // The shared client retains cache; staleTime zero forces the remount to re-request.
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

  it('matches the AudioInfo shell exactly: heading classes, card classes, a first row containing the badge, and text-sm on every row', async () => {
    // DRM exercises the badge row; available intentionally has no badge.
    mockApi.getCompanionEbookState.mockResolvedValue(DRM);
    const { container } = renderPanel();
    await screen.findByText('DRM-protected');

    // Exact equality catches partial class copies; header margin belongs on the flex wrapper.
    expect(container.querySelector('h2')?.getAttribute('class'))
      .toBe('text-sm font-semibold uppercase tracking-wider text-muted-foreground');
    expect(container.querySelector('h2')?.parentElement?.getAttribute('class'))
      .toBe('flex items-center justify-between mb-3');
    expect(card(container).getAttribute('class')).toBe('glass-card rounded-2xl p-4 space-y-2');

    const badge = screen.getByTestId('badge');
    const firstChild = card(container).children[0]!;
    expect(firstChild).not.toBe(badge);
    expect(firstChild.contains(badge)).toBe(true);

    const children = Array.from(card(container).children);
    expect(children.length).toBeGreaterThan(1);
    for (const child of children) {
      expect(child.getAttribute('class') ?? '').toContain('text-sm');
    }
  });
});

describe('CompanionEbookSection — per-state copy', () => {
  // Available is the sole state with no badge; its file details and download are sufficient.
  it('available: NO pill — the filename leads, then the size, download in the header', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(AVAILABLE);
    const { container } = renderPanel();

    expect(await screen.findByText('book.epub')).toBeInTheDocument();
    expect(screen.queryByText('Available')).toBeNull();
    expect(screen.queryByTestId('badge')).toBeNull();
    expect(card(container).children[0]?.textContent).toBe('book.epub');
    expect(card(container).children[1]?.textContent).toBe(formatBytes(SIZE));
    expect(screen.getByRole('link', { name: 'Download EPUB' })).toBeInTheDocument();
  });

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
    // Mismatched counts distinguish rendered candidates from the separately reported total.
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
    // DRM blocks Kindle conversion, not owner download (#2038).
    expect(DRM_BODY).toBe(
      "Its chapters are encrypted. Narratorr won't remove DRM, so this can't be sent to Kindle.",
    );
  });

  // AC13 pins the whole clause table; non-empty and unique assertions would pass swapped clauses.
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

  // Prototype names catch inherited-property lookups against the unconstrained wire value.
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

  // Exclude hrefs: `/companion-epub` is valid API vocabulary, not visible copy.
  for (const [label, state] of ALL_STATES) {
    it(`${label} renders no em-dash and never the word "companion"`, async () => {
      mockApi.getCompanionEbookState.mockResolvedValue(state);
      // Give available its #2022 count so the mechanical copy checks cover that rendered string.
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

describe('CompanionEbookSection — nullable wire fields', () => {
  it('available with a null size renders no detail row at all, and never "0 B"', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(
      makeState({ status: 'available', filename: 'book.epub', sizeBytes: null }),
    );
    const { container } = renderPanel();
    await screen.findByText('book.epub');

    expect(container.textContent).not.toContain('0 B');
    expect(card(container).children).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Download EPUB' })).toBeInTheDocument();
  });

  it('drm_protected with a null size renders no size row, and the DRM sentence still renders', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(
      makeState({ status: 'drm_protected', filename: 'locked.epub', sizeBytes: null }),
    );
    const { container } = renderPanel();
    await screen.findByText('DRM-protected');

    expect(container.textContent).not.toContain('0 B');
    expect(card(container).children).toHaveLength(3);
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
    expect(card(container).children).toHaveLength(2);
    for (const child of Array.from(card(container).children)) {
      expect(child.textContent).not.toBe('');
    }
  });

  // Paired with the null cases, zero forces `sizeBytes !== null` instead of a truthiness test.
  it('available with a zero size renders exactly "0 B"', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(
      makeState({ status: 'available', filename: 'empty.epub', sizeBytes: 0 }),
    );
    const { container } = renderPanel();
    await screen.findByText('empty.epub');

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

const NON_AVAILABLE_STATES = ALL_STATES.filter(([, state]) => state.status !== 'available');

describe('CompanionEbookSection — the metadata read is gated on `available`', () => {
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
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it(`${label} renders no chapter count`, async () => {
      mockApi.getCompanionEbookState.mockResolvedValue(state);
      const { container } = renderPanel();
      await screen.findByRole('heading', { name: 'Ebook' });

      // Match count syntax because DRM copy legitimately contains “chapters”.
      expect(container.textContent ?? '').not.toMatch(/\d+\s+chapters?\b/i);
      expect(attributeText(container)).not.toMatch(/\d+\s+chapters?\b/i);
    });
  }

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

  /** A disabled observer retains warm data; it must not drive count or recovery for DRM state. */
  it('reads nothing and recovers nothing from a cached response while the panel renders drm_protected', async () => {
    const client = makeClient();
    client.setQueryData(META_KEY('locked.epub'), metadataFor('other.epub', 3));
    mockApi.getCompanionEbookState.mockResolvedValue(DRM);

    const { container } = renderPanel(BOOK_ID, client);
    await screen.findByText('DRM-protected');
    await flush();

    expect(mockApi.getCompanionEbookMetadata).not.toHaveBeenCalled();
    expect(mockApi.getCompanionEbookState).toHaveBeenCalledTimes(1);
    expect(container.textContent ?? '').not.toMatch(/\d+\s+chapters?\b/i);
  });
});

const A_STATE = makeState({ status: 'available', filename: 'A.epub', sizeBytes: SIZE });
const B_STATE = makeState({ status: 'available', filename: 'B.epub', sizeBytes: SIZE2 });

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

  // Null size catches templates that leave a leading separator.
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
    // A null TOC is unreadable, never zero chapters.
    expect(container.textContent).not.toContain('0 chapters');
    expect(container.textContent ?? '').not.toMatch(/\d+\s+chapters?\b/i);
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

    expect(card(container).children).toHaveLength(1);
  });

  it('renders "0 B · 5 chapters" for a zero-byte file with a five-entry toc', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(
      makeState({ status: 'available', filename: 'empty.epub', sizeBytes: 0 }),
    );
    mockApi.getCompanionEbookMetadata.mockResolvedValue(metadataFor('empty.epub', 5));

    const { container } = renderPanel();

    await screen.findByText('0 B · 5 chapters');
    expect(detailRow(container)).toBe('0 B · 5 chapters');
  });

  it('renders no count when the metadata response names a different file', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(AVAILABLE);
    mockApi.getCompanionEbookMetadata.mockResolvedValue(metadataFor('other.epub', 3));

    const { container } = renderPanel();
    await screen.findByText('book.epub');
    await flush();

    // Exact detail text also catches a count moved elsewhere in the card.
    expect(detailRow(container)).toBe(formatBytes(SIZE));
    expect(container.textContent ?? '').not.toMatch(/\d+\s+chapters?\b/i);
    expect(screen.getByText('book.epub')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download EPUB' })).toBeInTheDocument();
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  /**
   * Models state refetching before a fire-and-forget reconcile while metadata reads after it.
   * Indexed mocks avoid racing recovery setup; holding call three preserves the mismatched frame.
   */
  it('recovers from a mismatch by revalidating /state, and converges in one round trip', async () => {
    const held = makeDeferred<CompanionEbookState>();
    mockApi.getCompanionEbookState
      .mockResolvedValueOnce(A_STATE)
      .mockResolvedValueOnce(A_STATE)
      .mockReturnValue(held.promise);
    mockApi.getCompanionEbookMetadata
      .mockResolvedValueOnce(metadataFor('A.epub', 3))
      .mockResolvedValue(metadataFor('B.epub', 7));

    const { container, client } = renderPanel();
    await screen.findByText(`${formatBytes(SIZE)} · 3 chapters`);

    // Exactly match `invalidateBookQueries()`; no pollUntil is armed and re-check is never clicked.
    await act(async () => {
      void client.invalidateQueries({ queryKey: queryKeys.book(BOOK_ID) });
      await Promise.resolve();
    });

    await waitFor(() => expect(detailRow(container)).toBe(formatBytes(SIZE)));
    expect(container.textContent ?? '').not.toMatch(/\d+\s+chapters?\b/i);
    await waitFor(() => expect(mockApi.getCompanionEbookState.mock.calls.length).toBe(3));

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

    // StrictMode may repeat recovery setup, so only the converged result is contractual.
    await screen.findByText(`${formatBytes(SIZE2)} · 7 chapters`);
  });

  /** Sample a settled call count rather than a literal; StrictMode may repeat setup. */
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
   * A/B → A/C → A/B must recover again. Observe the side effect; absent count alone would not
   * detect a handled-pair registry suppressing the final transition.
   */
  it('re-fires when the same mismatched pair returns non-consecutively', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(A_STATE);
    mockApi.getCompanionEbookMetadata
      .mockResolvedValueOnce(metadataFor('B.epub', 7))
      .mockResolvedValueOnce(metadataFor('C.epub', 5))
      .mockResolvedValue(metadataFor('B.epub', 7));

    const { client } = renderPanel();
    await screen.findByText('A.epub');
    await waitFor(() => expect(mockApi.getCompanionEbookState.mock.calls.length).toBe(2));

    const refetchMetadata = () =>
      act(async () => {
        void client.invalidateQueries({ queryKey: META_KEY('A.epub'), exact: true });
        await Promise.resolve();
      });

    await refetchMetadata();
    await waitFor(() => expect(mockApi.getCompanionEbookState.mock.calls.length).toBe(3));
    await flush();
    const afterAC = mockApi.getCompanionEbookState.mock.calls.length;

    await refetchMetadata();

    await waitFor(() => expect(mockApi.getCompanionEbookState.mock.calls.length).toBe(afterAC + 1));
    await flush();
    expect(mockApi.getCompanionEbookState.mock.calls.length).toBe(afterAC + 1);
  });

  /**
   * Unchanged call count proves a returning filename reused its fresh retained entry. An explicit
   * refetch is required for phase two because `setQueryData` starts the 60s freshness window.
   */
  it('serves a retained entry for a returning filename, and keeps the count when its refetch fails', async () => {
    const client = makeClient();
    client.setQueryData(META_KEY('B.epub'), metadataFor('B.epub', 7));
    mockApi.getCompanionEbookState.mockResolvedValueOnce(A_STATE).mockResolvedValue(B_STATE);
    mockApi.getCompanionEbookMetadata.mockResolvedValue(metadataFor('A.epub', 3));

    renderPanel(BOOK_ID, client);
    await screen.findByText(`${formatBytes(SIZE)} · 3 chapters`);
    const afterMount = mockApi.getCompanionEbookMetadata.mock.calls.length;

    await act(async () => {
      void client.invalidateQueries({ queryKey: queryKeys.companionEbook(BOOK_ID), exact: true });
      await Promise.resolve();
    });
    await screen.findByText(`${formatBytes(SIZE2)} · 7 chapters`);
    expect(mockApi.getCompanionEbookMetadata.mock.calls.length).toBe(afterMount);

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
      expect(mockApi.getCompanionEbookState).toHaveBeenCalledTimes(1);
    });
  }

  /** Wait for terminal failure; pending state already retains the count and would make this vacuous. */
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
    // Four attempts prove the three-retry ladder reached exhaustion.
    expect(mockApi.getCompanionEbookMetadata).toHaveBeenCalledTimes(4);

    expect(detailRow(container)).toBe(`${formatBytes(SIZE)} · 3 chapters`);
    expect(screen.getByText('book.epub')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download EPUB' })).toBeInTheDocument();
    expect(mockToast.error).not.toHaveBeenCalled();
    expect(mockApi.getCompanionEbookState.mock.calls.length).toBe(stateCalls);
  });

  // The client has no retry override, so this proves the shared 409 predicate.
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

describe('CompanionEbookSection — download', () => {
  it('renders a real anchor carrying the helper URL and the download attribute', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(AVAILABLE);
    renderPanel();

    const link = await screen.findByRole('link', { name: 'Download EPUB' });
    expect(link).toHaveAttribute('href', api.getCompanionEbookDownloadUrl(BOOK_ID));
    expect(link).toHaveAttribute('download');
  });

  // DRM is owner-readable; none, ambiguous, and invalid have no servable file (#2038).
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

  /** Assert both the live DRM anchor and removal of its obsolete disabled button (#2038). */
  it('drm_protected renders the same real download link as available, and no disabled button', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(DRM);
    renderPanel();
    await screen.findByText('DRM-protected');

    const link = screen.getByRole('link', { name: 'Download EPUB' });
    // The helper carries URL_BASE for sub-path deployments.
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

  // Pin UI and cache while pending; settled assertions would miss a rolled-back optimistic write.
  it('writes nothing to the UI or the cache while the selection is in flight', async () => {
    const held = makeDeferred<CompanionEbookState>();
    mockApi.putCompanionEbookSelection.mockReturnValue(held.promise);
    const client = makeClient();
    await renderPicker(TWO, client);
    const before = client.getQueryData(queryKeys.companionEbook(BOOK_ID));

    await userEvent.click(screen.getByRole('radio', { name: 'B.epub' }));
    await userEvent.click(screen.getByRole('button', { name: AMBIGUOUS_SUBMIT }));
    await waitFor(() => expect(mockApi.putCompanionEbookSelection).toHaveBeenCalled());

    expect(screen.getByText(AMBIGUOUS_QUESTION)).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByRole('radio', { name: 'B.epub' })).toBeChecked();
    expect(screen.getByText('2 found')).toBeInTheDocument();
    expect(screen.queryByText('book.epub')).toBeNull();
    expect(screen.queryByRole('link', { name: /download/i })).toBeNull();

    expect(client.getQueryData(queryKeys.companionEbook(BOOK_ID))).toEqual(ambiguous(TWO));
    expect(client.getQueryData(queryKeys.companionEbook(BOOK_ID))).toEqual(before);

    await act(async () => { held.resolve(AVAILABLE); await held.promise; });
    expect(await screen.findByText('book.epub')).toBeInTheDocument();
  });

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

  // A shared basename exposes pick leakage that disjoint fixtures would hide.
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

  // AC26/AC28: the setQueryData handoff replaces the stale picker when confirmation refetch fails.
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

  // Assert cancellation order; settled state alone cannot expose a pre-write GET landing before
  // onSettled invalidation.
  it('cancels an in-flight /state GET before installing the post-write body, and a late pre-write response does not win', async () => {
    const inFlight = makeDeferred<CompanionEbookState>();
    const client = makeClient();
    const cancelSpy = vi.spyOn(client, 'cancelQueries');
    const setDataSpy = vi.spyOn(client, 'setQueryData');
    mockApi.getCompanionEbookState
      .mockResolvedValueOnce(ambiguous(TWO))
      .mockReturnValueOnce(inFlight.promise)
      .mockResolvedValue(AVAILABLE);
    renderPanel(BOOK_ID, client);
    await screen.findByRole('radio', { name: 'A.epub' });

    await userEvent.click(screen.getByRole('radio', { name: 'A.epub' }));
    await triggerRefetch(client);
    cancelSpy.mockClear();
    setDataSpy.mockClear();

    mockApi.putCompanionEbookSelection.mockResolvedValue(AVAILABLE);
    await userEvent.click(screen.getByRole('button', { name: AMBIGUOUS_SUBMIT }));
    await waitFor(() =>
      expect(setDataSpy).toHaveBeenCalledWith(queryKeys.companionEbook(BOOK_ID), AVAILABLE));

    expect(cancelSpy).toHaveBeenCalledWith({ queryKey: queryKeys.companionEbook(BOOK_ID) });
    expect(cancelSpy.mock.invocationCallOrder[0]!)
      .toBeLessThan(setDataSpy.mock.invocationCallOrder[0]!);

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

  // Real server sentences expose passthrough; unmapped 500 exercises the default ApiError arm.
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
      expect(screen.getByText(AMBIGUOUS_QUESTION)).toBeInTheDocument();
    });
  }
});

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
          .mockResolvedValueOnce(ambiguous(TWO))
          .mockResolvedValue(NONE);
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

        await waitFor(() =>
          expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['books', 1, 'companion-epub'] }));
        if (resolves) {
          expect(client.getQueryData(queryKeys.companionEbook(1))).toEqual(AVAILABLE);
          expect(client.getQueryData(queryKeys.companionEbook(2))).not.toEqual(AVAILABLE);
        }
      });
    }
  }

  // React runs layout cleanups before the next layout setups; passive cleanup reverses this order.
  it('advances the selection generation before the next book is interactive — layout-seam ordering', async () => {
    const client = makeClient();
    mockApi.getCompanionEbookState.mockResolvedValue(ambiguous(TWO));
    const panel = renderPanel(1, client, () => { orderMarks.push('B-interactive'); });
    await screen.findByRole('radio', { name: 'B.epub' });

    orderMarks.length = 0;
    panel.armForNext();
    panel.rerenderBook(2);

    expect(orderMarks).toEqual(['A-teardown', 'B-interactive']);
  });
});

/**
 * Owner-controlled basenames must remain React text in both ambiguous and invalid views.
 * This protects future highlighting or copy refactors from introducing markup interpretation.
 */
describe('CompanionEbookSection — a hostile filename renders as text', () => {
  const HOSTILE = '<img src=x onerror=alert(1)>.epub';

  function expectRenderedAsText(container: HTMLElement): void {
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText(HOSTILE)).toBeInTheDocument();
    expect(attributeText(container)).toContain(HOSTILE);
  }

  it('escapes it in the ambiguous picker', async () => {
    mockApi.getCompanionEbookState.mockResolvedValue(
      ambiguous(candidateList(HOSTILE, 'ordinary.epub')),
    );
    const { container } = renderPanel();

    expect(await screen.findByText(AMBIGUOUS_QUESTION)).toBeInTheDocument();
    expectRenderedAsText(container);
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

describe('companion-ebook query key', () => {
  it('is a prefix-child of queryKeys.book(id), so invalidating the book cascades to it', async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.companionEbook(BOOK_ID), AVAILABLE);

    await client.invalidateQueries({ queryKey: queryKeys.book(BOOK_ID) });

    const entry = client.getQueryCache().find({ queryKey: queryKeys.companionEbook(BOOK_ID) });
    expect(entry?.state.isInvalidated).toBe(true);
  });

  // Both book-wide and ebook refresh invalidations must cascade to metadata.
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

  /** Exact recovery avoids refetching metadata under the stale filename. */
  it('an exact invalidation of the state key leaves the metadata entry untouched', async () => {
    const client = new QueryClient();
    client.setQueryData(META_KEY('book.epub'), metadataFor('book.epub', 3));

    await client.invalidateQueries({ queryKey: queryKeys.companionEbook(BOOK_ID), exact: true });

    expect(client.getQueryCache().find({ queryKey: META_KEY('book.epub') })?.state.isInvalidated)
      .toBe(false);
  });
});

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
    // A 202 proves queuing only; the increased state-call count proves observation began.
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
    // Polling is intentionally not fake-timer tested: full fakes deadlock TanStack and partial
    // fakes have caused suite flakes (#2033). The initial invalidation is the stable observable.
  });

  it('an instantly-settled POST still shows the spinner for the minimum window', async () => {
    // user.click resolves after the instant mutation, so remaining disabled state proves the latch.
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
    // Failure keeps the same minimum visible spin as success.
    await waitFor(() => expect(button).toBeEnabled(), { timeout: 2_000 });
    expect(mockApi.getCompanionEbookState.mock.calls.length).toBe(1);
  });
});
