import * as Sentry from '@sentry/browser';
import * as sdk from '../../packages/web/src/index.js';
import * as core from '../../packages/web/src/core/index.js';

// The real @sentry/browser next to one BugCapsule SDK instance (the companion must share it).
Object.assign(window as unknown as Record<string, unknown>, { BC: sdk, BCCore: core, Sentry });
