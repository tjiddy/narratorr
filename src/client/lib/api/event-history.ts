import { fetchApi } from './client.js';

export interface BookEvent {
  id: number;
  bookId: number | null;
  downloadId: number | null;
  bookTitle: string;
  authorName: string | null;
  narratorName: string | null;
  eventType: string;
  source: string;
  reason: Record<string, unknown> | null;
  createdAt: string;
}

export interface EventHistoryParams {
  eventType?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export const eventHistoryApi = {
  getEventHistory: (params?: EventHistoryParams) => {
    const searchParams = new URLSearchParams();
    if (params?.eventType) searchParams.set('eventType', params.eventType);
    if (params?.search) searchParams.set('search', params.search);
    if (params?.limit !== undefined) searchParams.set('limit', String(params.limit));
    if (params?.offset !== undefined) searchParams.set('offset', String(params.offset));
    const qs = searchParams.toString();
    return fetchApi<{ data: BookEvent[]; total: number }>(`/event-history${qs ? `?${qs}` : ''}`);
  },
  getBookEventHistory: (bookId: number) =>
    fetchApi<BookEvent[]>(`/event-history/books/${bookId}`),
  markEventFailed: (id: number) =>
    fetchApi<{ success: boolean }>(`/event-history/${id}/mark-failed`, { method: 'POST' }),
  deleteEvent: (id: number) =>
    fetchApi<{ success: boolean }>(`/event-history/${id}`, { method: 'DELETE' }),
  deleteEvents: (params?: { eventType?: string }) => {
    const searchParams = new URLSearchParams();
    if (params?.eventType) searchParams.set('eventType', params.eventType);
    const qs = searchParams.toString();
    return fetchApi<{ deleted: number }>(`/event-history${qs ? `?${qs}` : ''}`, { method: 'DELETE' });
  },
};
