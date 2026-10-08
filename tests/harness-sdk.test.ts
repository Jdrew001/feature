import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarnessProvider } from '@feature-gates/harness';
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const token = 'x.' + btoa(JSON.stringify({ environment: 'sdk-selected-context', environmentIdentifier: 'test', accountID: 'test', clusterIdentifier: 'test' })) + '.x';
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('installed Harness SDK with simulated transport', () => {
  it('authenticates and evaluates through the actual SDK without a live Harness account', async () => {
    const transport = vi.fn(async (url: string | URL | Request) => String(url).endsWith('/client/auth')
      ? new Response(JSON.stringify({ authToken: token }), { status: 200 })
      : new Response(JSON.stringify([{ flag: 'reports', identifier: 'on', kind: 'boolean', value: true }]), { status: 200 }));
    vi.stubGlobal('fetch', transport);
    const provider = createHarnessProvider({ sdkKey: 'fixture-key', sdkOptions: { streamEnabled: false, pollingEnabled: false, enableAnalytics: false, logger: silentLogger } });
    const session = await provider.connect({ targetId: 'user' }, new AbortController().signal);
    try {
      expect(session.evaluate('reports', false)).toEqual({ kind: 'value', value: true, source: 'provider' });
      expect(session.evaluate('missing', false)).toEqual({ kind: 'unavailable', reason: 'missing' });
      expect(transport).toHaveBeenCalledTimes(2);
    } finally { await session.close(); }
  });
  it('updates through the actual SDK polling lifecycle', async () => {
    vi.useFakeTimers(); let enabled = false; let deleted = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => String(url).endsWith('/client/auth')
      ? new Response(JSON.stringify({ authToken: token }), { status: 200 })
      : new Response(JSON.stringify(deleted ? [] : [{ flag: 'reports', identifier: enabled ? 'on' : 'off', kind: 'boolean', value: enabled }]), { status: 200 })));
    const provider = createHarnessProvider({ sdkKey: 'fixture-key', sdkOptions: { streamEnabled: false, pollingEnabled: true, pollingInterval: 60000, enableAnalytics: false, logger: silentLogger } });
    const session = await provider.connect({ targetId: 'user' }, new AbortController().signal);
    try {
      expect(session.evaluate('reports', true)).toMatchObject({ value: false });
      enabled = true; await vi.advanceTimersByTimeAsync(60000);
      expect(session.evaluate('reports', false)).toMatchObject({ value: true });
      deleted = true; await vi.advanceTimersByTimeAsync(60000);
      expect(session.evaluate('reports', false)).toEqual({ kind: 'unavailable', reason: 'missing' });
    } finally { await session.close(); }
    expect(vi.getTimerCount()).toBe(0);
  });
});
