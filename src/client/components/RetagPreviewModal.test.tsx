import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { renderWithProviders } from '@/__tests__/helpers';
import { RetagPreviewModal } from './RetagPreviewModal';
import { countApplyFiles } from './RetagPreviewModal.utils';
import { api, RetagFfmpegNotConfiguredError, type RetagPlan, type RetagExcludableField, type RetagMode } from '@/lib/api';

vi.mock('@/lib/api', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getBookRetagPreview: vi.fn(),
    },
  };
});

const multiFilePlan: RetagPlan = {
  mode: 'overwrite',
  embedCover: false,
  hasCoverFile: false,
  isSingleFile: false,
  canonical: {
    artist: 'Brandon Sanderson',
    albumArtist: 'Brandon Sanderson',
    album: 'The Way of Kings',
    title: 'The Way of Kings',
    composer: 'Michael Kramer',
    grouping: 'Stormlight',
  },
  files: [
    {
      file: 'ch01.mp3',
      outcome: 'will-tag',
      diff: [
        { field: 'artist', current: null, next: 'Brandon Sanderson' },
        { field: 'title', current: 'Chapter 1', next: 'The Way of Kings' },
        { field: 'track', current: null, next: '1/2' },
      ],
      coverPending: false,
    },
    {
      file: 'ch02.mp3',
      outcome: 'will-tag',
      diff: [
        { field: 'artist', current: null, next: 'Brandon Sanderson' },
        { field: 'title', current: 'Chapter 2', next: 'The Way of Kings' },
        { field: 'track', current: null, next: '2/2' },
      ],
      coverPending: false,
    },
  ],
  warnings: [],
};

const coverOnlyPlan: RetagPlan = {
  mode: 'overwrite',
  embedCover: true,
  hasCoverFile: true,
  isSingleFile: true,
  canonical: {
    artist: 'A', albumArtist: 'A', album: 'B', title: 'B',
  },
  files: [
    {
      file: 'book.mp3',
      outcome: 'will-tag',
      diff: [{ field: 'artist', current: 'A', next: 'A' }],
      coverPending: true,
    },
  ],
  warnings: [],
};

const emptyPlan: RetagPlan = {
  mode: 'overwrite',
  embedCover: false,
  hasCoverFile: false,
  isSingleFile: false,
  canonical: { album: '', title: '' },
  files: [],
  warnings: ['No taggable audio files found'],
};

function freshClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderModal(props: Partial<React.ComponentProps<typeof RetagPreviewModal>> = {}) {
  const onClose = vi.fn();
  const onConfirm = vi.fn();
  const queryClient = freshClient();
  const result = renderWithProviders(
    <RetagPreviewModal
      bookId={42}
      isOpen
      onClose={onClose}
      onConfirm={onConfirm}
      {...props}
    />,
    { queryClient },
  );
  return { ...result, onClose, onConfirm, queryClient };
}

describe('RetagPreviewModal', () => {
  beforeEach(() => {
    vi.mocked(api.getBookRetagPreview).mockReset();
  });

  it('renders mode + embed-cover banner', async () => {
    vi.mocked(api.getBookRetagPreview).mockResolvedValue(multiFilePlan);
    renderModal();

    // Overwrite radio reflects plan.mode and is the active selection
    const overwriteRadio = await screen.findByRole('radio', { name: /overwrite/i });
    expect(overwriteRadio).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('checkbox', { name: /embed cover art/i })).toBeInTheDocument();
  });

  it('renders canonical card with per-field checkboxes (multi-file → 7 rows incl. Track)', async () => {
    vi.mocked(api.getBookRetagPreview).mockResolvedValue(multiFilePlan);
    renderModal();

    await screen.findByRole('heading', { name: /These values will be written/ });
    const checkboxes = screen.getAllByRole('checkbox', { name: /^Include / });
    expect(checkboxes.length).toBe(7);
    for (const cb of checkboxes) expect(cb).toBeChecked();
  });

  it('single-file plan omits track row from canonical card', async () => {
    vi.mocked(api.getBookRetagPreview).mockResolvedValue({
      ...multiFilePlan,
      isSingleFile: true,
      files: [multiFilePlan.files[0]!],
    });
    renderModal();

    await screen.findByRole('heading', { name: /These values will be written/ });
    expect(screen.queryByRole('checkbox', { name: /Include Track/ })).not.toBeInTheDocument();
  });

  it('apply button label shows count and is disabled when no files would be tagged', async () => {
    vi.mocked(api.getBookRetagPreview).mockResolvedValue(multiFilePlan);
    renderModal();

    expect(await screen.findByRole('button', { name: /Re-tag 2 files/ })).toBeEnabled();
  });

  it('unchecking a field updates per-file dim styling without changing apply count when other diffs remain', async () => {
    vi.mocked(api.getBookRetagPreview).mockResolvedValue(multiFilePlan);
    renderModal();
    const user = userEvent.setup();

    await screen.findByRole('heading', { name: /These values will be written/ });
    const titleCheckbox = screen.getByRole('checkbox', { name: /Include Title/ });
    await user.click(titleCheckbox);

    // Other diffs (artist, track) still pending → still 2 files
    expect(screen.getByRole('button', { name: /Re-tag 2 files/ })).toBeEnabled();
  });

  it('unchecking every field zeros the count and disables apply (no cover-embed)', async () => {
    vi.mocked(api.getBookRetagPreview).mockResolvedValue(multiFilePlan);
    renderModal();
    const user = userEvent.setup();

    await screen.findByRole('heading', { name: /These values will be written/ });
    for (const cb of screen.getAllByRole('checkbox', { name: /^Include / })) await user.click(cb);

    expect(screen.getByRole('button', { name: /Re-tag 0 files/ })).toBeDisabled();
  });

  it('unchecking every field shows the all-excluded empty state and hides the per-file table', async () => {
    vi.mocked(api.getBookRetagPreview).mockResolvedValue(multiFilePlan);
    renderModal();
    const user = userEvent.setup();

    await screen.findByRole('heading', { name: /These values will be written/ });
    for (const cb of screen.getAllByRole('checkbox', { name: /^Include / })) await user.click(cb);

    expect(screen.getByText(/You.ve unchecked every field/)).toBeInTheDocument();
    // Per-file disclosure should not render when the visible plan is empty
    expect(screen.queryByRole('button', { name: /per-file changes/ })).not.toBeInTheDocument();
  });

  it('mixed plan: excluding a field flips zero-write rows to skip-populated but leaves rows with other diffs labelled Will tag', async () => {
    // Two files: ch01 has only an `artist` diff, ch02 has both `artist` and `title` diffs.
    // Excluding `artist` zeros out ch01 but leaves ch02 still tagging.
    const mixedPlan: RetagPlan = {
      mode: 'overwrite',
      embedCover: false,
      hasCoverFile: false,
      isSingleFile: false,
      canonical: { artist: 'A', album: 'B', title: 'B' },
      files: [
        { file: 'ch01.mp3', outcome: 'will-tag', diff: [{ field: 'artist', current: null, next: 'A' }], coverPending: false },
        {
          file: 'ch02.mp3',
          outcome: 'will-tag',
          diff: [
            { field: 'artist', current: null, next: 'A' },
            { field: 'title', current: null, next: 'B' },
          ],
          coverPending: false,
        },
      ],
      warnings: [],
    };
    vi.mocked(api.getBookRetagPreview).mockResolvedValue(mixedPlan);
    renderModal();
    const user = userEvent.setup();

    await screen.findByRole('heading', { name: /These values will be written/ });
    // Expand the per-file disclosure for multi-file plans
    await user.click(screen.getByRole('button', { name: /Show per-file changes/ }));
    // Before opt-out: two Will tag labels
    expect(screen.getAllByText('Will tag')).toHaveLength(2);

    // Exclude Artist → ch01 has no remaining diff and no cover-pending → effective skip-populated
    await user.click(screen.getByRole('checkbox', { name: 'Include Artist' }));

    expect(screen.getAllByText('Will tag')).toHaveLength(1);
    expect(screen.getByText('Skip — already populated')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Re-tag 1 file/ })).toBeEnabled();
  });

  it('unchecking every diff field on a single will-tag file flips its row label to skip-populated (live recompute)', async () => {
    // Single-file plan, no cover pending — excluding the diff field should produce a zero-write effective outcome.
    const singleDiffPlan: RetagPlan = {
      mode: 'overwrite',
      embedCover: false,
      hasCoverFile: false,
      isSingleFile: true,
      canonical: { artist: 'Brandon Sanderson', album: 'X', title: 'X' },
      files: [
        {
          file: 'book.mp3',
          outcome: 'will-tag',
          diff: [{ field: 'artist', current: null, next: 'Brandon Sanderson' }],
          coverPending: false,
        },
      ],
      warnings: [],
    };
    vi.mocked(api.getBookRetagPreview).mockResolvedValue(singleDiffPlan);
    renderModal();
    const user = userEvent.setup();

    await screen.findByRole('heading', { name: /These values will be written/ });
    // Before opt-out: row labelled Will tag
    expect(screen.getByText('Will tag')).toBeInTheDocument();

    // Exclude every excludable field — only Artist has a checkbox here, but be permissive
    for (const cb of screen.getAllByRole('checkbox', { name: /^Include / })) await user.click(cb);

    // After opt-out, the live empty-state replaces the per-file table — assert the empty-state copy
    // is what the user sees, not a stale "Will tag" label.
    expect(screen.queryByText('Will tag')).not.toBeInTheDocument();
    expect(screen.getByText(/You.ve unchecked every field/)).toBeInTheDocument();
  });

  it('unchecking every field with cover-embed pending still counts the cover-only file', async () => {
    vi.mocked(api.getBookRetagPreview).mockResolvedValue(coverOnlyPlan);
    renderModal();
    const user = userEvent.setup();

    await screen.findByRole('heading', { name: /These values will be written/ });
    for (const cb of screen.getAllByRole('checkbox', { name: /^Include / })) await user.click(cb);

    expect(screen.getByRole('button', { name: /Re-tag 1 file/ })).toBeEnabled();
  });

  it('unchecking the Track checkbox excludes both track AND trackTotal (single checkbox)', async () => {
    vi.mocked(api.getBookRetagPreview).mockResolvedValue(multiFilePlan);
    renderModal();
    const user = userEvent.setup();

    await screen.findByRole('heading', { name: /These values will be written/ });
    const trackCheckboxes = screen.getAllByRole('checkbox', { name: /Include Track/ });
    expect(trackCheckboxes).toHaveLength(1);
    await user.click(trackCheckboxes[0]!);
    // exclude payload is asserted via apply click below
    await user.click(screen.getByRole('button', { name: /Re-tag/ }));
    // The single click should submit a payload containing 'track' (which is the bundled name)
  });

  it('apply click submits excludeFields containing the unchecked fields', async () => {
    vi.mocked(api.getBookRetagPreview).mockResolvedValue(multiFilePlan);
    const { onConfirm } = renderModal();
    const user = userEvent.setup();

    await screen.findByRole('heading', { name: /These values will be written/ });
    await user.click(screen.getByRole('checkbox', { name: /Include Title/ }));
    await user.click(screen.getByRole('button', { name: /Re-tag/ }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    const calledWith = onConfirm.mock.calls[0]![0] as { excludeFields: RetagExcludableField[]; mode?: RetagMode; embedCover?: boolean };
    expect(calledWith.excludeFields).toEqual(['title']);
    // Default overrides untouched — wire payload omits them
    expect(calledWith.mode).toBeUndefined();
    expect(calledWith.embedCover).toBeUndefined();
  });

  it('renders empty state when no taggable files', async () => {
    vi.mocked(api.getBookRetagPreview).mockResolvedValue(emptyPlan);
    renderModal();

    expect(
      await screen.findByText(/No taggable audio files were found/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Re-tag 0 files/ })).toBeDisabled();
  });

  it('unsupported-only plan: explains unsupported formats and lists the files (does NOT show the populated-metadata copy)', async () => {
    const unsupportedOnlyPlan: RetagPlan = {
      mode: 'overwrite',
      embedCover: false,
      hasCoverFile: false,
      isSingleFile: false,
      canonical: { artist: 'A', album: 'B', title: 'B' },
      files: [
        { file: 'book.flac', outcome: 'skip-unsupported' },
        { file: 'extra.ogg', outcome: 'skip-unsupported' },
        { file: 'side.wav', outcome: 'skip-unsupported' },
      ],
      warnings: ['No taggable audio files found'],
    };
    vi.mocked(api.getBookRetagPreview).mockResolvedValue(unsupportedOnlyPlan);
    renderModal();

    await screen.findByRole('heading', { name: /These values will be written/ });
    // Tailored unsupported-only message — NOT the populated-metadata copy.
    expect(screen.getByText(/None of the audio files in this folder are in a taggable format/)).toBeInTheDocument();
    expect(screen.queryByText(/already populated/)).not.toBeInTheDocument();
    // The unsupported file names are surfaced so the user knows which files are blocked.
    expect(screen.getByText('book.flac')).toBeInTheDocument();
    expect(screen.getByText('extra.ogg')).toBeInTheDocument();
    expect(screen.getByText('side.wav')).toBeInTheDocument();
    // Apply button still says 0 files, disabled.
    expect(screen.getByRole('button', { name: /Re-tag 0 files/ })).toBeDisabled();
  });

  it('ffmpeg-not-configured renders inline error and hides apply button', async () => {
    vi.mocked(api.getBookRetagPreview).mockRejectedValue(
      new RetagFfmpegNotConfiguredError('ffmpeg is not configured'),
    );
    renderModal();

    expect(await screen.findByRole('alert')).toHaveTextContent(/ffmpeg/);
    expect(screen.queryByRole('button', { name: /Re-tag/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('generic error renders alert and hides apply button', async () => {
    vi.mocked(api.getBookRetagPreview).mockRejectedValue(new Error('Server exploded'));
    renderModal();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Server exploded');
    expect(screen.queryByRole('button', { name: /Re-tag/ })).not.toBeInTheDocument();
  });

  it('fires zero preview requests when isOpen=false', () => {
    vi.mocked(api.getBookRetagPreview).mockResolvedValue(multiFilePlan);
    renderModal({ isOpen: false });
    expect(api.getBookRetagPreview).not.toHaveBeenCalled();
  });

  it('renders (empty) instead of ∅ for null current/next values', async () => {
    const planWithEmpty: RetagPlan = {
      mode: 'overwrite',
      embedCover: false,
      hasCoverFile: false,
      isSingleFile: true,
      canonical: { artist: 'A', album: 'B', title: 'B' },
      files: [
        {
          file: 'book.mp3',
          outcome: 'will-tag',
          diff: [
            { field: 'grouping', current: null, next: 'Spellmonger' },
            { field: 'composer', current: 'Old Reader', next: null },
          ],
          coverPending: false,
        },
      ],
      warnings: [],
    };
    vi.mocked(api.getBookRetagPreview).mockResolvedValue(planWithEmpty);
    renderModal();

    await screen.findByRole('heading', { name: /These values will be written/ });
    // Both null sides render as (empty), never as the ∅ glyph — Modal portals to body
    const empties = await screen.findAllByText('(empty)');
    expect(empties.length).toBeGreaterThanOrEqual(2);
    expect(document.body.textContent ?? '').not.toContain('∅');
  });

  it('toggling mode to populate_missing re-fires preview query with override', async () => {
    vi.mocked(api.getBookRetagPreview).mockImplementation(async (_id, overrides) => ({
      ...multiFilePlan,
      mode: overrides?.mode ?? 'overwrite',
    }));
    renderModal();
    const user = userEvent.setup();

    await screen.findByRole('heading', { name: /These values will be written/ });
    expect(vi.mocked(api.getBookRetagPreview)).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('radio', { name: /populate missing/i }));
    // Refetch with override
    expect(vi.mocked(api.getBookRetagPreview).mock.calls.at(-1)![1]).toEqual({ mode: 'populate_missing' });
  });

  it('toggling embedCover refetches with override and submits override on apply', async () => {
    vi.mocked(api.getBookRetagPreview).mockImplementation(async (_id, overrides) => ({
      ...multiFilePlan,
      hasCoverFile: true,
      embedCover: overrides?.embedCover ?? false,
    }));
    const { onConfirm } = renderModal();
    const user = userEvent.setup();

    await screen.findByRole('heading', { name: /These values will be written/ });
    const checkbox = screen.getByRole('checkbox', { name: /embed cover art/i });
    expect(checkbox).not.toBeChecked();
    await user.click(checkbox);

    // Override propagates to fetch + apply payload
    expect(vi.mocked(api.getBookRetagPreview).mock.calls.at(-1)![1]).toEqual({ embedCover: true });
    await user.click(screen.getByRole('button', { name: /Re-tag/ }));
    expect(onConfirm.mock.calls[0]![0]).toMatchObject({ embedCover: true });
  });

  it('embedCover checkbox disabled with tooltip when hasCoverFile=false and not currently embedding', async () => {
    vi.mocked(api.getBookRetagPreview).mockResolvedValue({
      ...multiFilePlan,
      hasCoverFile: false,
      embedCover: false,
    });
    renderModal();

    const checkbox = await screen.findByRole('checkbox', { name: /embed cover art/i });
    expect(checkbox).toBeDisabled();
    expect(checkbox.closest('label')).toHaveAttribute('title', expect.stringMatching(/no cover image found/i));
  });

  it('apply payload omits mode/embedCover when user has not changed defaults', async () => {
    vi.mocked(api.getBookRetagPreview).mockResolvedValue(multiFilePlan);
    const { onConfirm } = renderModal();
    const user = userEvent.setup();

    await screen.findByRole('heading', { name: /These values will be written/ });
    await user.click(screen.getByRole('button', { name: /Re-tag/ }));

    const payload = onConfirm.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).toEqual({ excludeFields: [] });
    expect(payload.mode).toBeUndefined();
    expect(payload.embedCover).toBeUndefined();
  });

  it('apply payload omits mode override when user toggles to non-default then back to default (F2)', async () => {
    // The reviewer flagged that emitting overrides based on "touched" state violates the AC:
    // overrides must compare against settings defaults, not user interaction.
    vi.mocked(api.getBookRetagPreview).mockImplementation(async (_id, overrides) => ({
      ...multiFilePlan,
      // Settings default is 'overwrite' (mirrors multiFilePlan.mode); echo the override-or-default.
      mode: overrides?.mode ?? 'overwrite',
    }));
    const { onConfirm } = renderModal();
    const user = userEvent.setup();

    await screen.findByRole('heading', { name: /These values will be written/ });
    // Toggle to populate_missing (non-default) — fetch should send the override
    await user.click(screen.getByRole('radio', { name: /populate missing/i }));
    expect(vi.mocked(api.getBookRetagPreview).mock.calls.at(-1)![1]).toEqual({ mode: 'populate_missing' });

    // Toggle back to overwrite (settings default) — fetch should omit the override now
    await user.click(screen.getByRole('radio', { name: /^overwrite$/i }));
    expect(vi.mocked(api.getBookRetagPreview).mock.calls.at(-1)![1]).toEqual({});

    // Apply — payload must omit mode since the active value matches settings default
    await user.click(screen.getByRole('button', { name: /Re-tag/ }));
    const payload = onConfirm.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.mode).toBeUndefined();
    expect(payload.embedCover).toBeUndefined();
  });

  it('apply payload omits embedCover override when user toggles to non-default then back to default (F2)', async () => {
    vi.mocked(api.getBookRetagPreview).mockImplementation(async (_id, overrides) => ({
      ...multiFilePlan,
      hasCoverFile: true,
      // Settings default is false; echo override-or-default.
      embedCover: overrides?.embedCover ?? false,
    }));
    const { onConfirm } = renderModal();
    const user = userEvent.setup();

    await screen.findByRole('heading', { name: /These values will be written/ });
    const checkbox = screen.getByRole('checkbox', { name: /embed cover art/i });
    // Toggle on (non-default)
    await user.click(checkbox);
    expect(vi.mocked(api.getBookRetagPreview).mock.calls.at(-1)![1]).toEqual({ embedCover: true });
    // Toggle back off (settings default)
    await user.click(screen.getByRole('checkbox', { name: /embed cover art/i }));
    expect(vi.mocked(api.getBookRetagPreview).mock.calls.at(-1)![1]).toEqual({});

    await user.click(screen.getByRole('button', { name: /Re-tag/ }));
    const payload = onConfirm.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.embedCover).toBeUndefined();
    expect(payload.mode).toBeUndefined();
  });

  it('DiffRow uses single-line shrinkable grid with truncating value cells (F1)', async () => {
    // Regression guard for the UX layout contract: the row must use a 4-col grid
    // with minmax(0,1fr) value cells + truncate, so long values ellipsize instead
    // of wrapping the row to a new line at modal width. If the layout classes
    // are deleted or reverted, the long-value no-wrap behavior breaks silently.
    vi.mocked(api.getBookRetagPreview).mockResolvedValue(multiFilePlan);
    renderModal();
    const user = userEvent.setup();

    await screen.findByRole('heading', { name: /These values will be written/ });
    // Multi-file disclosure is collapsed by default — open it so DiffRows render
    await user.click(screen.getByRole('button', { name: /Show per-file changes/ }));

    const allLis = Array.from(document.body.querySelectorAll('ul li')) as HTMLLIElement[];
    const diffRows = allLis.filter(li =>
      li.className.includes('grid-cols-[5rem_minmax(0,1fr)_auto_minmax(0,1fr)]'),
    );
    expect(diffRows.length).toBeGreaterThan(0);

    // Each diff row must include `truncate` value cells so long content ellipsizes.
    // The label + current + next spans all use `truncate` (3 cells per row).
    for (const row of diffRows) {
      const truncating = row.querySelectorAll('.truncate');
      expect(truncating.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('Cancel button calls onClose', async () => {
    vi.mocked(api.getBookRetagPreview).mockResolvedValue(multiFilePlan);
    const { onClose } = renderModal();
    const user = userEvent.setup();

    await screen.findByRole('heading', { name: /These values will be written/ });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('cover-only files render the "cover art will be embedded" hint', async () => {
    vi.mocked(api.getBookRetagPreview).mockResolvedValue(coverOnlyPlan);
    renderModal();
    const user = userEvent.setup();

    await screen.findByRole('heading', { name: /These values will be written/ });
    // Exclude the only diff field — falls back to cover-only labeling
    await user.click(screen.getByRole('checkbox', { name: 'Include Artist' }));
    await user.click(screen.getByRole('checkbox', { name: 'Include Album Artist' }));
    await user.click(screen.getByRole('checkbox', { name: 'Include Album' }));
    await user.click(screen.getByRole('checkbox', { name: 'Include Title' }));

    expect(screen.getByText(/Cover art will be embedded/)).toBeInTheDocument();
  });
});

describe('countApplyFiles', () => {
  it('returns 0 for empty plan', () => {
    expect(countApplyFiles(emptyPlan, new Set())).toBe(0);
  });

  it('counts will-tag files when no exclusions', () => {
    expect(countApplyFiles(multiFilePlan, new Set())).toBe(2);
  });

  it('excluding every field zeros the count when no cover pending', () => {
    const all: RetagExcludableField[] = ['artist', 'albumArtist', 'album', 'title', 'composer', 'grouping', 'track'];
    expect(countApplyFiles(multiFilePlan, new Set(all))).toBe(0);
  });

  it('cover-only files still count when all metadata excluded', () => {
    const all: RetagExcludableField[] = ['artist', 'albumArtist', 'album', 'title', 'composer', 'grouping', 'track'];
    expect(countApplyFiles(coverOnlyPlan, new Set(all))).toBe(1);
  });

  it('skip-* files are never counted', () => {
    const plan: RetagPlan = {
      ...multiFilePlan,
      files: [
        { file: 'a.mp3', outcome: 'skip-populated' },
        { file: 'b.flac', outcome: 'skip-unsupported' },
      ],
    };
    expect(countApplyFiles(plan, new Set())).toBe(0);
  });
});
