# @feature-gates/core

Internal reusable feature gate core package. Version 0.1.0.

Create a typed catalog with defineFeatures(), then createFeatureClient({ catalog, provider }). The application shell calls start({ targetId, attributes }), setContext(), retry(), and dispose(). Feature code consumes getSnapshot(), subscribe(), and whenSettled(). No environment parameter exists.
