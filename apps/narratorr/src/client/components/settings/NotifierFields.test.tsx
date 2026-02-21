import { describe, it, expect } from 'vitest';
import { screen, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm } from 'react-hook-form';
import { NotifierFields } from './NotifierFields';
import type { CreateNotifierFormData } from '../../../shared/schemas.js';

function FieldWrapper({ type }: { type: string }) {
  const { register, formState: { errors } } = useForm<CreateNotifierFormData>({
    defaultValues: { name: '', type: 'webhook', events: [], settings: {} },
  });
  return <NotifierFields selectedType={type} register={register} errors={errors} />;
}

describe('NotifierFields', () => {
  it('renders webhook fields and accepts URL input', async () => {
    const user = userEvent.setup();
    render(<FieldWrapper type="webhook" />);

    expect(screen.getByText('URL')).toBeInTheDocument();
    expect(screen.getByText('Method')).toBeInTheDocument();
    expect(screen.getByText('Headers (JSON)')).toBeInTheDocument();
    expect(screen.getByText('Body Template')).toBeInTheDocument();

    const url = screen.getByPlaceholderText('https://example.com/webhook');
    await user.type(url, 'https://hooks.test.com');
    expect(url).toHaveValue('https://hooks.test.com');
  });

  it('renders discord fields and accepts webhook URL input', async () => {
    const user = userEvent.setup();
    render(<FieldWrapper type="discord" />);

    expect(screen.getByText('Webhook URL')).toBeInTheDocument();
    expect(screen.getByText('Include Cover Image')).toBeInTheDocument();
    expect(screen.queryByText('Method')).not.toBeInTheDocument();

    const webhookUrl = screen.getByPlaceholderText('https://discord.com/api/webhooks/...');
    await user.type(webhookUrl, 'https://discord.com/api/webhooks/123');
    expect(webhookUrl).toHaveValue('https://discord.com/api/webhooks/123');
  });

  it('renders script fields and accepts path input', async () => {
    const user = userEvent.setup();
    render(<FieldWrapper type="script" />);

    expect(screen.getByText('Script Path')).toBeInTheDocument();
    expect(screen.getByText('Timeout (seconds)')).toBeInTheDocument();
    expect(screen.queryByText('URL')).not.toBeInTheDocument();

    const path = screen.getByPlaceholderText('/path/to/script.sh');
    await user.type(path, '/opt/notify.sh');
    expect(path).toHaveValue('/opt/notify.sh');
  });

  it('renders nothing for unknown type', () => {
    const { container } = render(<FieldWrapper type="unknown" />);
    expect(container.innerHTML).toBe('');
  });
});
