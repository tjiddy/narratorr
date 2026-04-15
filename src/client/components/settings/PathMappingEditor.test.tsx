import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { PathMappingEditor } from './PathMappingEditor';

describe('PathMappingEditor', () => {
  it('renders empty state when no mappings', () => {
    renderWithProviders(<PathMappingEditor mappings={[]} onChange={vi.fn()} />);
    expect(screen.getByText(/no path mappings configured/i)).toBeInTheDocument();
  });

  it('renders existing mappings', () => {
    const mappings = [{ remotePath: '/remote/a', localPath: '/local/a' }];
    renderWithProviders(<PathMappingEditor mappings={mappings} onChange={vi.fn()} />);
    expect(screen.getByText('/remote/a')).toBeInTheDocument();
    expect(screen.getByText('/local/a')).toBeInTheDocument();
  });

  it('adds a mapping via the form', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<PathMappingEditor mappings={[]} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: /add mapping/i }));
    await user.type(screen.getByLabelText(/remote path/i), '/remote/downloads');
    await user.type(screen.getByLabelText(/local path/i), '/local/downloads');
    await user.click(screen.getByRole('button', { name: /^add$/i }));

    expect(onChange).toHaveBeenCalledWith([
      { remotePath: '/remote/downloads', localPath: '/local/downloads' },
    ]);
  });

  it('removes a mapping when clicking Remove', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const mappings = [
      { remotePath: '/remote/a', localPath: '/local/a' },
      { remotePath: '/remote/b', localPath: '/local/b' },
    ];
    renderWithProviders(<PathMappingEditor mappings={mappings} onChange={onChange} />);

    const removeButtons = screen.getAllByRole('button', { name: /remove/i });
    await user.click(removeButtons[0]);

    expect(onChange).toHaveBeenCalledWith([
      { remotePath: '/remote/b', localPath: '/local/b' },
    ]);
  });

  it('disables Add button when fields are empty', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PathMappingEditor mappings={[]} onChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /add mapping/i }));
    const addButton = screen.getByRole('button', { name: /^add$/i });
    expect(addButton).toBeDisabled();
  });

  describe('Wave 2D touch affordance (#583)', () => {
    it('delete button includes no-hover:opacity-100 for touch devices', () => {
      const mappings = [{ remotePath: '/remote/a', localPath: '/local/a' }];
      renderWithProviders(<PathMappingEditor mappings={mappings} onChange={vi.fn()} />);
      const removeButton = screen.getByRole('button', { name: /remove/i });
      expect(removeButton.className).toContain('no-hover:opacity-100');
    });

    it('delete button preserves desktop hover classes (opacity-0, group-hover:opacity-100)', () => {
      const mappings = [{ remotePath: '/remote/a', localPath: '/local/a' }];
      renderWithProviders(<PathMappingEditor mappings={mappings} onChange={vi.fn()} />);
      const removeButton = screen.getByRole('button', { name: /remove/i });
      expect(removeButton.className).toContain('opacity-0');
      expect(removeButton.className).toContain('group-hover:opacity-100');
    });
  });

  it('disables Add button when only whitespace entered', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PathMappingEditor mappings={[]} onChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /add mapping/i }));
    await user.type(screen.getByLabelText(/remote path/i), '   ');
    await user.type(screen.getByLabelText(/local path/i), '   ');
    const addButton = screen.getByRole('button', { name: /^add$/i });
    expect(addButton).toBeDisabled();
  });
});
