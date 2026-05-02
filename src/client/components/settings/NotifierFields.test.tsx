import { describe, it, expect } from 'vitest';
import { screen, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm } from 'react-hook-form';
import { useEffect } from 'react';
import { NotifierFields } from './NotifierFields';
import type { CreateNotifierFormData } from '../../../shared/schemas.js';
import type { NotifierType } from '../../../shared/notifier-registry.js';

function FieldWrapper({ type }: { type: NotifierType }) {
  const { register, formState: { errors } } = useForm<CreateNotifierFormData>({
    defaultValues: { name: '', type: 'webhook', events: [], settings: {} },
  });
  return <NotifierFields selectedType={type} register={register} errors={errors} />;
}

/** Wrapper that injects form errors for specific settings fields */
function ErrorFieldWrapper({ type, errorFields }: { type: NotifierType; errorFields: string[] }) {
  const { register, formState: { errors }, setError } = useForm<CreateNotifierFormData>({
    defaultValues: { name: '', type: 'webhook', events: [], settings: {} },
  });

  useEffect(() => {
    for (const field of errorFields) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setError(`settings.${field}` as any, { type: 'manual', message: `${field} is required` });
    }
  }, [setError, errorFields]);

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

  it('webhook method select uses shared SelectWithChevron contract', async () => {
    const user = userEvent.setup();
    render(<FieldWrapper type="webhook" />);

    const select = screen.getByLabelText('Method') as HTMLSelectElement;
    expect(select).toHaveClass('appearance-none');
    expect(select.parentElement!.querySelector('svg')).toBeInTheDocument();
    expect(select.value).toBe('POST');
    await user.selectOptions(select, 'PUT');
    expect(select.value).toBe('PUT');
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

  it('script timeout input uses integer step', () => {
    render(<FieldWrapper type="script" />);
    expect(screen.getByLabelText('Timeout (seconds)').getAttribute('step')).toBe('1');
  });

  it('email SMTP port input uses integer step', () => {
    render(<FieldWrapper type="email" />);
    expect(screen.getByLabelText('SMTP Port').getAttribute('step')).toBe('1');
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

  describe('error state rendering (#201)', () => {
    it('webhook: shows error message for settings.url validation failure', () => {
      render(<ErrorFieldWrapper type="webhook" errorFields={['url']} />);

      const urlInput = screen.getByPlaceholderText('https://example.com/webhook');
      expect(urlInput.className).toContain('border-destructive');
      expect(screen.getByText('url is required')).toBeInTheDocument();
    });

    it('discord: shows error message for settings.webhookUrl validation failure', () => {
      render(<ErrorFieldWrapper type="discord" errorFields={['webhookUrl']} />);

      const input = screen.getByPlaceholderText('https://discord.com/api/webhooks/...');
      expect(input.className).toContain('border-destructive');
      expect(screen.getByText('webhookUrl is required')).toBeInTheDocument();
    });

    it('script: shows error message for settings.path validation failure', () => {
      render(<ErrorFieldWrapper type="script" errorFields={['path']} />);

      const input = screen.getByPlaceholderText('/path/to/script.sh');
      expect(input.className).toContain('border-destructive');
      expect(screen.getByText('path is required')).toBeInTheDocument();
    });

    it('email: shows error messages for settings.smtpHost, settings.fromAddress, settings.toAddress', () => {
      render(<ErrorFieldWrapper type="email" errorFields={['smtpHost', 'fromAddress', 'toAddress']} />);

      expect(screen.getByPlaceholderText('smtp.gmail.com').className).toContain('border-destructive');
      expect(screen.getByText('smtpHost is required')).toBeInTheDocument();

      expect(screen.getByPlaceholderText('narratorr@example.com').className).toContain('border-destructive');
      expect(screen.getByText('fromAddress is required')).toBeInTheDocument();

      expect(screen.getByPlaceholderText('you@example.com').className).toContain('border-destructive');
      expect(screen.getByText('toAddress is required')).toBeInTheDocument();
    });

    it('telegram: shows error messages for settings.botToken, settings.chatId', () => {
      render(<ErrorFieldWrapper type="telegram" errorFields={['botToken', 'chatId']} />);

      expect(screen.getByPlaceholderText('123456:ABC-DEF...').className).toContain('border-destructive');
      expect(screen.getByText('botToken is required')).toBeInTheDocument();

      expect(screen.getByPlaceholderText('-1001234567890').className).toContain('border-destructive');
      expect(screen.getByText('chatId is required')).toBeInTheDocument();
    });

    it('slack: shows error message for settings.webhookUrl validation failure', () => {
      render(<ErrorFieldWrapper type="slack" errorFields={['webhookUrl']} />);

      expect(screen.getByPlaceholderText('https://hooks.slack.com/services/...').className).toContain('border-destructive');
      expect(screen.getByText('webhookUrl is required')).toBeInTheDocument();
    });

    it('pushover: shows error messages for settings.pushoverToken, settings.pushoverUser', () => {
      render(<ErrorFieldWrapper type="pushover" errorFields={['pushoverToken', 'pushoverUser']} />);

      expect(screen.getByPlaceholderText('azGDORePK8gMa...').className).toContain('border-destructive');
      expect(screen.getByText('pushoverToken is required')).toBeInTheDocument();

      expect(screen.getByPlaceholderText('uQiRzpo4DXghD...').className).toContain('border-destructive');
      expect(screen.getByText('pushoverUser is required')).toBeInTheDocument();
    });

    it('ntfy: shows error message for settings.ntfyTopic validation failure', () => {
      render(<ErrorFieldWrapper type="ntfy" errorFields={['ntfyTopic']} />);

      expect(screen.getByPlaceholderText('my-narratorr-alerts').className).toContain('border-destructive');
      expect(screen.getByText('ntfyTopic is required')).toBeInTheDocument();
    });

    it('gotify: shows error messages for settings.gotifyUrl, settings.gotifyToken', () => {
      render(<ErrorFieldWrapper type="gotify" errorFields={['gotifyUrl', 'gotifyToken']} />);

      expect(screen.getByPlaceholderText('https://gotify.example.com').className).toContain('border-destructive');
      expect(screen.getByText('gotifyUrl is required')).toBeInTheDocument();

      expect(screen.getByPlaceholderText('AKxhJ3...').className).toContain('border-destructive');
      expect(screen.getByText('gotifyToken is required')).toBeInTheDocument();
    });
  });
});
