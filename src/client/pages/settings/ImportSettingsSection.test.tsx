import { describe, it, expect, vi } from 'vitest';
import { screen, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm, FormProvider } from 'react-hook-form';
import { ImportSettingsSection } from './ImportSettingsSection';
import type { UpdateSettingsFormData } from '../../../shared/schemas.js';

const defaultValues: UpdateSettingsFormData = {
  search: { enabled: false, intervalMinutes: 360, blacklistTtlDays: 7 },
  rss: { enabled: false, intervalMinutes: 30 },
  library: { path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' },
  import: { deleteAfterImport: false, minSeedTime: 60, minFreeSpaceGB: 5 },
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

describe('ImportSettingsSection', () => {
  it('renders all import fields and toggles delete checkbox', async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        {({ register, formState: { errors } }) => (
          <ImportSettingsSection register={register} errors={errors} />
        )}
      </Wrapper>,
    );

    expect(screen.getByText('Delete After Import')).toBeInTheDocument();
    expect(screen.getByText('Minimum Seed Time (minutes)')).toBeInTheDocument();

    const checkbox = screen.getByText('Delete After Import')
      .closest('div')!.parentElement!.querySelector('input[type="checkbox"]') as HTMLInputElement;

    expect(checkbox.checked).toBe(false);
    await user.click(checkbox);
    await waitFor(() => {
      expect(checkbox.checked).toBe(true);
    });
  });

  it('renders minimum free space field with value from settings', () => {
    render(
      <Wrapper>
        {({ register, formState: { errors } }) => (
          <ImportSettingsSection register={register} errors={errors} />
        )}
      </Wrapper>,
    );

    expect(screen.getByLabelText('Minimum Free Space (GB)')).toHaveValue(5);
  });

  it('allows changing minimum free space value', async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        {({ register, formState: { errors } }) => (
          <ImportSettingsSection register={register} errors={errors} />
        )}
      </Wrapper>,
    );

    const input = screen.getByLabelText('Minimum Free Space (GB)');
    expect(input).toHaveValue(5);
    await user.tripleClick(input);
    await user.keyboard('10');
    expect(input).toHaveValue(10);
  });

  it('shows helper text for free space field', () => {
    render(
      <Wrapper>
        {({ register, formState: { errors } }) => (
          <ImportSettingsSection register={register} errors={errors} />
        )}
      </Wrapper>,
    );

    expect(screen.getByText(/Set to 0 to disable/)).toBeInTheDocument();
  });

  it('allows changing the minimum seed time', async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        {({ register, formState: { errors } }) => (
          <ImportSettingsSection register={register} errors={errors} />
        )}
      </Wrapper>,
    );

    const seedTimeInput = screen.getByLabelText('Minimum Seed Time (minutes)');
    expect(seedTimeInput).toHaveValue(60);
    await user.tripleClick(seedTimeInput);
    await user.keyboard('120');
    expect(seedTimeInput).toHaveValue(120);
  });

  it('sends import category payload on save', async () => {
    const onSubmit = vi.fn();
    render(
      <Wrapper onSubmit={onSubmit}>
        {({ register, formState: { errors } }) => (
          <ImportSettingsSection register={register} errors={errors} />
        )}
      </Wrapper>,
    );

    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          import: { deleteAfterImport: false, minSeedTime: 60, minFreeSpaceGB: 5 },
        }),
        expect.anything(),
      );
    });
  });
});
