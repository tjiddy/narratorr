import type { UseFormRegister, FieldErrors } from 'react-hook-form';
import type { CreateNotifierFormData } from '../../../shared/schemas.js';
import { SelectWithChevron } from './SelectWithChevron';

interface NotifierFieldsProps {
  selectedType: string;
  register: UseFormRegister<CreateNotifierFormData>;
  errors: FieldErrors<CreateNotifierFormData>;
}

const inputClass = 'w-full px-4 py-3 bg-background border border-border rounded-xl focus-ring focus:border-transparent transition-all';

function errorInputClass(hasError: boolean) {
  return `w-full px-4 py-3 bg-background border rounded-xl focus-ring focus:border-transparent transition-all ${hasError ? 'border-destructive' : 'border-border'}`;
}

function WebhookFields({ register, errors }: Omit<NotifierFieldsProps, 'selectedType'>) {
  return (
    <>
      <div className="sm:col-span-2">
        <label htmlFor="notifierUrl" className="block text-sm font-medium mb-2">URL</label>
        <input id="notifierUrl" type="text" {...register('settings.url')} className={errorInputClass(!!errors.settings?.url)} placeholder="https://example.com/webhook" />
        {errors.settings?.url && <p className="text-sm text-destructive mt-1">{errors.settings.url.message}</p>}
      </div>
      <div>
        <label htmlFor="notifierMethod" className="block text-sm font-medium mb-2">Method</label>
        <SelectWithChevron id="notifierMethod" {...register('settings.method')}>
          <option value="POST">POST</option>
          <option value="PUT">PUT</option>
        </SelectWithChevron>
      </div>
      <div>
        <label htmlFor="notifierHeaders" className="block text-sm font-medium mb-2">Headers (JSON)</label>
        <input id="notifierHeaders" type="text" {...register('settings.headers')} className={inputClass} placeholder='{"Authorization": "Bearer ..."}' />
        <p className="text-sm text-muted-foreground mt-1">Optional JSON key-value pairs</p>
      </div>
      <div className="sm:col-span-2">
        <label htmlFor="notifierBodyTemplate" className="block text-sm font-medium mb-2">Body Template</label>
        <textarea id="notifierBodyTemplate" {...register('settings.bodyTemplate')} className={`${inputClass} font-mono text-sm`} rows={3} placeholder='{"event": "{event}", "title": "{book.title}", "author": "{book.author}"}' />
        <p className="text-sm text-muted-foreground mt-1">
          Leave empty for default JSON. Tokens: {'{event}'}, {'{book.title}'}, {'{book.author}'}, {'{error.message}'}
        </p>
      </div>
    </>
  );
}

function DiscordFields({ register, errors }: Omit<NotifierFieldsProps, 'selectedType'>) {
  return (
    <>
      <div className="sm:col-span-2">
        <label htmlFor="notifierWebhookUrl" className="block text-sm font-medium mb-2">Webhook URL</label>
        <input id="notifierWebhookUrl" type="text" {...register('settings.webhookUrl')} className={errorInputClass(!!errors.settings?.webhookUrl)} placeholder="https://discord.com/api/webhooks/..." />
        {errors.settings?.webhookUrl && <p className="text-sm text-destructive mt-1">{errors.settings.webhookUrl.message}</p>}
      </div>
      <div>
        <label className="flex items-center gap-3 cursor-pointer">
          <input type="checkbox" {...register('settings.includeCover')} className="w-5 h-5 rounded border-border text-primary focus:ring-primary focus:ring-offset-0" />
          <span className="text-sm font-medium">Include Cover Image</span>
        </label>
      </div>
    </>
  );
}

function ScriptFields({ register, errors }: Omit<NotifierFieldsProps, 'selectedType'>) {
  return (
    <>
      <div className="sm:col-span-2">
        <label htmlFor="notifierScriptPath" className="block text-sm font-medium mb-2">Script Path</label>
        <input id="notifierScriptPath" type="text" {...register('settings.path')} className={errorInputClass(!!errors.settings?.path)} placeholder="/path/to/script.sh" />
        {errors.settings?.path && <p className="text-sm text-destructive mt-1">{errors.settings.path.message}</p>}
        <p className="text-sm text-muted-foreground mt-1">
          Event data passed as environment variables (NARRATORR_EVENT, NARRATORR_BOOK_TITLE, etc.) and JSON on stdin
        </p>
      </div>
      <div>
        <label htmlFor="notifierTimeout" className="block text-sm font-medium mb-2">Timeout (seconds)</label>
        <input id="notifierTimeout" type="number" {...register('settings.timeout', { valueAsNumber: true })} min={1} max={300} className={inputClass} />
      </div>
    </>
  );
}

function EmailFields({ register, errors }: Omit<NotifierFieldsProps, 'selectedType'>) {
  return (
    <>
      <div>
        <label htmlFor="notifierSmtpHost" className="block text-sm font-medium mb-2">SMTP Host</label>
        <input id="notifierSmtpHost" type="text" {...register('settings.smtpHost')} className={errorInputClass(!!errors.settings?.smtpHost)} placeholder="smtp.gmail.com" />
        {errors.settings?.smtpHost && <p className="text-sm text-destructive mt-1">{errors.settings.smtpHost.message}</p>}
      </div>
      <div>
        <label htmlFor="notifierSmtpPort" className="block text-sm font-medium mb-2">SMTP Port</label>
        <input id="notifierSmtpPort" type="number" {...register('settings.smtpPort', { valueAsNumber: true })} className={inputClass} placeholder="587" />
      </div>
      <div>
        <label htmlFor="notifierSmtpUser" className="block text-sm font-medium mb-2">Username</label>
        <input id="notifierSmtpUser" type="text" {...register('settings.smtpUser')} className={inputClass} placeholder="user@gmail.com" />
      </div>
      <div>
        <label htmlFor="notifierSmtpPass" className="block text-sm font-medium mb-2">Password</label>
        <input id="notifierSmtpPass" type="password" {...register('settings.smtpPass')} className={inputClass} />
      </div>
      <div>
        <label className="flex items-center gap-3 cursor-pointer">
          <input type="checkbox" {...register('settings.smtpTls')} className="w-5 h-5 rounded border-border text-primary focus:ring-primary focus:ring-offset-0" />
          <span className="text-sm font-medium">Use TLS/SSL</span>
        </label>
      </div>
      <div>
        <label htmlFor="notifierFromAddress" className="block text-sm font-medium mb-2">From Address</label>
        <input id="notifierFromAddress" type="email" {...register('settings.fromAddress')} className={errorInputClass(!!errors.settings?.fromAddress)} placeholder="narratorr@example.com" />
        {errors.settings?.fromAddress && <p className="text-sm text-destructive mt-1">{errors.settings.fromAddress.message}</p>}
      </div>
      <div className="sm:col-span-2">
        <label htmlFor="notifierToAddress" className="block text-sm font-medium mb-2">To Address</label>
        <input id="notifierToAddress" type="email" {...register('settings.toAddress')} className={errorInputClass(!!errors.settings?.toAddress)} placeholder="you@example.com" />
        {errors.settings?.toAddress && <p className="text-sm text-destructive mt-1">{errors.settings.toAddress.message}</p>}
      </div>
    </>
  );
}

function TelegramFields({ register, errors }: Omit<NotifierFieldsProps, 'selectedType'>) {
  return (
    <>
      <div className="sm:col-span-2">
        <label htmlFor="notifierBotToken" className="block text-sm font-medium mb-2">Bot Token</label>
        <input id="notifierBotToken" type="text" {...register('settings.botToken')} className={errorInputClass(!!errors.settings?.botToken)} placeholder="123456:ABC-DEF..." />
        {errors.settings?.botToken && <p className="text-sm text-destructive mt-1">{errors.settings.botToken.message}</p>}
      </div>
      <div className="sm:col-span-2">
        <label htmlFor="notifierChatId" className="block text-sm font-medium mb-2">Chat ID</label>
        <input id="notifierChatId" type="text" {...register('settings.chatId')} className={errorInputClass(!!errors.settings?.chatId)} placeholder="-1001234567890" />
        {errors.settings?.chatId && <p className="text-sm text-destructive mt-1">{errors.settings.chatId.message}</p>}
      </div>
    </>
  );
}

function SlackFields({ register, errors }: Omit<NotifierFieldsProps, 'selectedType'>) {
  return (
    <div className="sm:col-span-2">
      <label htmlFor="notifierSlackUrl" className="block text-sm font-medium mb-2">Webhook URL</label>
      <input id="notifierSlackUrl" type="text" {...register('settings.webhookUrl')} className={errorInputClass(!!errors.settings?.webhookUrl)} placeholder="https://hooks.slack.com/services/..." />
      {errors.settings?.webhookUrl && <p className="text-sm text-destructive mt-1">{errors.settings.webhookUrl.message}</p>}
    </div>
  );
}

function PushoverFields({ register, errors }: Omit<NotifierFieldsProps, 'selectedType'>) {
  return (
    <>
      <div>
        <label htmlFor="notifierPushoverToken" className="block text-sm font-medium mb-2">API Token</label>
        <input id="notifierPushoverToken" type="text" {...register('settings.pushoverToken')} className={errorInputClass(!!errors.settings?.pushoverToken)} placeholder="azGDORePK8gMa..." />
        {errors.settings?.pushoverToken && <p className="text-sm text-destructive mt-1">{errors.settings.pushoverToken.message}</p>}
      </div>
      <div>
        <label htmlFor="notifierPushoverUser" className="block text-sm font-medium mb-2">User Key</label>
        <input id="notifierPushoverUser" type="text" {...register('settings.pushoverUser')} className={errorInputClass(!!errors.settings?.pushoverUser)} placeholder="uQiRzpo4DXghD..." />
        {errors.settings?.pushoverUser && <p className="text-sm text-destructive mt-1">{errors.settings.pushoverUser.message}</p>}
      </div>
    </>
  );
}

function NtfyFields({ register, errors }: Omit<NotifierFieldsProps, 'selectedType'>) {
  return (
    <>
      <div>
        <label htmlFor="notifierNtfyTopic" className="block text-sm font-medium mb-2">Topic</label>
        <input id="notifierNtfyTopic" type="text" {...register('settings.ntfyTopic')} className={errorInputClass(!!errors.settings?.ntfyTopic)} placeholder="my-narratorr-alerts" />
        {errors.settings?.ntfyTopic && <p className="text-sm text-destructive mt-1">{errors.settings.ntfyTopic.message}</p>}
      </div>
      <div>
        <label htmlFor="notifierNtfyServer" className="block text-sm font-medium mb-2">Server URL</label>
        <input id="notifierNtfyServer" type="text" {...register('settings.ntfyServer')} className={inputClass} placeholder="https://ntfy.sh (default)" />
        <p className="text-sm text-muted-foreground mt-1">Leave empty for ntfy.sh</p>
      </div>
    </>
  );
}

function GotifyFields({ register, errors }: Omit<NotifierFieldsProps, 'selectedType'>) {
  return (
    <>
      <div>
        <label htmlFor="notifierGotifyUrl" className="block text-sm font-medium mb-2">Server URL</label>
        <input id="notifierGotifyUrl" type="text" {...register('settings.gotifyUrl')} className={errorInputClass(!!errors.settings?.gotifyUrl)} placeholder="https://gotify.example.com" />
        {errors.settings?.gotifyUrl && <p className="text-sm text-destructive mt-1">{errors.settings.gotifyUrl.message}</p>}
      </div>
      <div>
        <label htmlFor="notifierGotifyToken" className="block text-sm font-medium mb-2">App Token</label>
        <input id="notifierGotifyToken" type="text" {...register('settings.gotifyToken')} className={errorInputClass(!!errors.settings?.gotifyToken)} placeholder="AKxhJ3..." />
        {errors.settings?.gotifyToken && <p className="text-sm text-destructive mt-1">{errors.settings.gotifyToken.message}</p>}
      </div>
    </>
  );
}

const FIELD_COMPONENTS: Record<string, React.FC<Omit<NotifierFieldsProps, 'selectedType'>>> = {
  webhook: WebhookFields, discord: DiscordFields, script: ScriptFields,
  email: EmailFields, telegram: TelegramFields, slack: SlackFields,
  pushover: PushoverFields, ntfy: NtfyFields, gotify: GotifyFields,
};

export function NotifierFields({ selectedType, register, errors }: NotifierFieldsProps) {
  const Fields = FIELD_COMPONENTS[selectedType];
  if (!Fields) return null;
  return <Fields register={register} errors={errors} />;
}
