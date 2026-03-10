import { describe, it, expect } from 'vitest';
import { screen, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm, FormProvider } from 'react-hook-form';
import { SearchSettingsSection } from './SearchSettingsSection';
import type { UpdateSettingsFormData } from '../../../shared/schemas.js';

function Wrapper({ children }: { children: (props: ReturnType<typeof useForm<UpdateSettingsFormData>>) => React.ReactNode }) {
  const methods = useForm<UpdateSettingsFormData>({
    defaultValues: {
      search: { enabled: false, intervalMinutes: 360, blacklistTtlDays: 7 },
      library: { path: '', folderFormat: '' },
      import: { deleteAfterImport: false, minSeedTime: 60 },
      general: { logLevel: 'info', housekeepingRetentionDays: 90 },
      metadata: { audibleRegion: 'us' },
      rss: { enabled: false, intervalMinutes: 30 },
    },
  });
  return <FormProvider {...methods}>{children(methods)}</FormProvider>;
}

describe('SearchSettingsSection', () => {
  it('renders search fields without auto-grab toggle', async () => {
    const user = userEvent.setup();

    render(
      <Wrapper>
        {({ register, formState: { errors } }) => (
          <SearchSettingsSection register={register} errors={errors} />
        )}
      </Wrapper>,
    );

    expect(screen.getByText('Enable Scheduled Search')).toBeInTheDocument();
    expect(screen.getByText('Search Interval (minutes)')).toBeInTheDocument();
    // Auto-grab toggle should not exist — grabbing is always part of searching
    expect(screen.queryByText('Auto-Grab Best Result')).not.toBeInTheDocument();

    const checkbox = screen.getByText('Enable Scheduled Search')
      .closest('div')!.parentElement!.querySelector('input[type="checkbox"]') as HTMLInputElement;

    expect(checkbox.checked).toBe(false);
    await user.click(checkbox);
    expect(checkbox.checked).toBe(true);
  });

  it('allows changing the search interval', async () => {
    const user = userEvent.setup();

    render(
      <Wrapper>
        {({ register, formState: { errors } }) => (
          <SearchSettingsSection register={register} errors={errors} />
        )}
      </Wrapper>,
    );

    const intervalInput = screen.getByPlaceholderText('360');
    await user.clear(intervalInput);
    await user.type(intervalInput, '120');
    expect(intervalInput).toHaveValue(120);
  });

  it('RSS toggle renders and persists enable/disable state', async () => {
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
    expect(rssCheckbox.checked).toBe(true);
  });

  it('RSS interval input renders and accepts value', async () => {
    const user = userEvent.setup();

    render(
      <Wrapper>
        {({ register, formState: { errors } }) => (
          <SearchSettingsSection register={register} errors={errors} />
        )}
      </Wrapper>,
    );

    expect(screen.getByText('RSS Interval (minutes)')).toBeInTheDocument();
    const rssIntervalInput = screen.getByPlaceholderText('30');
    await user.clear(rssIntervalInput);
    await user.type(rssIntervalInput, '60');
    expect(rssIntervalInput).toHaveValue(60);
  });

  it('RSS controls are separate from existing scheduled search controls', () => {
    render(
      <Wrapper>
        {({ register, formState: { errors } }) => (
          <SearchSettingsSection register={register} errors={errors} />
        )}
      </Wrapper>,
    );

    // Both search and RSS toggles exist
    expect(screen.getByText('Enable Scheduled Search')).toBeInTheDocument();
    expect(screen.getByText('Enable RSS Sync')).toBeInTheDocument();

    // Both interval inputs exist
    expect(screen.getByPlaceholderText('360')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('30')).toBeInTheDocument();
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

  describe('Blacklist TTL setting', () => {
    it('renders TTL input field with label and default value', () => {
      render(
        <Wrapper>
          {({ register, formState: { errors } }) => (
            <SearchSettingsSection register={register} errors={errors} />
          )}
        </Wrapper>,
      );

      expect(screen.getByText('Blacklist TTL (days)')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('7')).toBeInTheDocument();
    });

    it('accepts positive integer value for TTL days', async () => {
      const user = userEvent.setup();

      render(
        <Wrapper>
          {({ register, formState: { errors } }) => (
            <SearchSettingsSection register={register} errors={errors} />
          )}
        </Wrapper>,
      );

      const ttlInput = screen.getByPlaceholderText('7');
      await user.clear(ttlInput);
      await user.type(ttlInput, '14');
      expect(ttlInput).toHaveValue(14);
    });

    it('has min=1 attribute to prevent TTL < 1', () => {
      render(
        <Wrapper>
          {({ register, formState: { errors } }) => (
            <SearchSettingsSection register={register} errors={errors} />
          )}
        </Wrapper>,
      );

      const ttlInput = screen.getByPlaceholderText('7');
      expect(ttlInput).toHaveAttribute('min', '1');
    });
  });
});
