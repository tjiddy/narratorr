import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));
import { ADAPTER_FACTORIES } from './registry.js';
import { notifierTypeSchema, type NotifierSettings } from '../../shared/schemas/notifier.js';
import { lookup as dnsLookup } from 'node:dns/promises';

const mockedDnsLookup = vi.mocked(dnsLookup) as unknown as Mock;

beforeEach(() => {
  mockedDnsLookup.mockReset();
  // Default DNS to a public IP so SSRF preflight passes for all tests.
  mockedDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

describe('Notifier ADAPTER_FACTORIES', () => {
  const types = notifierTypeSchema.options;

  const configs: Record<string, NotifierSettings> = {
    webhook: { url: 'https://hooks.test' },
    discord: { webhookUrl: 'https://discord.com/webhook' },
    script: { path: '/usr/local/bin/notify.sh' },
    email: { smtpHost: 'smtp.test', fromAddress: 'a@b.com', toAddress: 'c@d.com' },
    telegram: { botToken: 'tok123', chatId: '456' },
    slack: { webhookUrl: 'https://hooks.slack.com/test' },
    pushover: { pushoverToken: 'tok', pushoverUser: 'usr' },
    ntfy: { ntfyTopic: 'audiobooks' },
    gotify: { gotifyUrl: 'https://gotify.test', gotifyToken: 'tok' },
  };

  describe('invariants', () => {
    it('has a factory for every notifier type in the Zod enum', () => {
      for (const type of types) {
        expect(ADAPTER_FACTORIES[type], `Missing factory for type: ${type}`).toBeTypeOf('function');
      }
    });

    it('each factory returns an object satisfying the NotifierAdapter interface', () => {
      for (const type of types) {
        const adapter = ADAPTER_FACTORIES[type](configs[type]);
        expect(adapter).toHaveProperty('type');
        expect(adapter.send).toBeTypeOf('function');
        expect(adapter.test).toBeTypeOf('function');
      }
    });
  });

  describe('error handling', () => {
    it('returns undefined for unknown notifier type (no factory)', () => {
      expect((ADAPTER_FACTORIES as Record<string, unknown>)['unknown']).toBeUndefined();
    });
  });
});
