import { describe, it, expect } from 'vitest';
import { screen, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm } from 'react-hook-form';
import { BlackholeFields } from './BlackholeFields';
import type { CreateDownloadClientFormData } from '../../../shared/schemas.js';

function FieldWrapper({ isEdit }: { isEdit?: boolean }) {
  const { register, formState: { errors } } = useForm<CreateDownloadClientFormData>({
    defaultValues: { name: 'Test', type: 'blackhole', enabled: true, priority: 50, settings: { watchDir: '', protocol: 'torrent' } },
  });
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
});
