import { describe, it, expect } from 'vitest';
import { screen, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm, FormProvider } from 'react-hook-form';
import { ImportSettingsSection } from './ImportSettingsSection';
import type { UpdateSettingsFormData } from '../../../shared/schemas.js';

function Wrapper({ children }: { children: (props: ReturnType<typeof useForm<UpdateSettingsFormData>>) => React.ReactNode }) {
  const methods = useForm<UpdateSettingsFormData>({
    defaultValues: {
      search: { enabled: false, intervalMinutes: 360, blacklistTtlDays: 7 },
      library: { path: '', folderFormat: '' },
      import: { deleteAfterImport: false, minSeedTime: 60, minFreeSpaceGB: 5 },
      general: { logLevel: 'info' },
      metadata: { audibleRegion: 'us' },
    },
  });
  return <FormProvider {...methods}>{children(methods)}</FormProvider>;
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
    expect(checkbox.checked).toBe(true);
  });

  it('renders minimum free space field', () => {
    render(
      <Wrapper>
        {({ register, formState: { errors } }) => (
          <ImportSettingsSection register={register} errors={errors} />
        )}
      </Wrapper>,
    );

    expect(screen.getByText('Minimum Free Space (GB)')).toBeInTheDocument();
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
    await user.clear(input);
    await user.type(input, '10');
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

    const seedTimeInput = screen.getByPlaceholderText('60');
    await user.clear(seedTimeInput);
    await user.type(seedTimeInput, '120');
    expect(seedTimeInput).toHaveValue(120);
  });
});
