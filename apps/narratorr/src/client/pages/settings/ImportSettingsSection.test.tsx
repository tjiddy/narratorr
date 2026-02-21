import { describe, it, expect } from 'vitest';
import { screen, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm, FormProvider } from 'react-hook-form';
import { ImportSettingsSection } from './ImportSettingsSection';
import type { UpdateSettingsFormData } from '../../../shared/schemas.js';

function Wrapper({ children }: { children: (props: ReturnType<typeof useForm<UpdateSettingsFormData>>) => React.ReactNode }) {
  const methods = useForm<UpdateSettingsFormData>({
    defaultValues: {
      search: { enabled: false, intervalMinutes: 360, autoGrab: false },
      library: { path: '', folderFormat: '' },
      import: { deleteAfterImport: false, minSeedTime: 60 },
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
