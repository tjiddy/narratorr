import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm } from 'react-hook-form';
import { IndexerFields } from './IndexerFields';
import { renderWithProviders } from '@/__tests__/helpers';
import type { CreateIndexerFormData } from '../../../shared/schemas.js';
import type { Mock } from 'vitest';

vi.mock('@/lib/api', () => ({
  api: {
    getSettings: vi.fn(),
  },
}));

import { api } from '@/lib/api';

function FieldWrapper({ type }: { type: string }) {
  const { register, formState: { errors } } = useForm<CreateIndexerFormData>({
    defaultValues: { name: '', type: 'abb', settings: {} },
  });
  return <IndexerFields selectedType={type} register={register} errors={errors} />;
}

function FieldWrapperWithWatch({ type, defaultUseProxy = false }: { type: CreateIndexerFormData['type']; defaultUseProxy?: boolean }) {
  const { register, watch, formState: { errors } } = useForm<CreateIndexerFormData>({
    defaultValues: { name: '', type, settings: { useProxy: defaultUseProxy } },
  });
  return <IndexerFields selectedType={type} register={register} errors={errors} watch={watch} />;
}

function ProwlarrManagedWrapper({ type }: { type: string }) {
  const { register, formState: { errors } } = useForm<CreateIndexerFormData>({
    defaultValues: { name: '', type: 'torznab', settings: { apiUrl: 'https://prowlarr.local/api', apiKey: 'secret-key' } },
  });
  return <IndexerFields selectedType={type} register={register} errors={errors} prowlarrManaged />;
}

beforeEach(() => {
  vi.clearAllMocks();
  (api.getSettings as Mock).mockResolvedValue({ network: { proxyUrl: '' } });
});

describe('IndexerFields', () => {
  it('renders hostname and page limit for abb type and accepts input', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FieldWrapper type="abb" />);

    expect(screen.getByText('Hostname')).toBeInTheDocument();
    expect(screen.getByText('Page Limit')).toBeInTheDocument();
    const hostname = screen.getByPlaceholderText('audiobookbay.lu');
    await user.type(hostname, 'test.com');
    expect(hostname).toHaveValue('test.com');
  });

  it('renders API URL and API Key for torznab type and accepts input', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FieldWrapper type="torznab" />);

    expect(screen.getByText('API URL')).toBeInTheDocument();
    expect(screen.getByText('API Key')).toBeInTheDocument();
    const apiUrl = screen.getByPlaceholderText('https://indexer.example.com/api');
    await user.type(apiUrl, 'https://example.com');
    expect(apiUrl).toHaveValue('https://example.com');
  });

  it('renders API URL and API Key for newznab type and accepts input', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FieldWrapper type="newznab" />);

    const apiUrl = screen.getByPlaceholderText('https://indexer.example.com/api');
    await user.type(apiUrl, 'https://nzb.example.com');
    expect(apiUrl).toHaveValue('https://nzb.example.com');
  });

  it('renders MAM ID and Base URL for myanonamouse type and accepts input', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FieldWrapper type="myanonamouse" />);

    expect(screen.getByText('MAM ID')).toBeInTheDocument();
    expect(screen.getByText('Base URL')).toBeInTheDocument();
    expect(screen.getByText(/Generate from MAM/)).toBeInTheDocument();
    const baseUrlInput = screen.getByPlaceholderText('https://www.myanonamouse.net');
    await user.type(baseUrlInput, 'https://custom.mam.net');
    expect(baseUrlInput).toHaveValue('https://custom.mam.net');
  });

  it('renders nothing for unknown type', () => {
    const { container } = render(<FieldWrapper type="unknown" />);
    expect(container).toBeEmptyDOMElement();
  });

  describe('prowlarrManaged prop (#201)', () => {
    it('prowlarrManaged=true sets readOnly attribute on API URL and API Key inputs', () => {
      renderWithProviders(<ProwlarrManagedWrapper type="torznab" />);

      const apiUrlInput = screen.getByPlaceholderText('https://indexer.example.com/api');
      const apiKeyInput = screen.getByLabelText('API Key');

      expect(apiUrlInput).toHaveAttribute('readOnly');
      expect(apiKeyInput).toHaveAttribute('readOnly');
    });

    it('prowlarrManaged=true fields are not editable via user input', async () => {
      const user = userEvent.setup();
      renderWithProviders(<ProwlarrManagedWrapper type="torznab" />);

      const apiUrlInput = screen.getByPlaceholderText('https://indexer.example.com/api');
      await user.type(apiUrlInput, 'should-not-appear');

      // readOnly inputs do not accept typed text
      expect(apiUrlInput).not.toHaveValue('should-not-appear');
    });

    it('prowlarrManaged=true applies disabled visual styling (opacity class)', () => {
      renderWithProviders(<ProwlarrManagedWrapper type="torznab" />);

      const apiUrlInput = screen.getByPlaceholderText('https://indexer.example.com/api');
      expect(apiUrlInput.className).toContain('opacity-60');
      expect(apiUrlInput.className).toContain('cursor-not-allowed');
    });
  });

  describe('missing watch prop (#201)', () => {
    it('proxy toggle renders with unchecked default when watch prop is omitted', async () => {
      renderWithProviders(<FieldWrapper type="torznab" />);

      await waitFor(() => {
        expect(screen.getByText('Route through proxy')).toBeInTheDocument();
      });

      const checkbox = screen.getByRole('checkbox');
      expect(checkbox).not.toBeChecked();
    });
  });

  describe('FlareSolverr URL field', () => {
    it('shows FlareSolverr URL field for abb type', () => {
      renderWithProviders(<FieldWrapper type="abb" />);
      expect(screen.getByText(/FlareSolverr URL/)).toBeInTheDocument();
      expect(screen.getByPlaceholderText('http://flaresolverr:8191')).toBeInTheDocument();
    });

    it('shows FlareSolverr URL field for torznab type', () => {
      renderWithProviders(<FieldWrapper type="torznab" />);
      expect(screen.getByText(/FlareSolverr URL/)).toBeInTheDocument();
    });

    it('shows FlareSolverr URL field for newznab type', () => {
      renderWithProviders(<FieldWrapper type="newznab" />);
      expect(screen.getByText(/FlareSolverr URL/)).toBeInTheDocument();
    });

    it('accepts proxy URL input', async () => {
      const user = userEvent.setup();
      renderWithProviders(<FieldWrapper type="abb" />);

      const input = screen.getByPlaceholderText('http://flaresolverr:8191');
      await user.type(input, 'http://localhost:8191');
      expect(input).toHaveValue('http://localhost:8191');
    });

    it('shows helper text about Cloudflare bypass', () => {
      renderWithProviders(<FieldWrapper type="torznab" />);
      expect(screen.getByText(/bypass Cloudflare/)).toBeInTheDocument();
    });
  });

  describe('Route through proxy toggle', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      (api.getSettings as Mock).mockResolvedValue({ network: { proxyUrl: 'http://proxy:8888' } });
    });

    it('renders proxy toggle for all indexer types', async () => {
      const types: CreateIndexerFormData['type'][] = ['abb', 'torznab', 'newznab', 'myanonamouse'];
      for (const type of types) {
        const { unmount } = renderWithProviders(<FieldWrapperWithWatch type={type} />);

        await waitFor(() => {
          expect(screen.getByText('Route through proxy')).toBeInTheDocument();
        });
        expect(screen.getByRole('checkbox')).toBeInTheDocument();

        unmount();
      }
    });

    it('toggle state persists after save', async () => {
      const user = userEvent.setup();
      (api.getSettings as Mock).mockResolvedValue({ network: { proxyUrl: 'http://proxy:8888' } });

      renderWithProviders(<FieldWrapperWithWatch type="abb" />);

      await waitFor(() => {
        expect(screen.getByRole('checkbox')).toBeInTheDocument();
      });

      const toggle = screen.getByRole('checkbox');
      expect(toggle).not.toBeChecked();

      await user.click(toggle);
      expect(toggle).toBeChecked();
    });

    it('shows warning when no global proxy URL is configured', async () => {
      const user = userEvent.setup();
      (api.getSettings as Mock).mockResolvedValue({ network: { proxyUrl: '' } });

      renderWithProviders(<FieldWrapperWithWatch type="abb" />);

      await waitFor(() => {
        expect(screen.getByRole('checkbox')).toBeInTheDocument();
      });

      // Enable the proxy toggle
      await user.click(screen.getByRole('checkbox'));

      await waitFor(() => {
        expect(screen.getByText(/no proxy url configured/i)).toBeInTheDocument();
      });
    });
  });
});
