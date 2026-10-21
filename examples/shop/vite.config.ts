import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The bugcapsule CLI builds with BUGCAPSULE_GIT_SHA / BUGCAPSULE_GIT_DIRTY set;
// expose them so capsules and replay reports carry the commit.
export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_BUGCAPSULE_GIT_SHA': JSON.stringify(process.env.BUGCAPSULE_GIT_SHA ?? ''),
    'import.meta.env.VITE_BUGCAPSULE_GIT_DIRTY': JSON.stringify(process.env.BUGCAPSULE_GIT_DIRTY ?? ''),
  },
  build: { sourcemap: true },
});
