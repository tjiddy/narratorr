import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm } from 'react-hook-form';
import { IndexerFields } from './IndexerFields';
import { renderWithProviders } from '@/__tests__/helpers';
import type { CreateIndexerFormData } from '../../../shared/schemas.js';
import type { IndexerType } from '../../../shared/indexer-registry.js';
import type { Mock } from 'vitest';

vi.mock('@/lib/api', () => ({
  api: {
    getSettings: vi.fn(),
    testIndexerConfig: vi.fn(),
  },
}));

import { api } from '@/lib/api';

function FieldWrapper({ type }: { type: IndexerType }) {
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

function ProwlarrManagedWrapper({ type }: { type: IndexerType }) {
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

  it('abb page limit input uses integer step', () => {
    renderWithProviders(<FieldWrapper type="abb" />);
    expect(screen.getByLabelText('Page Limit').getAttribute('step')).toBe('1');
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

    it('does not render language checkboxes for myanonamouse type', () => {
      renderWithProviders(<MamFieldWrapper />);
      expect(screen.queryByLabelText('English')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('French')).not.toBeInTheDocument();
    });
  });

  describe('#1156 — onBlur auto-detect removed; Test button remains the trigger', () => {
    function MamDetectionWrapper() {
      const { register, watch, setValue, formState: { errors } } = useForm<CreateIndexerFormData>({
        defaultValues: {
          name: '', type: 'myanonamouse',
          settings: { mamId: '', searchLanguages: [1], searchType: 'active' },
        },
      });
      return <IndexerFields selectedType="myanonamouse" register={register} errors={errors} watch={watch} setValue={setValue} />;
    }

    it('typing into MAM ID and blurring does NOT trigger testIndexerConfig', async () => {
      const user = userEvent.setup();
      renderWithProviders(<MamDetectionWrapper />);

      const mamIdInput = screen.getByLabelText('MAM ID');
      await user.type(mamIdInput, 'my-mam-id');
      await user.tab();

      // Wait a tick to allow any background async to settle, then assert no API call.
      await new Promise(r => setTimeout(r, 50));
      expect((api.testIndexerConfig as Mock)).not.toHaveBeenCalled();
    });
  });

  describe('DetectionOverlay modal compatibility', () => {
    it('DetectionOverlay uses relative positioning instead of fixed inset-0 z-50', async () => {
      (api.testIndexerConfig as Mock).mockReturnValue(new Promise(() => {})); // never resolves — keeps overlay visible

      function MamPrehydratedWrapper() {
        const { register, watch, setValue, formState: { errors } } = useForm<CreateIndexerFormData>({
          defaultValues: {
            name: '', type: 'myanonamouse',
            settings: { mamId: 'has-id', searchLanguages: [1], searchType: 'active', isVip: false, mamUsername: 'Existing' },
          },
        });
        return <IndexerFields selectedType="myanonamouse" register={register} errors={errors} watch={watch} setValue={setValue} />;
      }

      const user = userEvent.setup();
      renderWithProviders(<MamPrehydratedWrapper />);

      await user.click(screen.getByTitle('Refresh MAM status'));

      await waitFor(() => {
        expect(screen.getByText('Checking MAM status…')).toBeInTheDocument();
      });

      const overlayText = screen.getByText('Checking MAM status…');
      const overlayWrapper = overlayText.closest('.sm\\:col-span-2') ?? overlayText.parentElement!.parentElement!;
      expect(overlayWrapper.className).toContain('relative');
      expect(overlayWrapper.className).not.toContain('fixed');
      expect(overlayWrapper.className).not.toContain('z-50');
    });

    it('MamAccountCard renders correctly when detection is triggered via formTestResult bridge', async () => {
      function MamFormTestResultWrapper() {
        const { register, watch, setValue, formState: { errors } } = useForm<CreateIndexerFormData>({
          defaultValues: {
            name: '', type: 'myanonamouse',
            settings: { mamId: 'test-id', searchLanguages: [1], searchType: 'active' },
          },
        });
        return (
          <IndexerFields
            selectedType="myanonamouse"
            register={register}
            errors={errors}
            watch={watch}
            setValue={setValue}
            formTestResult={{ success: true, metadata: { username: 'TestUser', classname: 'Power User', isVip: true } }}
          />
        );
      }
      renderWithProviders(<MamFormTestResultWrapper />);
      await waitFor(() => {
        expect(screen.getByText('TestUser')).toBeInTheDocument();
      });
      expect(screen.getByText('Power User')).toBeInTheDocument();
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
      return <IndexerFields selectedType="myanonamouse" register={register} errors={errors} watch={watch} setValue={setValue} {...(indexerId !== undefined && { indexerId })} />;
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

      await user.click(screen.getByTitle('Refresh MAM status'));

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

      await user.click(screen.getByTitle('Refresh MAM status'));

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

      await user.click(screen.getByTitle('Refresh MAM status'));

      await waitFor(() => {
        expect(screen.getByText('FreshUser')).toBeInTheDocument();
      });
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

      await user.click(screen.getByTitle('Refresh MAM status'));

      await waitFor(() => {
        expect(screen.getByText('NewVipUser')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Submit'));
      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalled();
      });
      expect(onSubmit.mock.calls[0]![0].settings.isVip).toBe(true);
      expect(onSubmit.mock.calls[0]![0].settings.mamUsername).toBe('NewVipUser');
    });

    it('#361 refresh with sentinel + indexerId shows DetectionOverlay spinner during API call', async () => {
      (api.testIndexerConfig as Mock).mockReturnValue(new Promise(() => {})); // never resolves
      const user = userEvent.setup();
      renderWithProviders(<SentinelEditWrapper indexerId={42} />);

      await waitFor(() => {
        expect(screen.getByText('OldUser')).toBeInTheDocument();
      });

      await user.click(screen.getByTitle('Refresh MAM status'));

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

      await user.click(screen.getByTitle('Refresh MAM status'));

      await waitFor(() => {
        expect(screen.getByText('Connection failed')).toBeInTheDocument();
      });
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

      await user.click(screen.getByTitle('Refresh MAM status'));

      await waitFor(() => {
        expect(screen.getByText('MAM ID expired')).toBeInTheDocument();
      });
      expect(screen.queryByText('OldUser')).not.toBeInTheDocument();
    });

    it('#361 refresh with non-sentinel mamId calls testIndexerConfig without id (existing path)', async () => {
      (api.testIndexerConfig as Mock).mockResolvedValue({
        success: true,
        metadata: { username: 'User1', classname: 'VIP', isVip: true },
      });
      const user = userEvent.setup();

      function NonSentinelWrapper() {
        const { register, watch, setValue, formState: { errors } } = useForm<CreateIndexerFormData>({
          defaultValues: {
            name: '', type: 'myanonamouse',
            settings: { mamId: 'real-mam-id', searchLanguages: [1], searchType: 'active', isVip: false, mamUsername: 'Existing' },
          },
        });
        return <IndexerFields selectedType="myanonamouse" register={register} errors={errors} watch={watch} setValue={setValue} indexerId={42} />;
      }

      renderWithProviders(<NonSentinelWrapper />);

      await user.click(screen.getByTitle('Refresh MAM status'));

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

      await user.click(screen.getByTitle('Refresh MAM status'));

      // Should not call API — sentinel without indexerId means no saved credentials to resolve
      expect((api.testIndexerConfig as Mock)).not.toHaveBeenCalled();
    });

    it('#1156 blur on MAM ID does not call the API (onBlur auto-detect removed)', async () => {
      const user = userEvent.setup();
      renderWithProviders(<SentinelEditWrapper indexerId={42} />);

      const mamIdInput = screen.getByLabelText('MAM ID');
      await user.click(mamIdInput);
      await user.tab();

      await new Promise(r => setTimeout(r, 50));
      expect((api.testIndexerConfig as Mock)).not.toHaveBeenCalled();
    });
  });

  describe('#372 — Search Type dropdown removal', () => {
    function MamFieldWrapperSimple() {
      const { register, watch, setValue, formState: { errors } } = useForm<CreateIndexerFormData>({
        defaultValues: {
          name: '', type: 'myanonamouse',
          settings: { mamId: 'test-id', searchLanguages: [1] },
        },
      });
      return <IndexerFields selectedType="myanonamouse" register={register} errors={errors} watch={watch} setValue={setValue} />;
    }

    it('MAM settings form does NOT render a "Search Type" label or select element', () => {
      renderWithProviders(<MamFieldWrapperSimple />);
      expect(screen.queryByLabelText('Search Type')).not.toBeInTheDocument();
    });
  });

  describe('#372 — status-aware messaging', () => {
    function MamFieldWithStatus({ isVip, classname }: { isVip: boolean; classname: string }) {
      const { register, watch, setValue, formState: { errors } } = useForm<CreateIndexerFormData>({
        defaultValues: {
          name: '', type: 'myanonamouse',
          settings: { mamId: 'test-id', searchLanguages: [1], isVip, mamUsername: 'testuser', classname } as Record<string, unknown>,
        },
      });
      return <IndexerFields selectedType="myanonamouse" register={register} errors={errors} watch={watch} setValue={setValue} />;
    }

    it('renders "All torrents including VIP" in card when classname is VIP and isVip is true', () => {
      renderWithProviders(<MamFieldWithStatus isVip={true} classname="VIP" />);
      expect(screen.getByText('All torrents including VIP')).toBeInTheDocument();
    });

    it('renders "Non-VIP and freeleech torrents" in card when classname is Power User and isVip is false', () => {
      renderWithProviders(<MamFieldWithStatus isVip={false} classname="Power User" />);
      expect(screen.getByText('Non-VIP and freeleech torrents')).toBeInTheDocument();
    });

    it('renders warning in card when classname is Mouse', () => {
      renderWithProviders(<MamFieldWithStatus isVip={false} classname="Mouse" />);
      expect(screen.getByText(/Search disabled — Mouse class cannot download/)).toBeInTheDocument();
    });

    it('renders no card when no isVip in settings', () => {
      function MamFieldNoStatus() {
        const { register, watch, setValue, formState: { errors } } = useForm<CreateIndexerFormData>({
          defaultValues: {
            name: '', type: 'myanonamouse',
            settings: { mamId: 'test-id', searchLanguages: [1] },
          },
        });
        return <IndexerFields selectedType="myanonamouse" register={register} errors={errors} watch={watch} setValue={setValue} />;
      }
      renderWithProviders(<MamFieldNoStatus />);
      expect(screen.queryByText('Username')).not.toBeInTheDocument();
      expect(screen.queryByText(/Mouse class/)).not.toBeInTheDocument();
    });
  });

  describe('#372 — deriveInitialMamStatus hydration from classname', () => {
    function MamFieldWithPersistedClass({ classname }: { classname: string }) {
      const { register, watch, setValue, formState: { errors } } = useForm<CreateIndexerFormData>({
        defaultValues: {
          name: '', type: 'myanonamouse',
          settings: { mamId: 'test-id', searchLanguages: [1], isVip: false, mamUsername: 'user', classname } as Record<string, unknown>,
        },
      });
      return <IndexerFields selectedType="myanonamouse" register={register} errors={errors} watch={watch} setValue={setValue} />;
    }

    it('card shows "Power User" when classname is "Power User"', () => {
      renderWithProviders(<MamFieldWithPersistedClass classname="Power User" />);
      expect(screen.getByText('Power User')).toBeInTheDocument();
    });

    it('card shows "Mouse" when classname is "Mouse" with search disabled warning', () => {
      renderWithProviders(<MamFieldWithPersistedClass classname="Mouse" />);
      expect(screen.getByText('Mouse')).toBeInTheDocument();
      expect(screen.getByText(/Search disabled — Mouse class cannot download/)).toBeInTheDocument();
    });
  });

  describe('#383 — MamAccountCard consolidation', () => {
    function MamFieldWithStatus({ isVip, classname }: { isVip: boolean; classname?: string }) {
      const { register, watch, setValue, formState: { errors } } = useForm<CreateIndexerFormData>({
        defaultValues: {
          name: '', type: 'myanonamouse',
          settings: { mamId: 'test-id', searchLanguages: [1], isVip, mamUsername: 'testuser', ...(classname !== undefined ? { classname } : {}) } as Record<string, unknown>,
        },
      });
      return <IndexerFields selectedType="myanonamouse" register={register} errors={errors} watch={watch} setValue={setValue} />;
    }

    it('card displays Username, Class, and Search rows for VIP user', () => {
      renderWithProviders(<MamFieldWithStatus isVip={true} classname="VIP" />);
      expect(screen.getByText('Username')).toBeInTheDocument();
      expect(screen.getByText('testuser')).toBeInTheDocument();
      expect(screen.getByText('Class')).toBeInTheDocument();
      expect(screen.getByText('VIP')).toBeInTheDocument();
      expect(screen.getByText('Search')).toBeInTheDocument();
      expect(screen.getByText('All torrents including VIP')).toBeInTheDocument();
    });

    it('card displays "All torrents including VIP" search description for VIP', () => {
      renderWithProviders(<MamFieldWithStatus isVip={true} classname="Elite VIP" />);
      expect(screen.getByText('All torrents including VIP')).toBeInTheDocument();
    });

    it('card displays "Non-VIP and freeleech torrents" search description for regular class', () => {
      renderWithProviders(<MamFieldWithStatus isVip={false} classname="Power User" />);
      expect(screen.getByText('Non-VIP and freeleech torrents')).toBeInTheDocument();
    });

    it('card displays "Search disabled" warning for Mouse class', () => {
      renderWithProviders(<MamFieldWithStatus isVip={false} classname="Mouse" />);
      expect(screen.getByText(/Search disabled — Mouse class cannot download/)).toBeInTheDocument();
    });

    it('Mouse detection is case-sensitive — lowercase "mouse" does not trigger warning', () => {
      renderWithProviders(<MamFieldWithStatus isVip={false} classname="mouse" />);
      expect(screen.queryByText(/Search disabled/)).not.toBeInTheDocument();
      expect(screen.getByText('Non-VIP and freeleech torrents')).toBeInTheDocument();
    });

    it('card does not render when mamStatus is null', () => {
      function MamFieldNoStatus() {
        const { register, watch, setValue, formState: { errors } } = useForm<CreateIndexerFormData>({
          defaultValues: {
            name: '', type: 'myanonamouse',
            settings: { mamId: 'test-id', searchLanguages: [1] },
          },
        });
        return <IndexerFields selectedType="myanonamouse" register={register} errors={errors} watch={watch} setValue={setValue} />;
      }
      renderWithProviders(<MamFieldNoStatus />);
      expect(screen.queryByText('Username')).not.toBeInTheDocument();
      expect(screen.queryByText('Class')).not.toBeInTheDocument();
      expect(screen.queryByText('Search')).not.toBeInTheDocument();
    });

    it('missing classname falls back to "User" via deriveInitialMamStatus when isVip is false', () => {
      renderWithProviders(<MamFieldWithStatus isVip={false} />);
      // deriveInitialMamStatus fills classname as 'User' when not persisted and isVip is false
      expect(screen.getByText('User')).toBeInTheDocument();
      expect(screen.getByText('Non-VIP and freeleech torrents')).toBeInTheDocument();
    });

    it('renders "Unknown" when refresh result returns undefined classname', async () => {
      (api.testIndexerConfig as Mock).mockResolvedValue({
        success: true,
        metadata: { username: 'TestUser', isVip: false },
      });

      const user = userEvent.setup();
      renderWithProviders(<MamFieldWithStatus isVip={false} classname="Power User" />);

      await user.click(screen.getByTitle('Refresh MAM status'));

      await waitFor(() => {
        expect(screen.getByText('Unknown')).toBeInTheDocument();
      });
    });

    it('shows Exit IP row when refresh result returns ip (proxy enabled)', async () => {
      (api.testIndexerConfig as Mock).mockResolvedValue({
        success: true,
        ip: '203.0.113.42',
        metadata: { username: 'ProxyUser', classname: 'User', isVip: false },
      });

      const user = userEvent.setup();
      renderWithProviders(<MamFieldWithStatus isVip={false} classname="User" />);

      await user.click(screen.getByTitle('Refresh MAM status'));

      await waitFor(() => {
        expect(screen.getByText('Exit IP')).toBeInTheDocument();
        expect(screen.getByText('203.0.113.42')).toBeInTheDocument();
      });
    });

    it('does not show Exit IP row when refresh result returns no ip (no proxy)', async () => {
      (api.testIndexerConfig as Mock).mockResolvedValue({
        success: true,
        metadata: { username: 'DirectUser', classname: 'Power User', isVip: false },
      });

      const user = userEvent.setup();
      renderWithProviders(<MamFieldWithStatus isVip={false} classname="User" />);

      await user.click(screen.getByTitle('Refresh MAM status'));

      await waitFor(() => {
        expect(screen.getByText('DirectUser')).toBeInTheDocument();
      });
      expect(screen.queryByText('Exit IP')).not.toBeInTheDocument();
    });

    it('shows Exit IP row when Test button result includes ip', async () => {
      function MamFieldWithTestResult() {
        const { register, watch, setValue, formState: { errors } } = useForm<CreateIndexerFormData>({
          defaultValues: {
            name: '', type: 'myanonamouse',
            settings: { mamId: 'test-id', searchLanguages: [1], isVip: false, mamUsername: 'testuser', classname: 'User' } as Record<string, unknown>,
          },
        });
        return (
          <IndexerFields
            selectedType="myanonamouse"
            register={register}
            errors={errors}
            watch={watch}
            setValue={setValue}
            formTestResult={{ success: true, ip: '10.0.0.1', metadata: { username: 'TestBtn', classname: 'VIP', isVip: true } }}
          />
        );
      }
      renderWithProviders(<MamFieldWithTestResult />);
      await waitFor(() => {
        expect(screen.getByText('Exit IP')).toBeInTheDocument();
        expect(screen.getByText('10.0.0.1')).toBeInTheDocument();
      });
    });

    it('Exit IP row not shown when Test button result has no ip', async () => {
      function MamFieldWithTestResultNoIp() {
        const { register, watch, setValue, formState: { errors } } = useForm<CreateIndexerFormData>({
          defaultValues: {
            name: '', type: 'myanonamouse',
            settings: { mamId: 'test-id', searchLanguages: [1], isVip: false, mamUsername: 'testuser', classname: 'User' } as Record<string, unknown>,
          },
        });
        return (
          <IndexerFields
            selectedType="myanonamouse"
            register={register}
            errors={errors}
            watch={watch}
            setValue={setValue}
            formTestResult={{ success: true, metadata: { username: 'TestBtn', classname: 'VIP', isVip: true } }}
          />
        );
      }
      renderWithProviders(<MamFieldWithTestResultNoIp />);
      await waitFor(() => {
        expect(screen.getByText('TestBtn')).toBeInTheDocument();
      });
      expect(screen.queryByText('Exit IP')).not.toBeInTheDocument();
    });
  });

  describe('MAM language checkboxes removal', () => {
    function MamFieldWrapperSimple() {
      const { register, watch, setValue, formState: { errors } } = useForm<CreateIndexerFormData>({
        defaultValues: {
          name: '', type: 'myanonamouse',
          settings: { mamId: 'test-id', searchLanguages: [1] },
        },
      });
      return <IndexerFields selectedType="myanonamouse" register={register} errors={errors} watch={watch} setValue={setValue} />;
    }

    it('does not render language checkboxes for MAM indexer', () => {
      renderWithProviders(<MamFieldWrapperSimple />);
      expect(screen.queryByRole('checkbox', { name: /english/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('checkbox', { name: /french/i })).not.toBeInTheDocument();
    });
  });

  describe('#1156 — freeleech wedge fields', () => {
    function WedgeWrapper({ mode = 'never', reserve, status }: { mode?: 'never' | 'preferred' | 'required'; reserve?: number; status?: { isVip: boolean; mamUsername: string; classname?: string; wedges?: number } } = {}) {
      const { register, watch, setValue, formState: { errors } } = useForm<CreateIndexerFormData>({
        defaultValues: {
          name: '', type: 'myanonamouse', enabled: true, priority: 50,
          settings: {
            mamId: 'test-id', searchLanguages: [1], searchType: 'active',
            useFreeleechWedge: mode,
            ...(reserve !== undefined && { minWedgeReserve: reserve }),
            ...(status?.isVip !== undefined && { isVip: status.isVip }),
            ...(status?.mamUsername !== undefined && { mamUsername: status.mamUsername }),
            ...(status?.classname !== undefined && { classname: status.classname }),
          } as Record<string, unknown>,
        },
      });
      return (
        <IndexerFields
          selectedType="myanonamouse"
          register={register}
          errors={errors}
          watch={watch}
          setValue={setValue}
          {...(status?.wedges !== undefined ? { formTestResult: { success: true, metadata: { username: status.mamUsername, classname: status.classname, isVip: status.isVip, wedges: status.wedges } } } : {})}
        />
      );
    }

    it('does not render the Use Freeleech Wedges dropdown', () => {
      renderWithProviders(<WedgeWrapper mode="preferred" />);
      expect(screen.queryByLabelText('Use Freeleech Wedges')).not.toBeInTheDocument();
    });

    it('does not render the Minimum wedge reserve input', () => {
      renderWithProviders(<WedgeWrapper mode="preferred" reserve={3} />);
      expect(screen.queryByLabelText('Minimum wedge reserve')).not.toBeInTheDocument();
    });

    it('Test button result still populates the wedges row on the MAM account card', async () => {
      renderWithProviders(<WedgeWrapper status={{ isVip: false, mamUsername: 'TestUser', classname: 'User', wedges: 4 }} />);
      await waitFor(() => {
        expect(screen.getByText('TestUser')).toBeInTheDocument();
      });
      expect(screen.getByText('Wedges')).toBeInTheDocument();
      expect(screen.getByText('4')).toBeInTheDocument();
    });
  });
});
