# @feature-gates/harness

Internal reusable feature gate harness package. Version 0.1.0.

createHarnessProvider({ sdkKey }) receives a runtime-injected Harness browser SDK key. Its provider implements the core contract. Persistent caching is disabled and failed evaluation/connection states use catalog fallbacks. Requires @harnessio/ff-javascript-client-sdk ^1.32.0.
