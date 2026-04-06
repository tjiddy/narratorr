import type React from 'react';
import type { NotifierFieldProps } from './components.js';
import {
  WebhookFields, DiscordFields, ScriptFields, EmailFields,
  TelegramFields, SlackFields, PushoverFields, NtfyFields, GotifyFields,
} from './components.js';

export type { NotifierFieldProps } from './components.js';

export const NOTIFIER_FIELD_COMPONENTS: Record<string, React.FC<NotifierFieldProps>> = {
  webhook: WebhookFields, discord: DiscordFields, script: ScriptFields,
  email: EmailFields, telegram: TelegramFields, slack: SlackFields,
  pushover: PushoverFields, ntfy: NtfyFields, gotify: GotifyFields,
};
