import { describe, expect, it, vi } from 'vitest';
import { FirebaseError } from 'firebase/app';
import type { ConfigUpdateObserver, CustomSignals, RemoteConfig, Value, ValueSource } from 'firebase/remote-config';
import { createFirebaseProvider } from '@feature-gates/firebase';
import type { FirebaseProviderOptions, FirebaseRemoteConfigSdk } from '@feature-gates/firebase';
import { createFeatureClient } from '@feature-gates/core';

function value(raw: string, source: ValueSource = 'remote'): Value {
  return { asString: () => raw, asBoolean: () => raw === 'true', asNumber: () => Number(raw), getSource: () => source };
}

function createFixture(options: Pick<FirebaseProviderOptions, 'realtime' | 'customSignals'> = {}) {
  const config = { fetchTimeMillis: 0, settings: { minimumFetchIntervalMillis: 43200000, fetchTimeoutMillis: 10000 } };
  const remoteConfig = config as unknown as RemoteConfig;
  let values: Record<string, Value> = { a: value('true') };
  let observer: ConfigUpdateObserver | undefined;
  const off = vi.fn(() => { observer = undefined; });
  const sdk = {
    isSupported: vi.fn(() => Promise.resolve(true)),
    ensureInitialized: vi.fn(() => Promise.resolve()),
    setCustomSignals: vi.fn((_config: RemoteConfig, _signals: CustomSignals) => Promise.resolve()),
    fetchAndActivate: vi.fn(() => { config.fetchTimeMillis++; return Promise.resolve(true); }),
    activate: vi.fn(() => Promise.resolve(true)),
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
    const fixture = createFixture();
    fixture.setValues({ off: value('false'), on: value(' TRUE '), invalid: value('1'), text: value('enabled'), local: value('true', 'default'), static: value('false', 'static') });
    const session = await fixture.connect();
    expect(session.evaluate('off', true)).toEqual({ kind: 'value', value: false, source: 'provider' });
    expect(session.evaluate('on', false)).toMatchObject({ kind: 'value', value: true });
    for (const key of ['missing', 'local', 'static']) expect(session.evaluate(key, true)).toEqual({ kind: 'unavailable', reason: 'missing' });
    for (const key of ['invalid', 'text']) expect(session.evaluate(key, true)).toEqual({ kind: 'unavailable', reason: 'invalid' });
    session.close();
  });

  it('accepts an unchanged activated template and marks reused fetches as cache', async () => {
    const fixture = createFixture();
    fixture.config.fetchTimeMillis = 100;
    fixture.sdk.fetchAndActivate.mockImplementation(() => Promise.resolve(false));
    const session = await fixture.connect();
    expect(session.evaluate('a', false)).toEqual({ kind: 'value', value: true, source: 'cache' });
    session.close();
  });

  it('activates updates, removes omitted flags, and isolates subscriber failures', async () => {
    const fixture = createFixture();
    const session = await fixture.connect();
    const listener = vi.fn();
    session.subscribe(() => { throw new Error('Subscriber failed'); });
    const off = session.subscribe(listener);
    fixture.setValues({ b: value('false') });
    fixture.update();
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
    expect(fixture.sdk.activate).toHaveBeenCalledWith(fixture.remoteConfig);
    expect(session.evaluate('a', true)).toEqual({ kind: 'unavailable', reason: 'missing' });
    expect(session.evaluate('b', true)).toEqual({ kind: 'value', value: false, source: 'provider' });
    off();
    session.close();
    session.close();
    expect(fixture.off).toHaveBeenCalledOnce();
    fixture.update();
    expect(listener).toHaveBeenCalledOnce();
    expect(session.evaluate('b', true)).toEqual({ kind: 'unavailable', reason: 'unavailable' });
  });

  it('falls back on stream and activation failures and recovers on a later update', async () => {
    const fixture = createFixture();
    const client = createFeatureClient({ catalog: { a: { providerKey: 'a', fallback: false } }, provider: fixture.provider });
    await client.start({ targetId: 'user' });
    expect(client.getSnapshot('a')).toMatchObject({ enabled: true, status: 'ready' });
    fixture.fail();
    expect(client.getSnapshot('a')).toMatchObject({ enabled: false, status: 'degraded', reason: 'unavailable' });
    fixture.sdk.activate.mockRejectedValueOnce(new Error('Activation failed'));
    fixture.update();
    await vi.waitFor(() => expect(fixture.sdk.activate).toHaveBeenCalledOnce());
    expect(client.getSnapshot('a').enabled).toBe(false);
    fixture.setValues({ a: value('false') });
    fixture.update();
    await vi.waitFor(() => expect(client.getSnapshot('a')).toMatchObject({ enabled: false, status: 'ready' }));
    await client.dispose();
    expect(fixture.off).toHaveBeenCalledOnce();
  });

  it('rejects failed fetches and allows core retry without accepting an old active value', async () => {
    const fixture = createFixture();
    fixture.sdk.fetchAndActivate.mockRejectedValueOnce(new Error('Fetch failed'));
    const client = createFeatureClient({ catalog: { a: { providerKey: 'a', fallback: false } }, provider: fixture.provider });
    await client.start({ targetId: 'user' });
    expect(client.getSnapshot('a')).toMatchObject({ enabled: false, status: 'degraded' });
    expect(fixture.sdk.onConfigUpdate).not.toHaveBeenCalled();
    await client.retry();
    expect(client.getSnapshot('a')).toMatchObject({ enabled: true, status: 'ready' });
    await client.dispose();
  });

  it('rejects unsupported browsers and already aborted connections without starting a fetch', async () => {
    const fixture = createFixture();
    fixture.sdk.isSupported.mockResolvedValue(false);
    await expect(fixture.connect()).rejects.toThrow('unsupported');
    expect(fixture.sdk.fetchAndActivate).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(fixture.connect(controller)).rejects.toThrow('aborted');
    expect(fixture.sdk.isSupported).toHaveBeenCalledOnce();
  });

  it('aborts a pending connection promptly and suppresses its late snapshot and subscription', async () => {
    const fixture = createFixture();
    const pending = deferred<boolean>();
    fixture.sdk.fetchAndActivate.mockReturnValueOnce(pending.promise);
    const controller = new AbortController();
    const connecting = fixture.connect(controller);
    const rejected = expect(connecting).rejects.toThrow('aborted');
    await vi.waitFor(() => expect(fixture.sdk.fetchAndActivate).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    pending.resolve(true);
    // A replacement connection also proves the old queued operation has finished.
    const next = await fixture.connect();
    expect(fixture.sdk.getAll).toHaveBeenCalledOnce();
    expect(fixture.sdk.onConfigUpdate).toHaveBeenCalledOnce();
    next.close();
  });

  it('serializes context replacement behind pending SDK work without publishing old decisions', async () => {
    const fixture = createFixture();
    const pending = deferred<boolean>();
    fixture.sdk.fetchAndActivate.mockReturnValueOnce(pending.promise);
    const client = createFeatureClient({ catalog: { a: { providerKey: 'a', fallback: false } }, provider: fixture.provider });
    const old = client.start({ targetId: 'old' });
    const rejected = expect(old).rejects.toThrow('context changed');
    await vi.waitFor(() => expect(fixture.sdk.fetchAndActivate).toHaveBeenCalledOnce());
    const replacement = client.setContext({ targetId: 'new' });
    await rejected;
    expect(client.getSnapshot('a')).toMatchObject({ enabled: false, status: 'pending' });
    fixture.setValues({ a: value('false') });
    pending.resolve(true);
    await replacement;
    expect(client.getSnapshot('a')).toMatchObject({ enabled: false, status: 'ready', contextRevision: 2 });
    expect(fixture.sdk.getAll).toHaveBeenCalledOnce();
    await client.dispose();
  });

  it('ignores a pending activation after abort and detaches the stream', async () => {
    const fixture = createFixture();
    const controller = new AbortController();
    const session = await fixture.connect(controller);
    const pending = deferred<boolean>();
    fixture.sdk.activate.mockReturnValueOnce(pending.promise);
    const listener = vi.fn();
    session.subscribe(listener);
    fixture.update();
    await vi.waitFor(() => expect(fixture.sdk.activate).toHaveBeenCalledOnce());
    controller.abort();
    expect(fixture.off).toHaveBeenCalledOnce();
    pending.resolve(true);
    const next = await fixture.connect();
    expect(listener).not.toHaveBeenCalled();
    next.close();
  });

  it('does not let a late activation clear a newer stream failure', async () => {
    const fixture = createFixture();
    const session = await fixture.connect();
    const pending = deferred<boolean>();
    fixture.sdk.activate.mockReturnValueOnce(pending.promise);
    const listener = vi.fn();
    session.subscribe(listener);
    fixture.update();
    await vi.waitFor(() => expect(fixture.sdk.activate).toHaveBeenCalledOnce());
    fixture.fail();
    pending.resolve(true);
    await vi.waitFor(() => expect(fixture.sdk.activate).toHaveResolvedTimes(1));
    expect(session.evaluate('a', false)).toEqual({ kind: 'unavailable', reason: 'unavailable' });
    expect(listener).toHaveBeenCalledOnce();
    session.close();
  });

  it('supports fetch-only mode', async () => {
    const fixture = createFixture({ realtime: false });
    const session = await fixture.connect();
    expect(fixture.sdk.onConfigUpdate).not.toHaveBeenCalled();
    expect(session.evaluate('a', false)).toMatchObject({ value: true });
    session.close();
  });

  it('maps beta membership before fetching and replaces it on logout', async () => {
    const fixture = createFixture({
      customSignals: context => ({ beta_tester: context.attributes?.betaTester === true ? 'true' : 'false' }),
    });
    fixture.sdk.fetchAndActivate.mockImplementation(() => {
      expect(fixture.config.settings.minimumFetchIntervalMillis).toBe(0);
      fixture.config.fetchTimeMillis++;
      return Promise.resolve(true);
    });
    const client = createFeatureClient({ catalog: { a: { providerKey: 'a', fallback: false } }, provider: fixture.provider });
    await client.start({ targetId: 'beta-user', attributes: { betaTester: true } });
    expect(fixture.sdk.ensureInitialized).toHaveBeenCalledWith(fixture.remoteConfig);
    expect(fixture.sdk.setCustomSignals).toHaveBeenLastCalledWith(fixture.remoteConfig, { beta_tester: 'true' });
    const [signalCall] = fixture.sdk.setCustomSignals.mock.invocationCallOrder;
    const [fetchCall] = fixture.sdk.fetchAndActivate.mock.invocationCallOrder;
    if (signalCall === undefined || fetchCall === undefined) throw new Error('Both signal setup and fetch must run');
    expect(signalCall).toBeLessThan(fetchCall);
    expect(fixture.config.settings.minimumFetchIntervalMillis).toBe(43200000);
    fixture.setValues({ a: value('false') });
    await client.setContext({ targetId: 'anonymous' });
    expect(fixture.sdk.setCustomSignals).toHaveBeenLastCalledWith(fixture.remoteConfig, { beta_tester: 'false' });
    expect(client.getSnapshot('a')).toMatchObject({ enabled: false, status: 'ready' });
    await client.dispose();
  });

  it('replaces donor targeting on account changes and removes it on logout', async () => {
    const fixture = createFixture({
      customSignals: context => ({ donor_id: context.targetId === 'anonymous' ? null : context.targetId }),
    });
    const client = createFeatureClient({ catalog: { a: { providerKey: 'a', fallback: false } }, provider: fixture.provider });
    await client.start({ targetId: 'selected-donor' });
    expect(fixture.sdk.setCustomSignals).toHaveBeenLastCalledWith(fixture.remoteConfig, { donor_id: 'selected-donor' });
    expect(client.getSnapshot('a')).toMatchObject({ enabled: true, status: 'ready' });

    fixture.setValues({ a: value('false') });
    await client.setContext({ targetId: 'ordinary-donor' });
    expect(fixture.sdk.setCustomSignals).toHaveBeenLastCalledWith(fixture.remoteConfig, { donor_id: 'ordinary-donor' });
    expect(client.getSnapshot('a')).toMatchObject({ enabled: false, status: 'ready' });

    await client.setContext({ targetId: 'anonymous' });
    expect(fixture.sdk.setCustomSignals).toHaveBeenLastCalledWith(fixture.remoteConfig, { donor_id: null });
    expect(fixture.sdk.fetchAndActivate).toHaveBeenCalledTimes(3);
    expect(client.getSnapshot('a')).toMatchObject({ enabled: false, status: 'ready' });
    await client.dispose();
  });

  it('restores fetch settings and falls back if a targeted fetch fails', async () => {
    const fixture = createFixture({ customSignals: () => ({ beta_tester: 'false', tenant: null }) });
    fixture.sdk.fetchAndActivate.mockRejectedValueOnce(new Error('Network failed'));
    await expect(fixture.connect()).rejects.toThrow('Network failed');
    expect(fixture.config.settings.minimumFetchIntervalMillis).toBe(43200000);
    expect(fixture.sdk.setCustomSignals).toHaveBeenCalledWith(fixture.remoteConfig, { beta_tester: 'false', tenant: null });
  });

  it('rejects a cached template for a new beta context instead of retaining its enabled flag', async () => {
    const fixture = createFixture({ customSignals: () => ({ beta_tester: 'false' }) });
    fixture.config.fetchTimeMillis = 100;
    fixture.sdk.fetchAndActivate.mockImplementation(() => Promise.resolve(false));
    const client = createFeatureClient({ catalog: { a: { providerKey: 'a', fallback: false } }, provider: fixture.provider });
    await client.start({ targetId: 'anonymous' });
    expect(client.getSnapshot('a')).toMatchObject({ enabled: false, status: 'degraded', source: 'fallback' });
    expect(fixture.sdk.getAll).not.toHaveBeenCalled();
    await client.dispose();
  });

  it('does not fetch if custom signal setup fails', async () => {
    const fixture = createFixture({ customSignals: () => ({ beta_tester: 'false' }) });
    fixture.sdk.setCustomSignals.mockRejectedValueOnce(new Error('Signals failed'));
    await expect(fixture.connect()).rejects.toThrow('Signals failed');
    expect(fixture.sdk.fetchAndActivate).not.toHaveBeenCalled();
  });

  it('uses the real SDK support check when no SDK override is supplied', async () => {
    // jsdom has no IndexedDB. This exercises the installed SDK without credentials.
    const provider = createFirebaseProvider({ remoteConfig: {} as RemoteConfig });
    await expect(provider.connect({ targetId: 'user' }, new AbortController().signal)).rejects.toThrow('unsupported');
  });
});
