import { fetchApi } from './client.js';

export interface BookEvent {
  id: number;
  bookId: number | null;
  downloadId: number | null;
  bookTitle: string;
  authorName: string | null;
  eventType: string;
  source: string;
  reason: Record<string, unknown> | null;
  createdAt: string;
}

export const eventHistoryApi = {
  getEventHistory: (params?: { eventType?: string; search?: string }) => {
    const searchParams = new URLSearchParams();
    if (params?.eventType) searchParams.set('eventType', params.eventType);
    if (params?.search) searchParams.set('search', params.search);
    const qs = searchParams.toString();
    return fetchApi<BookEvent[]>(`/event-history${qs ? `?${qs}` : ''}`);
  },
  getBookEventHistory: (bookId: number) =>
    fetchApi<BookEvent[]>(`/event-history/books/${bookId}`),
  markEventFailed: (id: number) =>
    fetchApi<{ success: boolean }>(`/event-history/${id}/mark-failed`, { method: 'POST' }),
};
