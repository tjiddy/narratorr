import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import type { TestResult } from '@/lib/api';

interface UseConnectionTestOptions<TFormData> {
  testById: (id: number) => Promise<TestResult>;
  testByConfig: (data: TFormData) => Promise<TestResult>;
}

export interface IdTestResult extends TestResult {
  id: number;
}

export function useConnectionTest<TFormData>({
  testById,
  testByConfig,
}: UseConnectionTestOptions<TFormData>) {
  const [testingId, setTestingId] = useState<number | null>(null);
  const [testResult, setTestResult] = useState<IdTestResult | null>(null);
  const [testingForm, setTestingForm] = useState(false);
  const [formTestResult, setFormTestResult] = useState<TestResult | null>(null);

  const handleTest = useCallback(async (id: number) => {
    setTestingId(id);
    setTestResult(null);
    try {
      const result = await testById(id);
      setTestResult({ id, ...result });
      if (result.success) {
        toast.success('Connection successful');
      } else {
        toast.error(result.message || 'Connection failed');
      }
    } catch {
      setTestResult({ id, success: false, message: 'Test failed' });
      toast.error('Connection test failed');
    }
    setTestingId(null);
  }, [testById]);

  const handleFormTest = useCallback(async (data: TFormData) => {
    setTestingForm(true);
    setFormTestResult(null);
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
