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
    await user.click(screen.getByRole('button', { name: 'Import' }));

    expect(props.onSubmit).toHaveBeenCalledWith({ path: '/', mode: 'move' });
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
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: 'open picker' }));
    await screen.findByRole('dialog');

    expect(screen.getByRole('radio', { name: 'Copy' })).toHaveAttribute('aria-checked', 'true');
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
