import type { NotifierAdapter, NotificationEvent, EventPayload } from './types.js';
import { EVENT_TITLES } from '../../shared/notification-events.js';
import { fetchWithTimeout } from '../utils/network-service.js';
import { NOTIFIER_TIMEOUT_MS } from '../utils/constants.js';
import { getErrorMessage } from '../../shared/error-message.js';

export interface DiscordConfig {
  webhookUrl: string;
  includeCover?: boolean;
}

const EVENT_COLORS: Record<NotificationEvent, number> = {
  on_grab: 0x3498db,           // blue
  on_download_complete: 0xf39c12, // orange
  on_import: 0x2ecc71,         // green
  on_failure: 0xe74c3c,        // red
  on_upgrade: 0x9b59b6,       // purple
  on_health_issue: 0xe67e22,   // dark orange
};

// eslint-disable-next-line complexity -- event-specific embed field building
function buildEmbed(event: NotificationEvent, payload: EventPayload, includeCover: boolean) {
  const fields: { name: string; value: string; inline?: boolean }[] = [];

  if (payload.book?.title) {
    fields.push({ name: 'Book', value: payload.book.title, inline: true });
  }
  if (payload.book?.author) {
    fields.push({ name: 'Author', value: payload.book.author, inline: true });
  }

  if (event === 'on_grab') {
    if (payload.release?.indexer) {
      fields.push({ name: 'Indexer', value: payload.release.indexer, inline: true });
    }
    if (payload.release?.title) {
      fields.push({ name: 'Release', value: payload.release.title });
    }
  }

  if (event === 'on_download_complete' && payload.download?.path) {
    fields.push({ name: 'Path', value: payload.download.path });
  }

  if (event === 'on_import') {
    if (payload.import?.libraryPath) {
      fields.push({ name: 'Library Path', value: payload.import.libraryPath });
    }
    if (payload.import?.fileCount) {
      fields.push({ name: 'Files', value: payload.import.fileCount.toString(), inline: true });
    }
  }

  if (event === 'on_failure' && payload.error) {
    fields.push({ name: 'Error', value: payload.error.message });
    if (payload.error.stage) {
      fields.push({ name: 'Stage', value: payload.error.stage, inline: true });
    }
  }

  if (event === 'on_upgrade' && payload.upgrade) {
    const prev = `${payload.upgrade.previousMbPerHour.toFixed(1)} MB/hr${payload.upgrade.previousCodec ? ` (${payload.upgrade.previousCodec.toUpperCase()})` : ''}`;
    const next = `${payload.upgrade.newMbPerHour.toFixed(1)} MB/hr${payload.upgrade.newCodec ? ` (${payload.upgrade.newCodec.toUpperCase()})` : ''}`;
    fields.push({ name: 'Previous', value: prev, inline: true });
    fields.push({ name: 'New', value: next, inline: true });
  }

  if (event === 'on_health_issue' && payload.health) {
    fields.push({ name: 'Check', value: payload.health.checkName, inline: true });
    fields.push({ name: 'State', value: `${payload.health.previousState} → ${payload.health.currentState}`, inline: true });
    if (payload.health.message) {
      fields.push({ name: 'Detail', value: payload.health.message });
    }
  }

  const embed: Record<string, unknown> = {
    title: EVENT_TITLES[event],
    color: EVENT_COLORS[event],
    fields,
    timestamp: new Date().toISOString(),
    footer: { text: 'Narratorr' },
  };

  if (includeCover && payload.book?.coverUrl) {
    embed.thumbnail = { url: payload.book.coverUrl };
  }

  return embed;
}

export class DiscordNotifier implements NotifierAdapter {
  readonly type = 'discord';

  constructor(private config: DiscordConfig) {}

  async send(event: NotificationEvent, payload: EventPayload): Promise<{ success: boolean; message?: string }> {
    const embed = buildEmbed(event, payload, this.config.includeCover ?? true);

    try {
      const response = await fetchWithTimeout(this.config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] }),
      }, NOTIFIER_TIMEOUT_MS);

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return { success: false, message: `Discord error ${response.status}: ${text}` };
      }

      return { success: true };
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        return { success: false, message: 'Request timed out' };
      }
      return { success: false, message: getErrorMessage(error) };
    }
  }

  async test(): Promise<{ success: boolean; message?: string }> {
    const testPayload: EventPayload = {
      event: 'on_grab',
      book: { title: 'Test Book', author: 'Test Author' },
      release: { title: 'Test Release', indexer: 'Test Indexer', size: 512_000_000 },
    };

    return this.send('on_grab', testPayload);
  }
}
