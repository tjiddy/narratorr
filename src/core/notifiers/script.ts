import { execFile } from 'node:child_process';
import type { NotifierAdapter, NotificationEvent, EventPayload } from './types.js';

export interface ScriptConfig {
  path: string;
  timeout?: number; // seconds, default 30
}

// eslint-disable-next-line complexity -- flat env construction from event-specific payload fields
function payloadToEnv(event: NotificationEvent, payload: EventPayload): Record<string, string> {
  const env: Record<string, string> = {
    NARRATORR_EVENT: event,
  };

  if (payload.book) {
    if (payload.book.title) env.NARRATORR_BOOK_TITLE = payload.book.title;
    if (payload.book.author) env.NARRATORR_BOOK_AUTHOR = payload.book.author;
    if (payload.book.coverUrl) env.NARRATORR_BOOK_COVER_URL = payload.book.coverUrl;
  }
  if (payload.release) {
    if (payload.release.title) env.NARRATORR_RELEASE_TITLE = payload.release.title;
    if (payload.release.indexer) env.NARRATORR_RELEASE_INDEXER = payload.release.indexer;
    if (payload.release.size != null) env.NARRATORR_RELEASE_SIZE = payload.release.size.toString();
  }
  if (payload.download) {
    if (payload.download.path) env.NARRATORR_DOWNLOAD_PATH = payload.download.path;
    if (payload.download.size != null) env.NARRATORR_DOWNLOAD_SIZE = payload.download.size.toString();
  }
  if (payload.import) {
    if (payload.import.libraryPath) env.NARRATORR_IMPORT_PATH = payload.import.libraryPath;
    if (payload.import.fileCount != null) env.NARRATORR_IMPORT_FILE_COUNT = payload.import.fileCount.toString();
  }
  if (payload.error) {
    env.NARRATORR_ERROR_MESSAGE = payload.error.message;
    if (payload.error.stage) env.NARRATORR_ERROR_STAGE = payload.error.stage;
  }
  if (payload.upgrade) {
    env.NARRATORR_UPGRADE_PREV_MBHR = payload.upgrade.previousMbPerHour.toString();
    env.NARRATORR_UPGRADE_NEW_MBHR = payload.upgrade.newMbPerHour.toString();
    if (payload.upgrade.previousCodec) env.NARRATORR_UPGRADE_PREV_CODEC = payload.upgrade.previousCodec;
    if (payload.upgrade.newCodec) env.NARRATORR_UPGRADE_NEW_CODEC = payload.upgrade.newCodec;
  }
  if (payload.health) {
    env.NARRATORR_HEALTH_CHECK = payload.health.checkName;
    env.NARRATORR_HEALTH_PREV_STATE = payload.health.previousState;
    env.NARRATORR_HEALTH_CURR_STATE = payload.health.currentState;
    if (payload.health.message) env.NARRATORR_HEALTH_MESSAGE = payload.health.message;
  }

  return env;
}

export class ScriptNotifier implements NotifierAdapter {
  readonly type = 'script';

  constructor(private config: ScriptConfig) {}

  async send(event: NotificationEvent, payload: EventPayload): Promise<{ success: boolean; message?: string }> {
    const timeoutMs = (this.config.timeout ?? 30) * 1000;
    const env = payloadToEnv(event, payload);

    return new Promise((resolve) => {
      const child = execFile(this.config.path, {
        timeout: timeoutMs,
        env: { ...process.env, ...env },
      }, (error, _stdout, stderr) => {
        if (error) {
          if (error.killed) {
            resolve({ success: false, message: `Script timed out after ${this.config.timeout ?? 30}s` });
          } else {
            resolve({ success: false, message: error.message });
          }
          return;
        }
        if (stderr) {
          resolve({ success: true, message: `Warning: ${stderr.slice(0, 200)}` });
          return;
        }
        resolve({ success: true });
      });

      // Feed payload as JSON on stdin
      if (child.stdin) {
        child.stdin.write(JSON.stringify(payload));
        child.stdin.end();
      }
    });
  }

  async test(): Promise<{ success: boolean; message?: string }> {
    const testPayload: EventPayload = {
      event: 'on_grab',
      book: { title: 'Test Book', author: 'Test Author' },
    };

    return this.send('on_grab', testPayload);
  }
}
