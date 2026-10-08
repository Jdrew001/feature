import { describe, expect, it, vi } from 'vitest';
import { FirebaseError } from 'firebase/app';
import type { ConfigUpdateObserver, CustomSignals, RemoteConfig, Value, ValueSource } from 'firebase/remote-config';
import { createFirebaseProvider } from '@feature-gates/firebase';
import type { FirebaseProviderOptions, FirebaseRemoteConfigSdk } from '@feature-gates/firebase';
import { createFeatureClient } from '@feature-gates/core';

function value(raw: string, source: ValueSource = 'remote'): Value {
  return { asString: () => raw, asBoolean: () => raw === 'true', asNumber: () => Number(raw), getSource: () => source };
}

function fixture(options: Pick<FirebaseProviderOptions, 'realtime' | 'customSignals'> = {}) {
  const config = { fetchTimeMillis: 0, settings: { minimumFetchIntervalMillis: 43200000, fetchTimeoutMillis: 10000 } };
  const remoteConfig = config as unknown as RemoteConfig;
  let values: Record<string, Value> = { a: value('true') };
  let observer: ConfigUpdateObserver | undefined;
  const off = vi.fn(() => { observer = undefined; });
  const sdk = {
    isSupported: vi.fn(async () => true),
    ensureInitialized: vi.fn(async () => {}),
    setCustomSignals: vi.fn(async (_config: RemoteConfig, _signals: CustomSignals) => {}),
    fetchAndActivate: vi.fn(async () => { config.fetchTimeMillis++; return true; }),
    activate: vi.fn(async () => true),
    getAll: vi.fn(() => values),
    onConfigUpdate: vi.fn((_config: RemoteConfig, next: ConfigUpdateObserver) => { observer = next; return off; }),
  } satisfies FirebaseRemoteConfigSdk;
  const provider = createFirebaseProvider({ remoteConfig, sdk, ...options });
  const connect = (controller = new AbortController()) => provider.connect({ targetId: 'user' }, controller.signal);
  return {
    config, remoteConfig, sdk, off, provider, connect,
    setValues: (next: Record<string, Value>) => { values = next; },
    update: () => observer?.next({ getUpdatedKeys: () => new Set(['a']) }),
    fail: () => observer?.error(new FirebaseError('remote-config/fetch-client-network', 'Disconnected')),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('Firebase Remote Config adapter', () => {
  it('distinguishes remote false, missing/default/static keys, and invalid values', async () => {
    const f = fixture();
    f.setValues({ off: value('false'), on: value(' TRUE '), invalid: value('1'), text: value('enabled'), local: value('true', 'default'), static: value('false', 'static') });
    const session = await f.connect();
    expect(session.evaluate('off', true)).toEqual({ kind: 'value', value: false, source: 'provider' });
    expect(session.evaluate('on', false)).toMatchObject({ kind: 'value', value: true });
    for (const key of ['missing', 'local', 'static']) expect(session.evaluate(key, true)).toEqual({ kind: 'unavailable', reason: 'missing' });
    for (const key of ['invalid', 'text']) expect(session.evaluate(key, true)).toEqual({ kind: 'unavailable', reason: 'invalid' });
    session.close();
  });

  it('accepts an unchanged activated template and marks reused fetches as cache', async () => {
    const f = fixture();
    f.config.fetchTimeMillis = 100;
    f.sdk.fetchAndActivate.mockImplementation(async () => false);
    const session = await f.connect();
    expect(session.evaluate('a', false)).toEqual({ kind: 'value', value: true, source: 'cache' });
    session.close();
  });

  it('activates updates, removes omitted flags, and isolates subscriber failures', async () => {
    const f = fixture();
    const session = await f.connect();
    const listener = vi.fn();
    session.subscribe(() => { throw new Error('Subscriber failed'); });
    const off = session.subscribe(listener);
    f.setValues({ b: value('false') });
    f.update();
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
    expect(f.sdk.activate).toHaveBeenCalledWith(f.remoteConfig);
    expect(session.evaluate('a', true)).toEqual({ kind: 'unavailable', reason: 'missing' });
    expect(session.evaluate('b', true)).toEqual({ kind: 'value', value: false, source: 'provider' });
    off();
    session.close();
    session.close();
    expect(f.off).toHaveBeenCalledOnce();
    f.update();
    expect(listener).toHaveBeenCalledOnce();
    expect(session.evaluate('b', true)).toEqual({ kind: 'unavailable', reason: 'unavailable' });
  });

  it('falls back on stream and activation failures and recovers on a later update', async () => {
    const f = fixture();
    const client = createFeatureClient({ catalog: { a: { providerKey: 'a', fallback: false } }, provider: f.provider });
    await client.start({ targetId: 'user' });
    expect(client.getSnapshot('a')).toMatchObject({ enabled: true, status: 'ready' });
    f.fail();
    expect(client.getSnapshot('a')).toMatchObject({ enabled: false, status: 'degraded', reason: 'unavailable' });
    f.sdk.activate.mockRejectedValueOnce(new Error('Activation failed'));
    f.update();
    await vi.waitFor(() => expect(f.sdk.activate).toHaveBeenCalledOnce());
    expect(client.getSnapshot('a').enabled).toBe(false);
    f.setValues({ a: value('false') });
    f.update();
    await vi.waitFor(() => expect(client.getSnapshot('a')).toMatchObject({ enabled: false, status: 'ready' }));
    await client.dispose();
    expect(f.off).toHaveBeenCalledOnce();
  });

  it('rejects failed fetches and allows core retry without accepting an old active value', async () => {
    const f = fixture();
    f.sdk.fetchAndActivate.mockRejectedValueOnce(new Error('Fetch failed'));
    const client = createFeatureClient({ catalog: { a: { providerKey: 'a', fallback: false } }, provider: f.provider });
    await client.start({ targetId: 'user' });
    expect(client.getSnapshot('a')).toMatchObject({ enabled: false, status: 'degraded' });
    expect(f.sdk.onConfigUpdate).not.toHaveBeenCalled();
    await client.retry();
    expect(client.getSnapshot('a')).toMatchObject({ enabled: true, status: 'ready' });
    await client.dispose();
  });

  it('rejects unsupported browsers and already aborted connections without starting a fetch', async () => {
    const f = fixture();
    f.sdk.isSupported.mockResolvedValue(false);
    await expect(f.connect()).rejects.toThrow('unsupported');
    expect(f.sdk.fetchAndActivate).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(f.connect(controller)).rejects.toThrow('aborted');
    expect(f.sdk.isSupported).toHaveBeenCalledOnce();
  });

  it('aborts a pending connection promptly and suppresses its late snapshot and subscription', async () => {
    const f = fixture();
    const pending = deferred<boolean>();
    f.sdk.fetchAndActivate.mockReturnValueOnce(pending.promise);
    const controller = new AbortController();
    const connecting = f.connect(controller);
    const rejected = expect(connecting).rejects.toThrow('aborted');
    await vi.waitFor(() => expect(f.sdk.fetchAndActivate).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    pending.resolve(true);
    // A replacement connection also proves the old queued operation has finished.
    const next = await f.connect();
    expect(f.sdk.getAll).toHaveBeenCalledOnce();
    expect(f.sdk.onConfigUpdate).toHaveBeenCalledOnce();
    next.close();
  });

  it('serializes context replacement behind pending SDK work without publishing old decisions', async () => {
    const f = fixture();
    const pending = deferred<boolean>();
    f.sdk.fetchAndActivate.mockReturnValueOnce(pending.promise);
    const client = createFeatureClient({ catalog: { a: { providerKey: 'a', fallback: false } }, provider: f.provider });
    const old = client.start({ targetId: 'old' });
    const rejected = expect(old).rejects.toThrow('context changed');
    await vi.waitFor(() => expect(f.sdk.fetchAndActivate).toHaveBeenCalledOnce());
    const replacement = client.setContext({ targetId: 'new' });
    await rejected;
    expect(client.getSnapshot('a')).toMatchObject({ enabled: false, status: 'pending' });
    f.setValues({ a: value('false') });
    pending.resolve(true);
    await replacement;
    expect(client.getSnapshot('a')).toMatchObject({ enabled: false, status: 'ready', contextRevision: 2 });
    expect(f.sdk.getAll).toHaveBeenCalledOnce();
    await client.dispose();
  });

  it('ignores a pending activation after abort and detaches the stream', async () => {
    const f = fixture();
    const controller = new AbortController();
    const session = await f.connect(controller);
    const pending = deferred<boolean>();
    f.sdk.activate.mockReturnValueOnce(pending.promise);
    const listener = vi.fn();
    session.subscribe(listener);
    f.update();
    await vi.waitFor(() => expect(f.sdk.activate).toHaveBeenCalledOnce());
    controller.abort();
    expect(f.off).toHaveBeenCalledOnce();
    pending.resolve(true);
    const next = await f.connect();
    expect(listener).not.toHaveBeenCalled();
    next.close();
  });

  it('does not let a late activation clear a newer stream failure', async () => {
    const f = fixture();
    const session = await f.connect();
    const pending = deferred<boolean>();
    f.sdk.activate.mockReturnValueOnce(pending.promise);
    const listener = vi.fn();
    session.subscribe(listener);
    f.update();
    await vi.waitFor(() => expect(f.sdk.activate).toHaveBeenCalledOnce());
    f.fail();
    pending.resolve(true);
    await vi.waitFor(() => expect(f.sdk.activate).toHaveResolvedTimes(1));
    expect(session.evaluate('a', false)).toEqual({ kind: 'unavailable', reason: 'unavailable' });
    expect(listener).toHaveBeenCalledOnce();
    session.close();
  });

  it('supports fetch-only mode', async () => {
    const f = fixture({ realtime: false });
    const session = await f.connect();
    expect(f.sdk.onConfigUpdate).not.toHaveBeenCalled();
    expect(session.evaluate('a', false)).toMatchObject({ value: true });
    session.close();
  });

  it('maps beta membership before fetching and replaces it on logout', async () => {
    const f = fixture({
      customSignals: context => ({ beta_tester: context.attributes?.betaTester === true ? 'true' : 'false' }),
    });
    f.sdk.fetchAndActivate.mockImplementation(async () => {
      expect(f.config.settings.minimumFetchIntervalMillis).toBe(0);
      f.config.fetchTimeMillis++;
      return true;
    });
    const client = createFeatureClient({ catalog: { a: { providerKey: 'a', fallback: false } }, provider: f.provider });
    await client.start({ targetId: 'beta-user', attributes: { betaTester: true } });
    expect(f.sdk.ensureInitialized).toHaveBeenCalledWith(f.remoteConfig);
    expect(f.sdk.setCustomSignals).toHaveBeenLastCalledWith(f.remoteConfig, { beta_tester: 'true' });
    expect(f.sdk.setCustomSignals.mock.invocationCallOrder[0]).toBeLessThan(f.sdk.fetchAndActivate.mock.invocationCallOrder[0]!);
    expect(f.config.settings.minimumFetchIntervalMillis).toBe(43200000);
    f.setValues({ a: value('false') });
    await client.setContext({ targetId: 'anonymous' });
    expect(f.sdk.setCustomSignals).toHaveBeenLastCalledWith(f.remoteConfig, { beta_tester: 'false' });
    expect(client.getSnapshot('a')).toMatchObject({ enabled: false, status: 'ready' });
    await client.dispose();
  });

  it('restores fetch settings and falls back if a targeted fetch fails', async () => {
    const f = fixture({ customSignals: () => ({ beta_tester: 'false', tenant: null }) });
    f.sdk.fetchAndActivate.mockRejectedValueOnce(new Error('Network failed'));
    await expect(f.connect()).rejects.toThrow('Network failed');
    expect(f.config.settings.minimumFetchIntervalMillis).toBe(43200000);
    expect(f.sdk.setCustomSignals).toHaveBeenCalledWith(f.remoteConfig, { beta_tester: 'false', tenant: null });
  });

  it('rejects a cached template for a new beta context instead of retaining its enabled flag', async () => {
    const f = fixture({ customSignals: () => ({ beta_tester: 'false' }) });
    f.config.fetchTimeMillis = 100;
    f.sdk.fetchAndActivate.mockImplementation(async () => false);
    const client = createFeatureClient({ catalog: { a: { providerKey: 'a', fallback: false } }, provider: f.provider });
    await client.start({ targetId: 'anonymous' });
    expect(client.getSnapshot('a')).toMatchObject({ enabled: false, status: 'degraded', source: 'fallback' });
    expect(f.sdk.getAll).not.toHaveBeenCalled();
    await client.dispose();
  });

  it('does not fetch if custom signal setup fails', async () => {
    const f = fixture({ customSignals: () => ({ beta_tester: 'false' }) });
    f.sdk.setCustomSignals.mockRejectedValueOnce(new Error('Signals failed'));
    await expect(f.connect()).rejects.toThrow('Signals failed');
    expect(f.sdk.fetchAndActivate).not.toHaveBeenCalled();
  });

  it('uses the real SDK support check when no SDK override is supplied', async () => {
    // jsdom has no IndexedDB. This exercises the installed SDK without credentials.
    const provider = createFirebaseProvider({ remoteConfig: {} as RemoteConfig });
    await expect(provider.connect({ targetId: 'user' }, new AbortController().signal)).rejects.toThrow('unsupported');
  });
});
