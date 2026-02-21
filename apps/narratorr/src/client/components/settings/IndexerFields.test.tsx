import { describe, it, expect } from 'vitest';
import { screen, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm } from 'react-hook-form';
import { IndexerFields } from './IndexerFields';
import type { CreateIndexerFormData } from '../../../shared/schemas.js';

function FieldWrapper({ type }: { type: string }) {
  const { register, formState: { errors } } = useForm<CreateIndexerFormData>({
    defaultValues: { name: '', type: 'abb', settings: {} },
  });
  return <IndexerFields selectedType={type} register={register} errors={errors} />;
}

describe('IndexerFields', () => {
  it('renders hostname and page limit for abb type and accepts input', async () => {
    const user = userEvent.setup();
    render(<FieldWrapper type="abb" />);

    expect(screen.getByText('Hostname')).toBeInTheDocument();
    expect(screen.getByText('Page Limit')).toBeInTheDocument();
    const hostname = screen.getByPlaceholderText('audiobookbay.lu');
    await user.type(hostname, 'test.com');
    expect(hostname).toHaveValue('test.com');
  });

  it('renders API URL and API Key for torznab type and accepts input', async () => {
    const user = userEvent.setup();
    render(<FieldWrapper type="torznab" />);

    expect(screen.getByText('API URL')).toBeInTheDocument();
    expect(screen.getByText('API Key')).toBeInTheDocument();
    const apiUrl = screen.getByPlaceholderText('https://indexer.example.com/api');
    await user.type(apiUrl, 'https://example.com');
    expect(apiUrl).toHaveValue('https://example.com');
  });

  it('renders API URL and API Key for newznab type and accepts input', async () => {
    const user = userEvent.setup();
    render(<FieldWrapper type="newznab" />);

    const apiUrl = screen.getByPlaceholderText('https://indexer.example.com/api');
    await user.type(apiUrl, 'https://nzb.example.com');
    expect(apiUrl).toHaveValue('https://nzb.example.com');
  });

  it('renders nothing for unknown type', () => {
    const { container } = render(<FieldWrapper type="unknown" />);
    expect(container.innerHTML).toBe('');
  });
});
