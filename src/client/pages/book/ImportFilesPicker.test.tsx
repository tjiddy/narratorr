import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { ImportFilesPicker } from './ImportFilesPicker';

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual('@/lib/api');
  return { ...actual, api: { browseDirectory: vi.fn() } };
});

import { api } from '@/lib/api';

const mockBrowse = api.browseDirectory as ReturnType<typeof vi.fn>;

function renderPicker(overrides: Partial<Parameters<typeof ImportFilesPicker>[0]> = {}) {
  const props = {
    isOpen: true,
    isPending: false,
    onSubmit: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  return { ...renderWithProviders(<ImportFilesPicker {...props} />), props };
}

describe('ImportFilesPicker (#2435 AC19)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBrowse.mockResolvedValue({ dirs: [], parent: null, files: ['book.m4b'] });
  });

  it('renders nothing while closed', () => {
    renderPicker({ isOpen: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('defaults to Copy on first open', async () => {
    renderPicker();
    await screen.findByRole('dialog');

    expect(screen.getByRole('radio', { name: 'Copy' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Move' })).toHaveAttribute('aria-checked', 'false');
  });

  it('submits the mode the user selected', async () => {
    const user = userEvent.setup();
    const { props } = renderPicker();
    await screen.findByRole('dialog');

    await user.click(screen.getByRole('radio', { name: 'Move' }));
    // #2478: Import is gated on an explicit choice, so the mode travels with a real selection.
    await user.click(screen.getByRole('button', { name: 'Use this folder' }));
    await user.click(screen.getByRole('button', { name: 'Import' }));

    expect(props.onSubmit).toHaveBeenCalledWith({ path: '/', mode: 'move' });
  });

  // ── #2478: nothing is importable until the user says what they mean ───────────────────────────

  it('keeps Import disabled — and submits nothing — while no file or folder is chosen', async () => {
    const user = userEvent.setup();
    const { props } = renderPicker();
    await screen.findByRole('dialog');

    const importButton = screen.getByRole('button', { name: 'Import' });
    expect(importButton).toBeDisabled();
    await user.click(importButton);

    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it('enables Import on a file click and submits that file', async () => {
    const user = userEvent.setup();
    const { props } = renderPicker();
    await user.click(await screen.findByText('book.m4b'));
    expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Import' }));

    expect(props.onSubmit).toHaveBeenCalledWith({ path: '/book.m4b', mode: 'copy' });
  });

  // The deliberate escape hatch: a normal download folder stays importable in one gesture.
  it('enables Import on the folder affordance and submits the folder', async () => {
    const user = userEvent.setup();
    const { props } = renderPicker();
    await screen.findByRole('dialog');

    await user.click(screen.getByRole('button', { name: 'Use this folder' }));
    expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Import' }));

    expect(props.onSubmit).toHaveBeenCalledWith({ path: '/', mode: 'copy' });
  });

  // Two independent disable inputs combining; the pending one wins.
  it('stays disabled with an explicit selection while the import is pending', async () => {
    const user = userEvent.setup();
    const { props } = renderPicker({ isPending: true });

    await user.click(await screen.findByText('book.m4b'));

    const importButton = screen.getByRole('button', { name: 'Importing...' });
    expect(importButton).toBeDisabled();
    await user.click(importButton);
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  /**
   * F1: the mode must not survive a close, and the component owns that guarantee rather than
   * relying on every call site to conditionally render it — BookDetails renders this
   * unconditionally, so `return null` alone would keep the component mounted and its state alive.
   */
  it('resets the mode to Copy when reopened after a Move selection', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    // Mirrors BookDetails: the picker is mounted unconditionally and toggled by a prop, which is
    // the shape that keeps a `return null`-only component alive across sessions.
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>open picker</button>
          <ImportFilesPicker
            isOpen={open}
            isPending={false}
            onSubmit={onSubmit}
            onClose={() => setOpen(false)}
          />
        </>
      );
    }
    renderWithProviders(<Harness />);

    await user.click(screen.getByRole('button', { name: 'open picker' }));
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('radio', { name: 'Move' }));
    await user.click(screen.getByRole('button', { name: 'Use this folder' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: 'open picker' }));
    await screen.findByRole('dialog');

    expect(screen.getByRole('radio', { name: 'Copy' })).toHaveAttribute('aria-checked', 'true');
    // #2478: the folder choice resets with the mode, so Import is gated again on reopen.
    expect(screen.getByRole('button', { name: 'Use this folder' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Use this folder' }));
    // The SUBMITTED payload, not `aria-checked`: the latter can read fresh while the value sent is stale.
    await user.click(screen.getByRole('button', { name: 'Import' }));
    expect(onSubmit).toHaveBeenCalledWith({ path: '/', mode: 'copy' });
  });

  it('disables the mode controls and the submit button while the import is pending', async () => {
    renderPicker({ isPending: true });
    await screen.findByRole('dialog');

    expect(screen.getByRole('radio', { name: 'Copy' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Move' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Importing...' })).toBeDisabled();
  });
});
