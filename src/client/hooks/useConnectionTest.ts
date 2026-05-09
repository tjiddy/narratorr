import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { TestResult } from '@/lib/api';

interface UseConnectionTestOptions<TFormData> {
  testById: (id: number) => Promise<TestResult>;
  testByConfig: (data: TFormData) => Promise<TestResult>;
  /** Query key to invalidate after a successful test-by-ID (e.g., ['indexers']) */
  invalidateOnSuccess?: string[];
  /**
   * When set, handleFormTest merges `{ id: entityId }` into the payload before
   * calling testByConfig so the server can resolve sentinel placeholders for
   * masked secret fields against the persisted row. Omit for create flows or
   * for adapters whose test endpoint does not accept an id (e.g. import lists).
   */
  entityId?: number | undefined;
}

export interface IdTestResult extends TestResult {
  id: number;
}

export function useConnectionTest<TFormData>({
  testById,
  testByConfig,
  invalidateOnSuccess,
  entityId,
}: UseConnectionTestOptions<TFormData>) {
  const queryClient = useQueryClient();
  const [testingId, setTestingId] = useState<number | null>(null);
  const [testResult, setTestResult] = useState<IdTestResult | null>(null);
  const [testingForm, setTestingForm] = useState(false);
  const [formTestResult, setFormTestResult] = useState<TestResult | null>(null);

  const handleTest = useCallback(async (id: number) => {
    setTestingId(id);
    try {
      const result = await testById(id);
      setTestResult({ id, ...result });
      if (result.success) {
        toast.success('Connection successful');
        if (result.warning) {
          toast.warning(result.warning);
        }
        if (invalidateOnSuccess) {
          await queryClient.invalidateQueries({ queryKey: invalidateOnSuccess });
        }
      } else {
        toast.error(result.message || 'Connection failed');
      }
    } catch {
      setTestResult({ id, success: false, message: 'Test failed' });
      toast.error('Connection test failed');
    }
    setTestingId(null);
  }, [testById, invalidateOnSuccess, queryClient]);

  const handleFormTest = useCallback(async (data: TFormData) => {
    setTestingForm(true);
    try {
      const payload = entityId !== undefined ? ({ ...data, id: entityId } as TFormData) : data;
      const result = await testByConfig(payload);
      setFormTestResult(result);
      if (result.success) {
        toast.success('Connection successful');
        if (result.warning) {
          toast.warning(result.warning);
        }
      } else {
        toast.error(result.message || 'Connection failed');
      }
    } catch {
      setFormTestResult({ success: false, message: 'Test failed' });
      toast.error('Connection test failed');
    }
    setTestingForm(false);
  }, [testByConfig, entityId]);

  const clearFormTestResult = useCallback(() => {
    setFormTestResult(null);
  }, []);

  return {
    testingId,
    testResult,
    testingForm,
    formTestResult,
    handleTest,
    handleFormTest,
    clearFormTestResult,
  };
}
