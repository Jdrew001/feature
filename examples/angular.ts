import { Component, inject, provideZonelessChangeDetection } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { FeatureGateDirective, FeatureState, createFeatureRoute, provideFeatures } from '@feature-gates/angular';
import { createHarnessProvider } from '@feature-gates/harness';
import type { EvaluationContext } from '@feature-gates/core';
import { features } from './catalog.js';
import type { FeatureName } from './catalog.js';
import { loadRuntimeConfig } from './runtime-config.js';

@Component({ selector: 'app-reports', standalone: true, template: '<h1>Advanced reports</h1>' })
export class ReportsComponent {}
@Component({
  selector: 'app-root', standalone: true, imports: [FeatureGateDirective, ReportsComponent],
  template: '<app-reports *featureGate="reportsFeature; pending: loading" /><ng-template #loading>Loading features…</ng-template>',
})
export class AppComponent {
  readonly reportsFeature: FeatureName = 'advancedReports';
  readonly reportsDecision = inject(FeatureState).decision(this.reportsFeature);
}
const featureRoute = createFeatureRoute<FeatureName>();
export async function bootstrapAngular(context: EvaluationContext) {
  const runtime = await loadRuntimeConfig();
  return bootstrapApplication(AppComponent, {
    providers: [
      provideZonelessChangeDetection(),
      provideFeatures({ catalog: features, provider: createHarnessProvider({ sdkKey: runtime.harnessSdkKey }), initialContext: context }),
      provideRouter([featureRoute('advancedReports', { path: 'reports', component: ReportsComponent })]),
    ],
  });
}
// Pass the stable target identifier and attributes from your authentication shell.
// Login, logout, and tenant changes use inject(FEATURE_CLIENT).setContext(nextContext).
// ApplicationRef.destroy() triggers client disposal through the root DestroyRef.
