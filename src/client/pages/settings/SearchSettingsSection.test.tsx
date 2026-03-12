import { describe, it, expect, vi } from 'vitest';
import { screen, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm, FormProvider } from 'react-hook-form';
import { SearchSettingsSection } from './SearchSettingsSection';
import type { UpdateSettingsFormData } from '../../../shared/schemas.js';

const defaultValues: UpdateSettingsFormData = {
  search: { enabled: false, intervalMinutes: 360, blacklistTtlDays: 7 },
  rss: { enabled: false, intervalMinutes: 30 },
  library: { path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' },
  import: { deleteAfterImport: false, minSeedTime: 60 },
  general: { logLevel: 'info', housekeepingRetentionDays: 90, recycleRetentionDays: 30 },
  metadata: { audibleRegion: 'us' },
} as UpdateSettingsFormData;

function Wrapper({
  onSubmit,
  children,
}: {
  onSubmit?: (data: UpdateSettingsFormData) => void;
  children: (props: ReturnType<typeof useForm<UpdateSettingsFormData>>) => React.ReactNode;
}) {
  const methods = useForm<UpdateSettingsFormData>({ defaultValues });
  return (
    <FormProvider {...methods}>
      <form onSubmit={methods.handleSubmit(onSubmit ?? (() => {}))}>
        {children(methods)}
        <button type="submit">Save</button>
      </form>
    </FormProvider>
  );
}

describe('SearchSettingsSection', () => {
  it('renders search fields', () => {
    render(
      <Wrapper>
        {({ register, formState: { errors } }) => (
          <SearchSettingsSection register={register} errors={errors} />
        )}
      </Wrapper>,
    );

    expect(screen.getByText('Enable Scheduled Search')).toBeInTheDocument();
    expect(screen.getByText('Search Interval (minutes)')).toBeInTheDocument();
    expect(screen.queryByText('Auto-Grab Best Result')).not.toBeInTheDocument();
  });

  it('toggles search enabled checkbox', async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        {({ register, formState: { errors } }) => (
          <SearchSettingsSection register={register} errors={errors} />
        )}
      </Wrapper>,
    );

    const checkbox = () => screen.getByText('Enable Scheduled Search')
      .closest('div')!.parentElement!.querySelector('input[type="checkbox"]') as HTMLInputElement;

    expect(checkbox().checked).toBe(false);
    await user.click(checkbox());
    expect(checkbox().checked).toBe(true);
  });

  it('RSS toggle renders and persists state', async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        {({ register, formState: { errors } }) => (
          <SearchSettingsSection register={register} errors={errors} />
        )}
      </Wrapper>,
    );

    expect(screen.getByText('Enable RSS Sync')).toBeInTheDocument();

    const rssCheckbox = screen.getByText('Enable RSS Sync')
      .closest('div')!.parentElement!.querySelector('input[type="checkbox"]') as HTMLInputElement;

    expect(rssCheckbox.checked).toBe(false);
    await user.click(rssCheckbox);
    await waitFor(() => {
      expect(rssCheckbox.checked).toBe(true);
    });
  });

  it('RSS interval input renders', () => {
    render(
      <Wrapper>
        {({ register, formState: { errors } }) => (
          <SearchSettingsSection register={register} errors={errors} />
        )}
      </Wrapper>,
    );

    expect(screen.getByText('RSS Interval (minutes)')).toBeInTheDocument();
  });

  it('both search and RSS controls exist', () => {
    render(
      <Wrapper>
        {({ register, formState: { errors } }) => (
          <SearchSettingsSection register={register} errors={errors} />
        )}
      </Wrapper>,
    );

    expect(screen.getByText('Enable Scheduled Search')).toBeInTheDocument();
    expect(screen.getByText('Enable RSS Sync')).toBeInTheDocument();
  });

  it('describes that search includes grabbing', () => {
    render(
      <Wrapper>
        {({ register, formState: { errors } }) => (
          <SearchSettingsSection register={register} errors={errors} />
        )}
      </Wrapper>,
    );

    expect(screen.getByText(/grab the best result/)).toBeInTheDocument();
  });

  it('renders blacklist TTL input', () => {
    render(
      <Wrapper>
        {({ register, formState: { errors } }) => (
          <SearchSettingsSection register={register} errors={errors} />
        )}
      </Wrapper>,
    );

    expect(screen.getByText('Blacklist TTL (days)')).toBeInTheDocument();
  });

  it('has min=1 attribute on blacklist TTL', () => {
    render(
      <Wrapper>
        {({ register, formState: { errors } }) => (
          <SearchSettingsSection register={register} errors={errors} />
        )}
      </Wrapper>,
    );

    expect(screen.getByLabelText('Blacklist TTL (days)')).toHaveAttribute('min', '1');
  });

  it('sends search and rss categories on save', async () => {
    const onSubmit = vi.fn();
    render(
      <Wrapper onSubmit={onSubmit}>
        {({ register, formState: { errors } }) => (
          <SearchSettingsSection register={register} errors={errors} />
        )}
      </Wrapper>,
    );

    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          search: { enabled: false, intervalMinutes: 360, blacklistTtlDays: 7 },
          rss: { enabled: false, intervalMinutes: 30 },
        }),
        expect.anything(),
      );
    });
  });
});
