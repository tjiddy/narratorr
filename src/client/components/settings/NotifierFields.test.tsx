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

  it('renders email fields with SMTP inputs', () => {
    render(<FieldWrapper type="email" />);
    expect(screen.getByText('SMTP Host')).toBeInTheDocument();
    expect(screen.getByText('SMTP Port')).toBeInTheDocument();
    expect(screen.getByText('Username')).toBeInTheDocument();
    expect(screen.getByText('Password')).toBeInTheDocument();
    expect(screen.getByText('Use TLS/SSL')).toBeInTheDocument();
    expect(screen.getByText('From Address')).toBeInTheDocument();
    expect(screen.getByText('To Address')).toBeInTheDocument();
  });

  it('renders telegram fields with bot token and chat ID', () => {
    render(<FieldWrapper type="telegram" />);
    expect(screen.getByText('Bot Token')).toBeInTheDocument();
    expect(screen.getByText('Chat ID')).toBeInTheDocument();
  });

  it('renders slack fields with webhook URL', () => {
    render(<FieldWrapper type="slack" />);
    expect(screen.getByText('Webhook URL')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('https://hooks.slack.com/services/...')).toBeInTheDocument();
  });

  it('renders pushover fields with token and user key', () => {
    render(<FieldWrapper type="pushover" />);
    expect(screen.getByText('API Token')).toBeInTheDocument();
    expect(screen.getByText('User Key')).toBeInTheDocument();
  });

  it('renders ntfy fields with topic and optional server', () => {
    render(<FieldWrapper type="ntfy" />);
    expect(screen.getByText('Topic')).toBeInTheDocument();
    expect(screen.getByText('Server URL')).toBeInTheDocument();
  });

  it('renders gotify fields with server URL and app token', () => {
    render(<FieldWrapper type="gotify" />);
    expect(screen.getByText('Server URL')).toBeInTheDocument();
    expect(screen.getByText('App Token')).toBeInTheDocument();
  });

  it('renders nothing for unknown type', () => {
    const { container } = render(<FieldWrapper type="unknown" />);
    expect(container).toBeEmptyDOMElement();
  });
});
