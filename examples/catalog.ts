import { defineFeatures } from '@feature-gates/core';
export const features = defineFeatures({
  advancedReports: { providerKey: 'reports.advanced', fallback: false, owner: 'reporting' },
  checkoutV2: { providerKey: 'checkout.v2', fallback: false, owner: 'checkout' },
});
export type FeatureName = keyof typeof features;
