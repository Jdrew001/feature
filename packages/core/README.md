# @feature-gates/core

Internal reusable feature gate core package. Version 0.1.2.

The public declarations support TypeScript 4.9 and newer. Catalog helpers preserve
feature-name inference without requiring TypeScript 5 const type parameters.

Create a typed catalog with defineFeatures(), then createFeatureClient({ catalog, provider }). The application shell calls start({ targetId, attributes }), setContext(), retry(), and dispose(). Feature code consumes getSnapshot(), subscribe(), and whenSettled(). No environment parameter exists.

## Module formats

Version 0.1.2 supports both ES modules and CommonJS. The package's conditional exports
select matching JavaScript and declarations for `import` and `require`. Older TypeScript
consumers can continue resolving the top-level `types` declaration without TypeScript 5 generics.
