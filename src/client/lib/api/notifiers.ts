import { fetchApi } from './client.js';
import { type TestResult } from './settings.js';
import type { notifierTypeSchema } from '../../../shared/schemas.js';

type NotifierType = (typeof notifierTypeSchema)['options'][number];

export interface Notifier {
  id: number;
  name: string;
  type: NotifierType;
  enabled: boolean;
  events: string[];
  settings: Record<string, unknown>;
  createdAt: string;
}

export const notifiersApi = {
  getNotifiers: () => fetchApi<Notifier[]>('/notifiers'),
  createNotifier: (data: Omit<Notifier, 'id' | 'createdAt'>) =>
    fetchApi<Notifier>('/notifiers', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateNotifier: (id: number, data: Partial<Notifier>) =>
    fetchApi<Notifier>(`/notifiers/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteNotifier: (id: number) =>
    fetchApi<{ success: boolean }>(`/notifiers/${id}`, { method: 'DELETE' }),
  testNotifier: (id: number) =>
    fetchApi<TestResult>(`/notifiers/${id}/test`, { method: 'POST' }),
  testNotifierConfig: (data: Omit<Notifier, 'id' | 'createdAt'>) =>
    fetchApi<TestResult>('/notifiers/test', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};
