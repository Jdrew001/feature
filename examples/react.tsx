import { createRoot } from 'react-dom/client';
import { FeatureProvider, createFeatureBindings } from '@feature-gates/react';
import { createFeatureClient } from '@feature-gates/core';
import type { EvaluationContext } from '@feature-gates/core';
import { createHarnessProvider } from '@feature-gates/harness';
import { features } from './catalog.js';
import type { FeatureName } from './catalog.js';
import { loadRuntimeConfig } from './runtime-config.js';
const { FeatureGate } = createFeatureBindings<FeatureName>();
function AdvancedReports() { return <h1>Advanced reports</h1>; }
export async function bootstrapReact(element: HTMLElement, context: EvaluationContext) {
  const runtime = await loadRuntimeConfig();
  const client = createFeatureClient({ catalog: features, provider: createHarnessProvider({ sdkKey: runtime.harnessSdkKey }) });
  const started = client.start(context);
  const root = createRoot(element);
  root.render(<FeatureProvider reader={client}><FeatureGate feature="advancedReports" pending="Loading features…"><AdvancedReports /></FeatureGate></FeatureProvider>);
  await started;
  return {
    setContext: (next: EvaluationContext) => client.setContext(next),
    retry: () => client.retry(),
    async destroy() { root.unmount(); await client.dispose(); },
  };
}
