import type { NotifierAdapter, NotificationEvent, EventPayload } from './types.js';

export interface DiscordConfig {
  webhookUrl: string;
  includeCover?: boolean;
}

const EVENT_COLORS: Record<NotificationEvent, number> = {
  on_grab: 0x3498db,           // blue
  on_download_complete: 0xf39c12, // orange
  on_import: 0x2ecc71,         // green
  on_failure: 0xe74c3c,        // red
};

const EVENT_TITLES: Record<NotificationEvent, string> = {
  on_grab: 'Release Grabbed',
  on_download_complete: 'Download Complete',
  on_import: 'Import Complete',
  on_failure: 'Failure',
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

    const response = await fetch(this.config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { success: false, message: `Discord error ${response.status}: ${text}` };
    }

    return { success: true };
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
