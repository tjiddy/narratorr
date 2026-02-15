export type NotificationEvent = 'on_grab' | 'on_download_complete' | 'on_import' | 'on_failure';

export interface EventPayload {
  event: NotificationEvent;
  book?: {
    title: string;
    author?: string;
    coverUrl?: string;
  };
  release?: {
    title: string;
    indexer?: string;
    size?: number;
  };
  download?: {
    path?: string;
    size?: number;
  };
  import?: {
    libraryPath?: string;
    fileCount?: number;
  };
  error?: {
    message: string;
    stage?: string;
  };
}

export interface NotifierAdapter {
  readonly type: string;
  send(event: NotificationEvent, payload: EventPayload): Promise<{ success: boolean; message?: string }>;
  test(): Promise<{ success: boolean; message?: string }>;
}
