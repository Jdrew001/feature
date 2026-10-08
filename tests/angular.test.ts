import { afterEach, describe, expect, it, vi } from 'vitest';
import { Component, signal, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { FEATURE_CLIENT, FeatureGateDirective, FeatureFlagsModule, featureCanMatch, provideFeatures, waitForFeature } from '@feature-gates/angular';
import { createFeatureClient } from '@feature-gates/core';
import type { FeatureCatalog, FeatureClient } from '@feature-gates/core';
import { MemoryProvider } from '@feature-gates/testing';
const clients: FeatureClient<FeatureCatalog>[] = [];
const catalog = { a: { providerKey: 'a', fallback: false }, b: { providerKey: 'b', fallback: false } };
afterEach(async () => { TestBed.resetTestingModule(); await Promise.all(clients.splice(0).map(c => c.dispose())); });
async function setup(autoReady = true) {
  const provider = new MemoryProvider({ a: false, b: true }, autoReady); const client = createFeatureClient({ catalog, provider }); clients.push(client);
  const started = client.start({ targetId: 'user' }); if (autoReady) await started; else { void started.catch(() => {}); for (let i = 0; i < 12; i++) await Promise.resolve(); }
  return { provider, client, started };
}
describe('Angular boundaries', () => {
  it('does not instantiate disabled content and creates it once when enabled', async () => {
    const f = await setup(); const mounted = vi.fn();
    class Child { constructor() { mounted(); } }
    Component({ selector: 'test-child', standalone: true, template: 'on' })(Child);
    class Host { feature = signal('a'); }
    Component({ standalone: true, imports: [FeatureGateDirective, Child], template: '<test-child *featureGate="feature(); else: off" /><ng-template #off>off</ng-template>' })(Host);
    TestBed.configureTestingModule({ imports: [Host], providers: [provideZonelessChangeDetection(), { provide: FEATURE_CLIENT, useValue: f.client }] });
    const fixture = TestBed.createComponent(Host); fixture.detectChanges(); await fixture.whenStable();
    expect(mounted).not.toHaveBeenCalled(); expect(fixture.nativeElement.textContent).toBe('off');
    f.provider.current.set('a', true); fixture.detectChanges(); await fixture.whenStable(); expect(mounted).toHaveBeenCalledOnce();
    f.provider.current.notify(); fixture.detectChanges(); expect(mounted).toHaveBeenCalledOnce();
    fixture.componentInstance.feature.set('b'); fixture.detectChanges(); await fixture.whenStable();
    f.provider.current.set('a', false); fixture.detectChanges(); expect(fixture.nativeElement.textContent).toBe('on');
  });
  it('renders a pending template then switches to resolved content', async () => {
    const f = await setup(false);
    class Host {}
    Component({ standalone: true, imports: [FeatureGateDirective], template: '<span *featureGate="\'a\'; pending: loading">on</span><ng-template #loading>loading</ng-template>' })(Host);
    TestBed.configureTestingModule({ imports: [Host], providers: [provideZonelessChangeDetection(), { provide: FEATURE_CLIENT, useValue: f.client }] });
    const fixture = TestBed.createComponent(Host); fixture.detectChanges(); expect(fixture.nativeElement.textContent).toBe('loading');
    f.provider.current.set('a', true); f.provider.ready(); await f.started; fixture.detectChanges(); await fixture.whenStable(); expect(fixture.nativeElement.textContent).toBe('on');
  });
  it('redirects disabled direct navigation and permits enabled navigation', async () => {
    const f = await setup();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection(), provideRouter([]), { provide: FEATURE_CLIENT, useValue: f.client }] });
    const run = () => TestBed.runInInjectionContext(() => featureCanMatch({ path: 'a', data: { feature: 'a', disabledRedirect: '/home' } }, []));
    const off = await run(); expect(TestBed.inject(Router).serializeUrl(off as ReturnType<Router['parseUrl']>)).toBe('/home');
    f.provider.current.set('a', true); expect(await run()).toBe(true);
  });
  it('bounds route settlement and releases the temporary subscription', async () => {
    const f = await setup(false); const subscribe = vi.spyOn(f.client, 'subscribe');
    expect(await waitForFeature(f.client, 'a', 10)).toBe(false); expect(subscribe).toHaveBeenCalledOnce();
  });
  it('initializes standalone providers once and disposes on root destruction', async () => {
    const provider = new MemoryProvider({ a: true });
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection(), provideFeatures({ catalog, provider, initialContext: { targetId: 'user' } })] });
    const client = TestBed.inject(FEATURE_CLIENT); clients.push(client);
    await client.start({ targetId: 'user' }); expect(TestBed.inject(FEATURE_CLIENT)).toBe(client); expect(provider.sessions).toHaveLength(1);
    TestBed.resetTestingModule(); for (let i = 0; i < 10; i++) await Promise.resolve(); expect(provider.current.closed).toBe(true);
  });
  it('preserves the forRoot compatibility entry point', () => {
    const registration = FeatureFlagsModule.forRoot({ catalog, provider: new MemoryProvider(), initialContext: { targetId: 'user' } });
    expect(registration.ngModule).toBe(FeatureFlagsModule); expect(registration.providers).toHaveLength(1);
  });
});
