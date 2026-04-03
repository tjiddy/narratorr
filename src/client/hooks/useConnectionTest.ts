import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { TestResult } from '@/lib/api';

interface UseConnectionTestOptions<TFormData> {
  testById: (id: number) => Promise<TestResult>;
  testByConfig: (data: TFormData) => Promise<TestResult>;
  /** Query key to invalidate after a successful test-by-ID (e.g., ['indexers']) */
  invalidateOnSuccess?: string[];
}

export interface IdTestResult extends TestResult {
  id: number;
}

export function useConnectionTest<TFormData>({
  testById,
  testByConfig,
  invalidateOnSuccess,
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
      const result = await testByConfig(data);
      setFormTestResult(result);
      if (result.success) {
        toast.success('Connection successful');
      } else {
        toast.error(result.message || 'Connection failed');
      }
    } catch {
      setFormTestResult({ success: false, message: 'Test failed' });
      toast.error('Connection test failed');
    }
    setTestingForm(false);
  }, [testByConfig]);

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
