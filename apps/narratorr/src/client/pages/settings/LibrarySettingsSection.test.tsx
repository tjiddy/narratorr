import { describe, it, expect, vi } from 'vitest';
import { screen, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm, useFormContext, FormProvider } from 'react-hook-form';
import { LibrarySettingsSection } from './LibrarySettingsSection';
import type { UpdateSettingsFormData } from '../../../shared/schemas.js';

vi.mock('@narratorr/core/utils', () => ({
  renderTemplate: (template: string) => template.replace('{author}', 'Brandon Sanderson').replace('{title}', 'The Way of Kings'),
  ALLOWED_TOKENS: ['author', 'title', 'series', 'seriesPosition', 'year', 'narrator'],
}));

function Wrapper({
  defaultFolderFormat = '{author}/{title}',
  children,
}: {
  defaultFolderFormat?: string;
  children: (props: ReturnType<typeof useForm<UpdateSettingsFormData>>) => React.ReactNode;
}) {
  const methods = useForm<UpdateSettingsFormData>({
    defaultValues: {
      search: { enabled: false, intervalMinutes: 360, autoGrab: false },
      library: { path: '/audiobooks', folderFormat: defaultFolderFormat },
      import: { deleteAfterImport: false, minSeedTime: 60 },
      general: { logLevel: 'info' },
      metadata: { audibleRegion: 'us' },
    },
  });
  return <FormProvider {...methods}>{children(methods)}</FormProvider>;
}

describe('LibrarySettingsSection', () => {
  it('renders fields, tokens, and preview, then accepts path input', async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        {({ register, formState: { errors }, setValue, watch }) => (
          <LibrarySettingsSection register={register} errors={errors} setValue={setValue} watch={watch} />
        )}
      </Wrapper>,
    );

    // Fields present
    expect(screen.getByText('Library Path')).toBeInTheDocument();
    expect(screen.getByText('Folder Format')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('/audiobooks')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('{author}/{title}')).toHaveValue('{author}/{title}');

    // Token buttons present
    expect(screen.getByText('{author}')).toBeInTheDocument();
    expect(screen.getByText('{title}')).toBeInTheDocument();
    expect(screen.getByText('{series}')).toBeInTheDocument();

    // Preview present
    expect(screen.getByText('Preview')).toBeInTheDocument();
    expect(screen.getByText('Brandon Sanderson/The Way of Kings')).toBeInTheDocument();

    // Interact with path input
    const pathInput = screen.getByPlaceholderText('/audiobooks');
    await user.clear(pathInput);
    await user.type(pathInput, '/new-lib');
    expect(pathInput).toHaveValue('/new-lib');
  });

  it('inserts a token when a token button is clicked', async () => {
    const user = userEvent.setup();

    // Spy component reads RHF state so we can assert on it
    function FolderFormatSpy() {
      const value = useFormContext<UpdateSettingsFormData>().watch('library.folderFormat');
      return <span data-testid="folder-format-spy">{value}</span>;
    }

    function WrapperWithSpy({ children }: { children: (props: ReturnType<typeof useForm<UpdateSettingsFormData>>) => React.ReactNode }) {
      const methods = useForm<UpdateSettingsFormData>({
        defaultValues: {
          search: { enabled: false, intervalMinutes: 360, autoGrab: false },
          library: { path: '/audiobooks', folderFormat: '{author}/{title}' },
          import: { deleteAfterImport: false, minSeedTime: 60 },
          general: { logLevel: 'info' },
          metadata: { audibleRegion: 'us' },
        },
      });
      return (
        <FormProvider {...methods}>
          {children(methods)}
          <FolderFormatSpy />
        </FormProvider>
      );
    }

    render(
      <WrapperWithSpy>
        {({ register, formState: { errors }, setValue, watch }) => (
          <LibrarySettingsSection register={register} errors={errors} setValue={setValue} watch={watch} />
        )}
      </WrapperWithSpy>,
    );

    await user.click(screen.getByText('{series}'));

    // setValue updates RHF internal state — spy component watches the value
    await waitFor(() => {
      expect(screen.getByTestId('folder-format-spy')).toHaveTextContent('{series}');
    });
  });

  it('shows warning when title token is missing', () => {
    render(
      <Wrapper defaultFolderFormat="{author}/books">
        {({ register, formState: { errors }, setValue, watch }) => (
          <LibrarySettingsSection register={register} errors={errors} setValue={setValue} watch={watch} />
        )}
      </Wrapper>,
    );

    expect(screen.getByText(/Template must include/)).toBeInTheDocument();
  });

  it('shows author suggestion when title is present but author is missing', () => {
    render(
      <Wrapper defaultFolderFormat="{title}">
        {({ register, formState: { errors }, setValue, watch }) => (
          <LibrarySettingsSection register={register} errors={errors} setValue={setValue} watch={watch} />
        )}
      </Wrapper>,
    );

    expect(screen.getByText(/Consider including/)).toBeInTheDocument();
  });

});
