import { fetchApi } from './client.js';
import type { connectorTypeSchema } from '@shared/schemas.js';

type ConnectorType = (typeof connectorTypeSchema)['options'][number];

export interface Connector {
  id: number;
  name: string;
  type: ConnectorType;
  enabled: boolean;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorTarget {
  id: string;
  name: string;
}

/** Field-scoped connector test/targets result. */
export interface ConnectorTestResult {
  success: boolean;
  message?: string;
  warning?: string;
  // Open provider-setting map routed through settingsFields[].key.
  fieldErrors?: Record<string, string>;
}

type ConnectorInput = Omit<Connector, 'id' | 'createdAt' | 'updatedAt'>;

/** Bare target array on success; field-scoped result on failure. */
export type ConnectorTargetsResponse = ConnectorTarget[] | ConnectorTestResult;

export const connectorsApi = {
  getConnectors: () => fetchApi<Connector[]>('/connectors'),
  createConnector: (data: ConnectorInput) =>
    fetchApi<Connector>('/connectors', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateConnector: (id: number, data: Partial<ConnectorInput>) =>
    fetchApi<Connector>(`/connectors/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteConnector: (id: number) =>
    fetchApi<{ success: boolean }>(`/connectors/${id}`, { method: 'DELETE' }),
  testConnector: (id: number) =>
    fetchApi<ConnectorTestResult>(`/connectors/${id}/test`, { method: 'POST' }),
  testConnectorConfig: (data: ConnectorInput & { id?: number }) =>
    fetchApi<ConnectorTestResult>('/connectors/test', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  // Populate targets from unsaved config; id preserves secret sentinels.
  fetchConnectorTargets: (data: { type: string; settings: Record<string, unknown>; id?: number }) =>
    fetchApi<ConnectorTargetsResponse>('/connectors/targets', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};
