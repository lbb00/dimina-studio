#!/usr/bin/env node

// Single source of truth for which workspace packages are npm-publishable.
// Order matters: dependency-first so consumers resolve already-published versions.
// compiler → dimina-electron-runtime → devkit → inspect → design →
// devtools.
//
// Consumed by both bump-dev-version.js (version bump) and publish-packages.js
// (actual publish) — a package missing here silently skips both dev-suffix
// versioning and publication, so add new publishable packages only here.
export const NPM_PACKAGES = [
  { name: '@dimina-studio/compiler', dir: 'packages/compiler' },
  { name: '@dimina-studio/electron-runtime', dir: 'packages/dimina-electron-runtime' },
  { name: '@dimina-studio/devkit', dir: 'packages/devkit' },
  { name: '@dimina-studio/inspect', dir: 'packages/inspect' },
  { name: '@dimina-studio/design', dir: 'packages/design' },
  { name: '@dimina-studio/devtools', dir: 'packages/devtools' },
]
