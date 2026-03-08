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

  it('renders MAM ID and Base URL for myanonamouse type and accepts input', async () => {
    const user = userEvent.setup();
    render(<FieldWrapper type="myanonamouse" />);

    expect(screen.getByText('MAM ID')).toBeInTheDocument();
    expect(screen.getByText('Base URL')).toBeInTheDocument();
    expect(screen.getByText(/Generate from MAM/)).toBeInTheDocument();
    const baseUrlInput = screen.getByPlaceholderText('https://www.myanonamouse.net');
    await user.type(baseUrlInput, 'https://custom.mam.net');
    expect(baseUrlInput).toHaveValue('https://custom.mam.net');
  });

  it('renders nothing for unknown type', () => {
    const { container } = render(<FieldWrapper type="unknown" />);
    expect(container.innerHTML).toBe('');
  });

  describe('FlareSolverr URL field', () => {
    it('shows FlareSolverr URL field for abb type', () => {
      render(<FieldWrapper type="abb" />);
      expect(screen.getByText(/FlareSolverr URL/)).toBeInTheDocument();
      expect(screen.getByPlaceholderText('http://flaresolverr:8191')).toBeInTheDocument();
    });

    it('shows FlareSolverr URL field for torznab type', () => {
      render(<FieldWrapper type="torznab" />);
      expect(screen.getByText(/FlareSolverr URL/)).toBeInTheDocument();
    });

    it('shows FlareSolverr URL field for newznab type', () => {
      render(<FieldWrapper type="newznab" />);
      expect(screen.getByText(/FlareSolverr URL/)).toBeInTheDocument();
    });

    it('accepts proxy URL input', async () => {
      const user = userEvent.setup();
      render(<FieldWrapper type="abb" />);

      const input = screen.getByPlaceholderText('http://flaresolverr:8191');
      await user.type(input, 'http://localhost:8191');
      expect(input).toHaveValue('http://localhost:8191');
    });

    it('shows helper text about Cloudflare bypass', () => {
      render(<FieldWrapper type="torznab" />);
      expect(screen.getByText(/bypass Cloudflare/)).toBeInTheDocument();
    });
  });
});
