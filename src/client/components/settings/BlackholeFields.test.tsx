import { describe, it, expect } from 'vitest';
import { screen, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm } from 'react-hook-form';
import { BlackholeFields } from './BlackholeFields';
import type { CreateDownloadClientFormData } from '../../../shared/schemas.js';

function FieldWrapper({ isEdit, protocolError, watchDirError }: { isEdit?: boolean; protocolError?: boolean; watchDirError?: boolean }) {
  const { register, formState: { errors }, setError } = useForm<CreateDownloadClientFormData>({
    defaultValues: { name: 'Test', type: 'blackhole', enabled: true, priority: 50, settings: { watchDir: '', protocol: 'torrent' } },
  });

  // Inject protocol error via setError on mount if requested
  if (protocolError && !errors.settings?.protocol) {
    setError('settings.protocol', { type: 'validate', message: 'Invalid protocol' });
  }
  if (watchDirError && !errors.settings?.watchDir) {
    setError('settings.watchDir', { type: 'validate', message: 'Watch directory is required' });
  }

  return <BlackholeFields register={register} errors={errors} isEdit={isEdit} />;
}

describe('BlackholeFields', () => {
  it('renders watch directory and protocol fields', () => {
    render(<FieldWrapper />);

    expect(screen.getByText('Watch Directory')).toBeInTheDocument();
    expect(screen.getByText('Protocol')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('/downloads/watch')).toBeInTheDocument();
  });

  it('does NOT render host, port, or credential fields', () => {
    render(<FieldWrapper />);

    expect(screen.queryByText('Host')).not.toBeInTheDocument();
    expect(screen.queryByText('Port')).not.toBeInTheDocument();
    expect(screen.queryByText('Username')).not.toBeInTheDocument();
    expect(screen.queryByText('Password')).not.toBeInTheDocument();
    expect(screen.queryByText('Category')).not.toBeInTheDocument();
  });

  it('accepts watch directory input', async () => {
    const user = userEvent.setup();
    render(<FieldWrapper />);

    const input = screen.getByPlaceholderText('/downloads/watch');
    await user.type(input, '/mnt/data/watch');
    expect(input).toHaveValue('/mnt/data/watch');
  });

  it('renders protocol selector with torrent and usenet options', () => {
    render(<FieldWrapper />);

    const select = screen.getByLabelText('Protocol') as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    expect(select.options).toHaveLength(2);
    expect(select.options[0].value).toBe('torrent');
    expect(select.options[1].value).toBe('usenet');
  });

  it('allows changing protocol selection', async () => {
    const user = userEvent.setup();
    render(<FieldWrapper />);

    const select = screen.getByLabelText('Protocol') as HTMLSelectElement;
    await user.selectOptions(select, 'usenet');
    expect(select.value).toBe('usenet');
  });

  it('shows enabled and priority fields in edit mode', () => {
    render(<FieldWrapper isEdit />);

    expect(screen.getByText('Enabled')).toBeInTheDocument();
    expect(screen.getByText('Priority')).toBeInTheDocument();
  });

  it('hides enabled and priority fields in create mode', () => {
    render(<FieldWrapper />);

    expect(screen.queryByText('Enabled')).not.toBeInTheDocument();
    expect(screen.queryByText('Priority')).not.toBeInTheDocument();
  });

  it('watch directory input uses shared formStyles non-error border', () => {
    render(<FieldWrapper />);
    const input = screen.getByPlaceholderText('/downloads/watch');
    expect(input).toHaveClass('border-border');
    expect(input).not.toHaveClass('border-destructive');
  });

  it('watch directory input shows error border when validation fails', () => {
    render(<FieldWrapper watchDirError />);
    const input = screen.getByPlaceholderText('/downloads/watch');
    expect(input).toHaveClass('border-destructive');
    expect(input).not.toHaveClass('border-border');
    expect(screen.getByText('Watch directory is required')).toBeInTheDocument();
  });

  it('protocol select uses shared SelectWithChevron contract', () => {
    render(<FieldWrapper />);
    const select = screen.getByLabelText('Protocol');
    expect(select).toHaveClass('appearance-none');
    expect(select.parentElement!.querySelector('svg')).toBeInTheDocument();
    expect(select).toHaveClass('border-border');
    expect(select).not.toHaveClass('border-destructive');
  });

  it('priority input has step=1 in edit mode', () => {
    render(<FieldWrapper isEdit />);
    const input = screen.getByLabelText('Priority');
    expect(input).toHaveAttribute('step', '1');
  });

  it('protocol select shows error styling when validation fails', () => {
    render(<FieldWrapper protocolError />);
    const select = screen.getByLabelText('Protocol');
    expect(select).toHaveClass('border-destructive');
    expect(select).not.toHaveClass('border-border');
    expect(screen.getByText('Invalid protocol')).toBeInTheDocument();
  });
});
