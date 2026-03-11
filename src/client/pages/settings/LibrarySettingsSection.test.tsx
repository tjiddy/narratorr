import { describe, it, expect, vi } from 'vitest';
import { screen, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm, useFormContext, FormProvider } from 'react-hook-form';
import { LibrarySettingsSection } from './LibrarySettingsSection';
import type { UpdateSettingsFormData } from '../../../shared/schemas.js';

vi.mock('../../../core/utils/index.js', () => ({
  renderTemplate: (template: string) => template.replace('{author}', 'Brandon Sanderson').replace('{authorLastFirst}', 'Sanderson, Brandon').replace('{title}', 'The Way of Kings').replace('{titleSort}', 'Way of Kings').replace('{narratorLastFirst}', 'Kramer, Michael & Reading, Kate'),
  renderFilename: (template: string) => template.replace('{author}', 'Brandon Sanderson').replace('{title}', 'The Way of Kings').replace('{trackNumber}', '1').replace('{trackTotal}', '12').replace('{partName}', 'The Way of Kings'),
  toLastFirst: (name: string) => name,
  toSortTitle: (title: string) => title,
  ALLOWED_TOKENS: ['author', 'authorLastFirst', 'title', 'titleSort', 'series', 'seriesPosition', 'year', 'narrator', 'narratorLastFirst'],
  FILE_ALLOWED_TOKENS: ['author', 'authorLastFirst', 'title', 'titleSort', 'series', 'seriesPosition', 'year', 'narrator', 'narratorLastFirst', 'trackNumber', 'trackTotal', 'partName'],
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
      search: { enabled: false, intervalMinutes: 360, blacklistTtlDays: 7 },
      library: { path: '/audiobooks', folderFormat: defaultFolderFormat, fileFormat: '{author} - {title}' },
      import: { deleteAfterImport: false, minSeedTime: 60 },
      general: { logLevel: 'info', housekeepingRetentionDays: 90, recycleRetentionDays: 30 },
      metadata: { audibleRegion: 'us' },
    },
  });
  return <FormProvider {...methods}>{children(methods)}</FormProvider>;
}

describe('LibrarySettingsSection', () => {
  it('renders fields and preview, then accepts path input', async () => {
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
    expect(screen.getByText('File Format')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('/audiobooks')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('{author}/{title}')).toHaveValue('{author}/{title}');
    expect(screen.getByPlaceholderText('{author} - {title}')).toHaveValue('{author} - {title}');

    // Token panels collapsed by default — buttons not visible
    expect(screen.queryByText('{series}')).not.toBeInTheDocument();

    // "Insert token" toggles visible for both panels
    const toggles = screen.getAllByText('Insert token');
    expect(toggles).toHaveLength(2);

    // Both preview lines present
    expect(screen.getByText('With series')).toBeInTheDocument();
    expect(screen.getByText('Without series')).toBeInTheDocument();

    // Interact with path input
    const pathInput = screen.getByPlaceholderText('/audiobooks');
    await user.clear(pathInput);
    await user.type(pathInput, '/new-lib');
    expect(pathInput).toHaveValue('/new-lib');
  });

  it('expands token panel and inserts a token when clicked', async () => {
    const user = userEvent.setup();

    function FolderFormatSpy() {
      const value = useFormContext<UpdateSettingsFormData>().watch('library.folderFormat');
      return <span data-testid="folder-format-spy">{value}</span>;
    }

    function WrapperWithSpy({ children }: { children: (props: ReturnType<typeof useForm<UpdateSettingsFormData>>) => React.ReactNode }) {
      const methods = useForm<UpdateSettingsFormData>({
        defaultValues: {
          search: { enabled: false, intervalMinutes: 360, blacklistTtlDays: 7 },
          library: { path: '/audiobooks', folderFormat: '{author}/{title}' },
          import: { deleteAfterImport: false, minSeedTime: 60 },
          general: { logLevel: 'info', housekeepingRetentionDays: 90, recycleRetentionDays: 30 },
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

    // Expand folder format token panel
    const toggles = screen.getAllByText('Insert token');
    await user.click(toggles[0]);

    // Token buttons now visible
    expect(screen.getAllByText('{series}').length).toBeGreaterThanOrEqual(1);

    await user.click(screen.getAllByText('{series}')[0]);

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

  it('renders file format field with file-specific tokens in expanded panel', async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        {({ register, formState: { errors }, setValue, watch }) => (
          <LibrarySettingsSection register={register} errors={errors} setValue={setValue} watch={watch} />
        )}
      </Wrapper>,
    );

    expect(screen.getByText('File Format')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('{author} - {title}')).toHaveValue('{author} - {title}');

    // Expand file format token panel (second toggle)
    const toggles = screen.getAllByText('Insert token');
    await user.click(toggles[1]);

    // File-specific tokens visible (highlighted separately)
    expect(screen.getAllByText('{trackNumber}').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('{trackTotal}').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('{partName}').length).toBeGreaterThanOrEqual(1);

    // Both preview lines present
    expect(screen.getByText('With series')).toBeInTheDocument();
    expect(screen.getByText('Without series')).toBeInTheDocument();
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
