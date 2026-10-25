import { BugCapsule, historyIntegration, localStorageIntegration, networkIntegration } from '@bugcapsule/web';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadSavedCart } from './shop';

const env = import.meta.env;

// First thing the app does: replay restores storage and state here.
await BugCapsule.init({
  appId: 'com.bugcapsule.shop.web',
  appName: 'BugCapsule Shop (web)',
  appVersion: '1.0.0',
  appBuild: '1',
  mode: 'qa',
  gitSha: env.VITE_BUGCAPSULE_GIT_SHA || undefined,
  gitDirty: env.VITE_BUGCAPSULE_GIT_DIRTY === 'true',
  // One SDK token from the dashboard is all a connection needs.
  token: env.VITE_BUGCAPSULE_TOKEN || undefined,
  // The pre-token setup (explicit backend URL + ingest key) still works and wins when set.
  backend:
    env.VITE_BUGCAPSULE_BACKEND_URL && env.VITE_BUGCAPSULE_INGEST_KEY
      ? { url: env.VITE_BUGCAPSULE_BACKEND_URL, ingestKey: env.VITE_BUGCAPSULE_INGEST_KEY }
      : undefined,
  integrations: [
    networkIntegration({
      // Checkout bodies carry a timestamp and nonce that differ on every run.
      rules: [{ method: 'POST', path: '/api/checkout', ignoreBodyFields: ['timestamp', 'nonce'] }],
    }),
    historyIntegration(),
    localStorageIntegration({ allowPrefixes: ['shop.'] }),
  ],
  // QA/test builds only: lets `bugcapsule run|verify` drive this build.
  allowReplay: env.DEV || env.VITE_BUGCAPSULE_ALLOW_REPLAY === 'true',
});

// Bug 3 (state-restoration-dependent): a cart saved by v0.9 crashes here.
loadSavedCart();

createRoot(document.getElementById('root')!).render(<App />);
