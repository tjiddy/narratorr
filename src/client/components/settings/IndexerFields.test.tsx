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
    testIndexerConfig: vi.fn(),
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
        expect(screen.getByRole('checkbox', { name: /route through proxy/i })).toBeInTheDocument();

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

  describe('MAM language and search type fields (#291)', () => {
    function MamFieldWrapper({ defaultSearchLanguages, defaultSearchType }: { defaultSearchLanguages?: number[]; defaultSearchType?: 'all' | 'active' | 'fl' | 'fl-VIP' | 'VIP' | 'nVIP' } = {}) {
      const { register, watch, setValue, formState: { errors } } = useForm<CreateIndexerFormData>({
        defaultValues: {
          name: '', type: 'myanonamouse',
          settings: {
            mamId: 'test-id',
            searchLanguages: defaultSearchLanguages ?? [1],
            searchType: defaultSearchType ?? 'active',
          },
        },
      });
      return <IndexerFields selectedType="myanonamouse" register={register} errors={errors} watch={watch} setValue={setValue} />;
    }

    it('renders language checkbox group with all 15 languages for myanonamouse type', () => {
      renderWithProviders(<MamFieldWrapper />);
      expect(screen.getByText('Languages')).toBeInTheDocument();
      expect(screen.getByLabelText('English')).toBeInTheDocument();
      expect(screen.getByLabelText('Chinese')).toBeInTheDocument();
      expect(screen.getByLabelText('Spanish')).toBeInTheDocument();
      expect(screen.getByLabelText('French')).toBeInTheDocument();
      expect(screen.getByLabelText('German')).toBeInTheDocument();
      expect(screen.getByLabelText('Italian')).toBeInTheDocument();
      expect(screen.getByLabelText('Japanese')).toBeInTheDocument();
      expect(screen.getByLabelText('Korean')).toBeInTheDocument();
      expect(screen.getByLabelText('Norwegian')).toBeInTheDocument();
      expect(screen.getByLabelText('Polish')).toBeInTheDocument();
      expect(screen.getByLabelText('Portuguese')).toBeInTheDocument();
      expect(screen.getByLabelText('Russian')).toBeInTheDocument();
      expect(screen.getByLabelText('Swedish')).toBeInTheDocument();
      expect(screen.getByLabelText('Turkish')).toBeInTheDocument();
      expect(screen.getByLabelText('Dutch')).toBeInTheDocument();
    });

    it('renders search type dropdown with 6 options (#363)', () => {
      renderWithProviders(<MamFieldWrapper />);
      const dropdown = screen.getByLabelText('Search Type') as HTMLSelectElement;
      expect(dropdown).toBeInTheDocument();
      expect(dropdown.options).toHaveLength(6);
    });

    it('checking a language checkbox updates form value via setValue', async () => {
      const user = userEvent.setup();
      renderWithProviders(<MamFieldWrapper defaultSearchLanguages={[1]} />);

      const frenchCheckbox = screen.getByLabelText('French');
      expect(frenchCheckbox).not.toBeChecked();
      await user.click(frenchCheckbox);
      expect(frenchCheckbox).toBeChecked();
    });

    it('unchecking a language checkbox removes it from form value', async () => {
      const user = userEvent.setup();
      renderWithProviders(<MamFieldWrapper defaultSearchLanguages={[1]} />);

      const englishCheckbox = screen.getByLabelText('English');
      expect(englishCheckbox).toBeChecked();
      await user.click(englishCheckbox);
      expect(englishCheckbox).not.toBeChecked();
    });

    it('default values show English checked', () => {
      renderWithProviders(<MamFieldWrapper />);

      expect(screen.getByLabelText('English')).toBeChecked();
      expect(screen.getByLabelText('French')).not.toBeChecked();
    });

    it('#363 — MAM settings form shows search type dropdown', () => {
      renderWithProviders(<MamFieldWrapper />);
      expect(screen.getByLabelText('Search Type')).toBeInTheDocument();
    });

    it('#317 — language checkboxes still render after dropdown removal', () => {
      renderWithProviders(<MamFieldWrapper />);
      expect(screen.getByText('Languages')).toBeInTheDocument();
      expect(screen.getByLabelText('English')).toBeInTheDocument();
    });
  });

  describe('#317 — MAM VIP detection on blur', () => {
    function MamDetectionWrapper() {
      const { register, watch, setValue, formState: { errors } } = useForm<CreateIndexerFormData>({
        defaultValues: {
          name: '', type: 'myanonamouse',
          settings: { mamId: '', searchLanguages: [1], searchType: 'active' },
        },
      });
      return <IndexerFields selectedType="myanonamouse" register={register} errors={errors} watch={watch} setValue={setValue} />;
    }

    it('does not call API when MAM ID is blurred empty', async () => {
      const user = userEvent.setup();
      renderWithProviders(<MamDetectionWrapper />);

      const mamIdInput = screen.getByLabelText('MAM ID');
      await user.click(mamIdInput);
      await user.tab(); // blur with empty value

      expect((api.testIndexerConfig as Mock)).not.toHaveBeenCalled();
    });

    it('calls testIndexerConfig with correct payload on MAM ID blur', async () => {
      (api.testIndexerConfig as Mock).mockResolvedValue({
        success: true,
        metadata: { username: 'TestUser', classname: 'VIP', isVip: true },
      });
      const user = userEvent.setup();
      renderWithProviders(<MamDetectionWrapper />);

      const mamIdInput = screen.getByLabelText('MAM ID');
      await user.type(mamIdInput, 'my-mam-id');
      await user.tab(); // blur triggers detection

      await waitFor(() => {
        expect((api.testIndexerConfig as Mock)).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'myanonamouse',
            settings: expect.objectContaining({ mamId: 'my-mam-id' }),
          }),
        );
      });
    });

    it('renders status badge with username and classname on success', async () => {
      (api.testIndexerConfig as Mock).mockResolvedValue({
        success: true,
        metadata: { username: 'GotaBe1', classname: 'VIP', isVip: true },
      });
      const user = userEvent.setup();
      renderWithProviders(<MamDetectionWrapper />);

      const mamIdInput = screen.getByLabelText('MAM ID');
      await user.type(mamIdInput, 'valid-id');
      await user.tab();

      await waitFor(() => {
        expect(screen.getByText('GotaBe1')).toBeInTheDocument();
      }, { timeout: 3000 });
      expect(screen.getByText('VIP')).toBeInTheDocument();
    });

    it('renders error message on detection failure', async () => {
      (api.testIndexerConfig as Mock).mockResolvedValue({
        success: false,
        message: 'Authentication failed',
      });
      const user = userEvent.setup();
      renderWithProviders(<MamDetectionWrapper />);

      const mamIdInput = screen.getByLabelText('MAM ID');
      await user.type(mamIdInput, 'bad-id');
      await user.tab();

      await waitFor(() => {
        expect(screen.getByText('Authentication failed')).toBeInTheDocument();
      }, { timeout: 3000 });
    });

    it('includes current baseUrl in the synthetic test payload', async () => {
      (api.testIndexerConfig as Mock).mockResolvedValue({
        success: true,
        metadata: { username: 'User1', classname: 'User', isVip: false },
      });
      const user = userEvent.setup();
      renderWithProviders(<MamDetectionWrapper />);

      // Fill base URL first, then MAM ID and blur
      const baseUrlInput = screen.getByLabelText(/Base URL/);
      await user.type(baseUrlInput, 'https://custom.mam.net');
      const mamIdInput = screen.getByLabelText('MAM ID');
      await user.type(mamIdInput, 'my-mam-id');
      await user.tab();

      await waitFor(() => {
        expect((api.testIndexerConfig as Mock)).toHaveBeenCalledWith(
          expect.objectContaining({
            settings: expect.objectContaining({
              mamId: 'my-mam-id',
              baseUrl: 'https://custom.mam.net',
            }),
          }),
        );
      });
    });

    it('blocking overlay remains visible for minimum 1 second after fast API response', async () => {
      // API resolves immediately (fast response)
      (api.testIndexerConfig as Mock).mockResolvedValue({
        success: true,
        metadata: { username: 'OverlayUser', classname: 'Mouse', isVip: false },
      });

      const user = userEvent.setup();
      renderWithProviders(<MamDetectionWrapper />);

      const mamIdInput = screen.getByLabelText('MAM ID');
      await user.type(mamIdInput, 'test-id');
      await user.tab();

      // Overlay appears — API resolved instantly but ensureMinDuration enforces 1 second
      await waitFor(() => {
        expect(screen.getByText('Checking MAM status…')).toBeInTheDocument();
      });

      // At ~900ms the overlay MUST still be visible (proves minimum is ≥900ms, not just >200ms)
      await new Promise((r) => setTimeout(r, 900));
      expect(screen.getByText('Checking MAM status…')).toBeInTheDocument();

      // Overlay disappears shortly after the 1 second threshold
      await waitFor(() => {
        expect(screen.queryByText('Checking MAM status…')).not.toBeInTheDocument();
      }, { timeout: 500 });
      expect(screen.getByText('OverlayUser')).toBeInTheDocument();
    });

    it('successful detection writes isVip into form state', async () => {
      (api.testIndexerConfig as Mock).mockResolvedValue({
        success: true,
        metadata: { username: 'VipUser', classname: 'VIP', isVip: true },
      });

      const onSubmit = vi.fn();
      function MamDetectionFormWrapper() {
        const { register, handleSubmit, watch, setValue, formState: { errors } } = useForm<CreateIndexerFormData>({
          defaultValues: {
            name: 'Test', type: 'myanonamouse', enabled: true, priority: 0,
            settings: { mamId: '', searchLanguages: [1], searchType: 'active' },
          },
        });
        return (
          <form onSubmit={handleSubmit(onSubmit)}>
            <IndexerFields selectedType="myanonamouse" register={register} errors={errors} watch={watch} setValue={setValue} />
            <button type="submit">Submit</button>
          </form>
        );
      }

      const user = userEvent.setup();
      renderWithProviders(<MamDetectionFormWrapper />);

      // Trigger detection
      const mamIdInput = screen.getByLabelText('MAM ID');
      await user.type(mamIdInput, 'vip-id');
      await user.tab();

      // Wait for badge to appear (detection complete including min duration)
      await waitFor(() => {
        expect(screen.getByText('VipUser')).toBeInTheDocument();
      }, { timeout: 3000 });

      // Submit form and check isVip was written
      await user.click(screen.getByText('Submit'));
      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalled();
      });
      expect(onSubmit.mock.calls[0][0].settings.isVip).toBe(true);
    });

    it('#339 skips detection when MAM ID is sentinel value (********)', async () => {
      const user = userEvent.setup();

      function SentinelWrapper() {
        const { register, watch, setValue, formState: { errors } } = useForm<CreateIndexerFormData>({
          defaultValues: {
            name: '', type: 'myanonamouse',
            settings: { mamId: '********', searchLanguages: [1], searchType: 'active' },
          },
        });
        return <IndexerFields selectedType="myanonamouse" register={register} errors={errors} watch={watch} setValue={setValue} />;
      }

      renderWithProviders(<SentinelWrapper />);

      const mamIdInput = screen.getByLabelText('MAM ID');
      await user.click(mamIdInput);
      await user.tab(); // blur with sentinel value

      expect((api.testIndexerConfig as Mock)).not.toHaveBeenCalled();
    });

    it('#339 onBlur detect includes useProxy: true from form state in payload', async () => {
      (api.testIndexerConfig as Mock).mockResolvedValue({
        success: true,
        metadata: { username: 'ProxyUser', classname: 'User', isVip: false },
      });
      const user = userEvent.setup();

      function ProxyWrapper() {
        const { register, watch, setValue, formState: { errors } } = useForm<CreateIndexerFormData>({
          defaultValues: {
            name: '', type: 'myanonamouse',
            settings: { mamId: '', searchLanguages: [1], searchType: 'active', useProxy: true },
          },
        });
        return <IndexerFields selectedType="myanonamouse" register={register} errors={errors} watch={watch} setValue={setValue} />;
      }

      (api.getSettings as Mock).mockResolvedValue({ network: { proxyUrl: 'http://proxy:8888' } });
      renderWithProviders(<ProxyWrapper />);

      const mamIdInput = screen.getByLabelText('MAM ID');
      await user.type(mamIdInput, 'proxy-test-id');
      await user.tab();

      await waitFor(() => {
        expect((api.testIndexerConfig as Mock)).toHaveBeenCalledWith(
          expect.objectContaining({
            settings: expect.objectContaining({ mamId: 'proxy-test-id', useProxy: true }),
          }),
        );
      });
    });

    it('#339 onBlur detect omits useProxy when form has useProxy: false', async () => {
      (api.testIndexerConfig as Mock).mockResolvedValue({
        success: true,
        metadata: { username: 'NoProxyUser', classname: 'User', isVip: false },
      });
      const user = userEvent.setup();
      renderWithProviders(<MamDetectionWrapper />);

      const mamIdInput = screen.getByLabelText('MAM ID');
      await user.type(mamIdInput, 'no-proxy-id');
      await user.tab();

      await waitFor(() => {
        const call = (api.testIndexerConfig as Mock).mock.calls[0][0];
        expect(call.settings.useProxy).toBeFalsy();
      });
    });

    it('#339 detection success writes mamUsername into form state via setValue', async () => {
      (api.testIndexerConfig as Mock).mockResolvedValue({
        success: true,
        metadata: { username: 'DetectedUser', classname: 'VIP', isVip: true },
      });

      const onSubmit = vi.fn();
      function MamUsernameFormWrapper() {
        const { register, handleSubmit, watch, setValue, formState: { errors } } = useForm<CreateIndexerFormData>({
          defaultValues: {
            name: 'Test', type: 'myanonamouse', enabled: true, priority: 0,
            settings: { mamId: '', searchLanguages: [1], searchType: 'active' },
          },
        });
        return (
          <form onSubmit={handleSubmit(onSubmit)}>
            <IndexerFields selectedType="myanonamouse" register={register} errors={errors} watch={watch} setValue={setValue} />
            <button type="submit">Submit</button>
          </form>
        );
      }

      const user = userEvent.setup();
      renderWithProviders(<MamUsernameFormWrapper />);

      const mamIdInput = screen.getByLabelText('MAM ID');
      await user.type(mamIdInput, 'detect-id');
      await user.tab();

      await waitFor(() => {
        expect(screen.getByText('DetectedUser')).toBeInTheDocument();
      }, { timeout: 3000 });

      await user.click(screen.getByText('Submit'));
      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalled();
      });
      expect(onSubmit.mock.calls[0][0].settings.mamUsername).toBe('DetectedUser');
    });

    it('refresh button triggers a second detection request', async () => {
      (api.testIndexerConfig as Mock).mockResolvedValue({
        success: true,
        metadata: { username: 'User1', classname: 'User', isVip: false },
      });
      const user = userEvent.setup();
      renderWithProviders(<MamDetectionWrapper />);

      const mamIdInput = screen.getByLabelText('MAM ID');
      await user.type(mamIdInput, 'my-id');
      await user.tab();

      await waitFor(() => {
        expect(screen.getByText('User1')).toBeInTheDocument();
      }, { timeout: 3000 });

      // Clear mock and click refresh
      (api.testIndexerConfig as Mock).mockClear();
      (api.testIndexerConfig as Mock).mockResolvedValue({
        success: true,
        metadata: { username: 'User1', classname: 'VIP', isVip: true },
      });

      await user.click(screen.getByTitle('Refresh VIP status'));

      await waitFor(() => {
        expect((api.testIndexerConfig as Mock)).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('DetectionOverlay modal compatibility', () => {
    function MamWrapper() {
      const { register, watch, setValue, formState: { errors } } = useForm<CreateIndexerFormData>({
        defaultValues: {
          name: '', type: 'myanonamouse',
          settings: { mamId: '', searchLanguages: [1], searchType: 'active' },
        },
      });
      return <IndexerFields selectedType="myanonamouse" register={register} errors={errors} watch={watch} setValue={setValue} />;
    }

    it('DetectionOverlay uses relative positioning instead of fixed inset-0 z-50', async () => {
      (api.testIndexerConfig as Mock).mockReturnValue(new Promise(() => {})); // never resolves — keeps overlay visible

      const user = userEvent.setup();
      renderWithProviders(<MamWrapper />);

      const mamIdInput = screen.getByLabelText('MAM ID');
      await user.type(mamIdInput, 'test-id');
      await user.tab();

      await waitFor(() => {
        expect(screen.getByText('Checking MAM status…')).toBeInTheDocument();
      });

      // Walk up from the text to find the outermost overlay wrapper (the sm:col-span-2 div)
      const overlayText = screen.getByText('Checking MAM status…');
      // The card div is the direct parent, the overlay wrapper is its parent
      const overlayWrapper = overlayText.closest('.sm\\:col-span-2') ?? overlayText.parentElement!.parentElement!;
      // Must NOT use fixed positioning or z-50 (conflicts with Modal)
      expect(overlayWrapper.className).toContain('relative');
      expect(overlayWrapper.className).not.toContain('fixed');
      expect(overlayWrapper.className).not.toContain('z-50');
    });

    it('MamStatusBadge renders correctly after successful detection', async () => {
      (api.testIndexerConfig as Mock).mockResolvedValue({
        success: true,
        metadata: { username: 'TestUser', classname: 'Power User', isVip: true },
      });

      const user = userEvent.setup();
      renderWithProviders(<MamWrapper />);

      const mamIdInput = screen.getByLabelText('MAM ID');
      await user.type(mamIdInput, 'test-id');
      await user.tab();

      await waitFor(() => {
        expect(screen.getByText('TestUser')).toBeInTheDocument();
      });
      expect(screen.getByText('Power User')).toBeInTheDocument();
    });

    it('detection error message renders inline in form', async () => {
      (api.testIndexerConfig as Mock).mockResolvedValue({
        success: false,
        message: 'Invalid MAM ID',
      });

      const user = userEvent.setup();
      renderWithProviders(<MamWrapper />);

      const mamIdInput = screen.getByLabelText('MAM ID');
      await user.type(mamIdInput, 'bad-id');
      await user.tab();

      await waitFor(() => {
        expect(screen.getByText('Invalid MAM ID')).toBeInTheDocument();
      });
    });
  });

  describe('#361 — refresh button with sentinel + indexerId', () => {
    function SentinelEditWrapper({ indexerId }: { indexerId?: number } = {}) {
      const { register, watch, setValue, formState: { errors } } = useForm<CreateIndexerFormData>({
        defaultValues: {
          name: '', type: 'myanonamouse',
          settings: { mamId: '********', baseUrl: 'https://mam.example.com', useProxy: true, searchLanguages: [1], searchType: 'active', isVip: true, mamUsername: 'OldUser' },
        },
      });
      return <IndexerFields selectedType="myanonamouse" register={register} errors={errors} watch={watch} setValue={setValue} indexerId={indexerId} />;
    }

    it('#361 refresh with sentinel mamId and indexerId calls testIndexerConfig with id in payload', async () => {
      (api.testIndexerConfig as Mock).mockResolvedValue({
        success: true,
        metadata: { username: 'FreshUser', classname: 'VIP', isVip: true },
      });
      const user = userEvent.setup();
      renderWithProviders(<SentinelEditWrapper indexerId={42} />);

      // Badge should be hydrated from persisted values
      await waitFor(() => {
        expect(screen.getByText('OldUser')).toBeInTheDocument();
      });

      await user.click(screen.getByTitle('Refresh VIP status'));

      await waitFor(() => {
        expect((api.testIndexerConfig as Mock)).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'myanonamouse',
            id: 42,
            settings: expect.objectContaining({ mamId: '********' }),
          }),
        );
      });
    });

    it('#361 refresh with sentinel mamId and indexerId includes current baseUrl and useProxy from form', async () => {
      (api.testIndexerConfig as Mock).mockResolvedValue({
        success: true,
        metadata: { username: 'User1', classname: 'User', isVip: false },
      });
      const user = userEvent.setup();

      // Start with different defaults so we can prove the test reads live form state
      function EditableFormWrapper() {
        const { register, watch, setValue, formState: { errors } } = useForm<CreateIndexerFormData>({
          defaultValues: {
            name: '', type: 'myanonamouse',
            settings: { mamId: '********', baseUrl: '', useProxy: false, searchLanguages: [1], searchType: 'active', isVip: true, mamUsername: 'OldUser' },
          },
        });
        return <IndexerFields selectedType="myanonamouse" register={register} errors={errors} watch={watch} setValue={setValue} indexerId={42} />;
      }

      renderWithProviders(<EditableFormWrapper />);

      await waitFor(() => {
        expect(screen.getByText('OldUser')).toBeInTheDocument();
      });

      // Edit baseUrl and toggle useProxy before clicking refresh
      const baseUrlInput = screen.getByLabelText(/Base URL/);
      await user.type(baseUrlInput, 'https://edited.mam.net');

      const proxyToggle = screen.getByLabelText('Route through proxy');
      await user.click(proxyToggle);

      await user.click(screen.getByTitle('Refresh VIP status'));

      await waitFor(() => {
        expect((api.testIndexerConfig as Mock)).toHaveBeenCalledWith(
          expect.objectContaining({
            settings: expect.objectContaining({
              baseUrl: 'https://edited.mam.net',
              useProxy: true,
            }),
          }),
        );
      });
    });

    it('#361 refresh with sentinel + indexerId success updates badge with fresh metadata', async () => {
      (api.testIndexerConfig as Mock).mockResolvedValue({
        success: true,
        metadata: { username: 'FreshUser', classname: 'Power User', isVip: true },
      });
      const user = userEvent.setup();
      renderWithProviders(<SentinelEditWrapper indexerId={42} />);

      await waitFor(() => {
        expect(screen.getByText('OldUser')).toBeInTheDocument();
      });

      await user.click(screen.getByTitle('Refresh VIP status'));

      await waitFor(() => {
        expect(screen.getByText('FreshUser')).toBeInTheDocument();
      }, { timeout: 3000 });
      expect(screen.getByText('Power User')).toBeInTheDocument();
    });

    it('#361 refresh with sentinel + indexerId success writes isVip and mamUsername via setValue', async () => {
      (api.testIndexerConfig as Mock).mockResolvedValue({
        success: true,
        metadata: { username: 'NewVipUser', classname: 'VIP', isVip: true },
      });

      const onSubmit = vi.fn();
      function SentinelEditFormWrapper() {
        const { register, handleSubmit, watch, setValue, formState: { errors } } = useForm<CreateIndexerFormData>({
          defaultValues: {
            name: 'Test', type: 'myanonamouse', enabled: true, priority: 0,
            settings: { mamId: '********', baseUrl: '', searchLanguages: [1], searchType: 'active', isVip: false, mamUsername: 'OldUser' },
          },
        });
        return (
          <form onSubmit={handleSubmit(onSubmit)}>
            <IndexerFields selectedType="myanonamouse" register={register} errors={errors} watch={watch} setValue={setValue} indexerId={7} />
            <button type="submit">Submit</button>
          </form>
        );
      }

      const user = userEvent.setup();
      renderWithProviders(<SentinelEditFormWrapper />);

      await waitFor(() => {
        expect(screen.getByText('OldUser')).toBeInTheDocument();
      });

      await user.click(screen.getByTitle('Refresh VIP status'));

      await waitFor(() => {
        expect(screen.getByText('NewVipUser')).toBeInTheDocument();
      }, { timeout: 3000 });

      await user.click(screen.getByText('Submit'));
      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalled();
      });
      expect(onSubmit.mock.calls[0][0].settings.isVip).toBe(true);
      expect(onSubmit.mock.calls[0][0].settings.mamUsername).toBe('NewVipUser');
    });

    it('#361 refresh with sentinel + indexerId shows DetectionOverlay spinner during API call', async () => {
      (api.testIndexerConfig as Mock).mockReturnValue(new Promise(() => {})); // never resolves
      const user = userEvent.setup();
      renderWithProviders(<SentinelEditWrapper indexerId={42} />);

      await waitFor(() => {
        expect(screen.getByText('OldUser')).toBeInTheDocument();
      });

      await user.click(screen.getByTitle('Refresh VIP status'));

      await waitFor(() => {
        expect(screen.getByText('Checking MAM status…')).toBeInTheDocument();
      });
    });

    it('#361 refresh with sentinel + indexerId API failure shows error message, clears badge', async () => {
      (api.testIndexerConfig as Mock).mockRejectedValue(new Error('Network error'));
      const user = userEvent.setup();
      renderWithProviders(<SentinelEditWrapper indexerId={42} />);

      await waitFor(() => {
        expect(screen.getByText('OldUser')).toBeInTheDocument();
      });

      await user.click(screen.getByTitle('Refresh VIP status'));

      await waitFor(() => {
        expect(screen.getByText('Connection failed')).toBeInTheDocument();
      }, { timeout: 3000 });
      expect(screen.queryByText('OldUser')).not.toBeInTheDocument();
    });

    it('#361 refresh with sentinel + indexerId API returns success:false shows error message', async () => {
      (api.testIndexerConfig as Mock).mockResolvedValue({
        success: false,
        message: 'MAM ID expired',
      });
      const user = userEvent.setup();
      renderWithProviders(<SentinelEditWrapper indexerId={42} />);

      await waitFor(() => {
        expect(screen.getByText('OldUser')).toBeInTheDocument();
      });

      await user.click(screen.getByTitle('Refresh VIP status'));

      await waitFor(() => {
        expect(screen.getByText('MAM ID expired')).toBeInTheDocument();
      }, { timeout: 3000 });
      expect(screen.queryByText('OldUser')).not.toBeInTheDocument();
    });

    it('#361 refresh with non-sentinel mamId calls testIndexerConfig without id (existing path)', async () => {
      (api.testIndexerConfig as Mock)
        .mockResolvedValueOnce({ success: true, metadata: { username: 'User1', classname: 'User', isVip: false } })
        .mockResolvedValueOnce({ success: true, metadata: { username: 'User1', classname: 'VIP', isVip: true } });
      const user = userEvent.setup();

      function NonSentinelWrapper() {
        const { register, watch, setValue, formState: { errors } } = useForm<CreateIndexerFormData>({
          defaultValues: {
            name: '', type: 'myanonamouse',
            settings: { mamId: '', searchLanguages: [1], searchType: 'active' },
          },
        });
        return <IndexerFields selectedType="myanonamouse" register={register} errors={errors} watch={watch} setValue={setValue} indexerId={42} />;
      }

      renderWithProviders(<NonSentinelWrapper />);

      // Type a real mamId and blur to get initial badge
      const mamIdInput = screen.getByLabelText('MAM ID');
      await user.type(mamIdInput, 'real-mam-id');
      await user.tab();

      await waitFor(() => {
        expect(screen.getByText('User1')).toBeInTheDocument();
      }, { timeout: 3000 });

      // Clear mock and click refresh
      (api.testIndexerConfig as Mock).mockClear();
      (api.testIndexerConfig as Mock).mockResolvedValue({
        success: true,
        metadata: { username: 'User1', classname: 'VIP', isVip: true },
      });

      await user.click(screen.getByTitle('Refresh VIP status'));

      await waitFor(() => {
        expect((api.testIndexerConfig as Mock)).toHaveBeenCalledWith(
          expect.objectContaining({
            settings: expect.objectContaining({ mamId: 'real-mam-id' }),
          }),
        );
        expect((api.testIndexerConfig as Mock)).toHaveBeenCalledWith(
          expect.not.objectContaining({ id: expect.anything() }),
        );
      });
    });

    it('#361 refresh with sentinel mamId but no indexerId (create mode) does not call API', async () => {
      const user = userEvent.setup();

      // SentinelEditWrapper without indexerId simulates create mode with sentinel somehow in field
      renderWithProviders(<SentinelEditWrapper />);

      // Badge is hydrated from persisted isVip/mamUsername defaults
      await waitFor(() => {
        expect(screen.getByText('OldUser')).toBeInTheDocument();
      });

      await user.click(screen.getByTitle('Refresh VIP status'));

      // Should not call API — sentinel without indexerId means no saved credentials to resolve
      expect((api.testIndexerConfig as Mock)).not.toHaveBeenCalled();
    });

    it('#361 blur with sentinel mamId still skips detection (unchanged behavior)', async () => {
      const user = userEvent.setup();
      renderWithProviders(<SentinelEditWrapper indexerId={42} />);

      const mamIdInput = screen.getByLabelText('MAM ID');
      await user.click(mamIdInput);
      await user.tab(); // blur with sentinel value

      expect((api.testIndexerConfig as Mock)).not.toHaveBeenCalled();
    });

    it('#361 blur with real mamId still calls testIndexerConfig without id (unchanged behavior)', async () => {
      (api.testIndexerConfig as Mock).mockResolvedValue({
        success: true,
        metadata: { username: 'BlurUser', classname: 'User', isVip: false },
      });
      const user = userEvent.setup();

      function BlurTestWrapper() {
        const { register, watch, setValue, formState: { errors } } = useForm<CreateIndexerFormData>({
          defaultValues: {
            name: '', type: 'myanonamouse',
            settings: { mamId: '', searchLanguages: [1], searchType: 'active' },
          },
        });
        return <IndexerFields selectedType="myanonamouse" register={register} errors={errors} watch={watch} setValue={setValue} indexerId={42} />;
      }

      renderWithProviders(<BlurTestWrapper />);

      const mamIdInput = screen.getByLabelText('MAM ID');
      await user.type(mamIdInput, 'new-real-id');
      await user.tab();

      await waitFor(() => {
        expect((api.testIndexerConfig as Mock)).toHaveBeenCalledWith(
          expect.not.objectContaining({ id: expect.anything() }),
        );
      });
    });
  });

  describe('#363 — searchType dropdown', () => {
    function MamFieldWrapper363({ defaultSearchType }: { defaultSearchType?: 'all' | 'active' | 'fl' | 'fl-VIP' | 'VIP' | 'nVIP' } = {}) {
      const { register, watch, setValue, formState: { errors } } = useForm<CreateIndexerFormData>({
        defaultValues: {
          name: '', type: 'myanonamouse',
          settings: {
            mamId: 'test-id',
            searchLanguages: [1],
            searchType: defaultSearchType ?? 'active',
          },
        },
      });
      return <IndexerFields selectedType="myanonamouse" register={register} errors={errors} watch={watch} setValue={setValue} />;
    }

    it('renders searchType dropdown with 6 options and helper text', () => {
      renderWithProviders(<MamFieldWrapper363 />);
      const dropdown = screen.getByLabelText('Search Type') as HTMLSelectElement;
      expect(dropdown).toBeInTheDocument();
      expect(dropdown.options).toHaveLength(6);
      expect(screen.getByText(/auto-overridden by vip status/i)).toBeInTheDocument();
    });

    it('dropdown labels match expected values', () => {
      renderWithProviders(<MamFieldWrapper363 />);
      const dropdown = screen.getByLabelText('Search Type') as HTMLSelectElement;
      const labels = Array.from(dropdown.options).map(o => o.text);
      expect(labels).toEqual([
        'All',
        'Active',
        'Freeleech',
        'Freeleech or VIP',
        'VIP Only',
        'Not VIP',
      ]);
    });

    it('selecting a search type updates form state with string value', async () => {
      const user = userEvent.setup();
      renderWithProviders(<MamFieldWrapper363 />);
      const dropdown = screen.getByLabelText('Search Type') as HTMLSelectElement;
      await user.selectOptions(dropdown, 'nVIP');
      expect(dropdown.value).toBe('nVIP');
    });
  });

  describe('#372 — Search Type dropdown removal', () => {
    it.todo('MAM settings form does NOT render a "Search Type" label or select element');
    it.todo('form submission does not include searchType in submitted settings');
  });

  describe('#372 — status-aware messaging', () => {
    it.todo('renders "Searching all torrents including VIP" when classname is VIP and isVip is true');
    it.todo('renders "Searching non-VIP and freeleech torrents" when classname is Power User and isVip is false');
    it.todo('renders amber warning "Mouse class — searches disabled until ratio improves" when classname is Mouse');
    it.todo('renders no status messaging when no classname/isVip in settings');
  });

  describe('#372 — deriveInitialMamStatus hydration from classname', () => {
    it.todo('badge shows "Power User" when classname is "Power User" (not hardcoded "User")');
    it.todo('badge shows "Mouse" when classname is "Mouse"');
  });

  describe('#372 — status transitions on detection refresh', () => {
    it.todo('warning replaces VIP message after refresh detects Mouse');
    it.todo('warning removed and non-VIP message shown after refresh detects Power User');
  });
});
