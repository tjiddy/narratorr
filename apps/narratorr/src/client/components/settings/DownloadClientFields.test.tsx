import { describe, it, expect } from 'vitest';
import { screen, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm } from 'react-hook-form';
import { DownloadClientFields } from './DownloadClientFields';
import type { CreateDownloadClientFormData } from '../../../shared/schemas.js';

function FieldWrapper({ type }: { type: string }) {
  const { register, formState: { errors } } = useForm<CreateDownloadClientFormData>({
    defaultValues: { name: '', type: 'qbittorrent', settings: {} },
  });
  return <DownloadClientFields selectedType={type} register={register} errors={errors} />;
}

describe('DownloadClientFields', () => {
  it('renders qbittorrent fields and accepts host input', async () => {
    const user = userEvent.setup();
    render(<FieldWrapper type="qbittorrent" />);

    expect(screen.getByText('Host')).toBeInTheDocument();
    expect(screen.getByText('Port')).toBeInTheDocument();
    expect(screen.getByText('Username')).toBeInTheDocument();
    expect(screen.getByText('Password')).toBeInTheDocument();
    expect(screen.getByText('Use SSL/HTTPS')).toBeInTheDocument();
    expect(screen.queryByText('API Key')).not.toBeInTheDocument();

    const host = screen.getByPlaceholderText('localhost');
    await user.type(host, '10.0.0.1');
    expect(host).toHaveValue('10.0.0.1');
  });

  it('renders transmission fields and accepts username input', async () => {
    const user = userEvent.setup();
    render(<FieldWrapper type="transmission" />);

    expect(screen.getByText('Host')).toBeInTheDocument();
    expect(screen.getByText('Username')).toBeInTheDocument();
    expect(screen.getByText('Password')).toBeInTheDocument();
    expect(screen.getByText('Use SSL/HTTPS')).toBeInTheDocument();

    const username = screen.getByPlaceholderText('admin');
    await user.type(username, 'user1');
    expect(username).toHaveValue('user1');
  });

  it('renders sabnzbd fields with API Key and accepts input', async () => {
    const user = userEvent.setup();
    render(<FieldWrapper type="sabnzbd" />);

    expect(screen.getByText('Host')).toBeInTheDocument();
    expect(screen.getByText('Port')).toBeInTheDocument();
    expect(screen.getByText('API Key')).toBeInTheDocument();
    expect(screen.getByText('Use SSL/HTTPS')).toBeInTheDocument();
    expect(screen.queryByText('Username')).not.toBeInTheDocument();
    expect(screen.queryByText('Password')).not.toBeInTheDocument();

    const apiKey = screen.getByText('API Key').closest('div')!.querySelector('input')!;
    await user.type(apiKey, 'abc123');
    expect(apiKey).toHaveValue('abc123');
  });

  it('defaults to qbittorrent fields for unknown type and accepts input', async () => {
    const user = userEvent.setup();
    render(<FieldWrapper type="unknown" />);

    expect(screen.getByText('Host')).toBeInTheDocument();
    expect(screen.getByText('Username')).toBeInTheDocument();
    expect(screen.getByText('Password')).toBeInTheDocument();

    const host = screen.getByPlaceholderText('localhost');
    await user.type(host, 'fallback.local');
    expect(host).toHaveValue('fallback.local');
  });

  it('allows typing in host field', async () => {
    const user = userEvent.setup();
    render(<FieldWrapper type="qbittorrent" />);

    const input = screen.getByPlaceholderText('localhost');
    await user.type(input, '192.168.1.10');
    expect(input).toHaveValue('192.168.1.10');
  });

  it('renders category field for all client types', () => {
    render(<FieldWrapper type="qbittorrent" />);
    expect(screen.getByText('Category')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('audiobooks')).toBeInTheDocument();
  });

  it('allows typing in category field', async () => {
    const user = userEvent.setup();
    render(<FieldWrapper type="qbittorrent" />);

    const input = screen.getByPlaceholderText('audiobooks');
    await user.type(input, 'my-audiobooks');
    expect(input).toHaveValue('my-audiobooks');
  });

  it('shows category field for sabnzbd', () => {
    render(<FieldWrapper type="sabnzbd" />);
    expect(screen.getByText('Category')).toBeInTheDocument();
  });

  it('allows toggling SSL checkbox', async () => {
    const user = userEvent.setup();
    render(<FieldWrapper type="qbittorrent" />);

    const checkbox = screen.getByRole('checkbox', { name: /Use SSL/i });
    expect(checkbox).not.toBeChecked();
    await user.click(checkbox);
    expect(checkbox).toBeChecked();
  });
});
