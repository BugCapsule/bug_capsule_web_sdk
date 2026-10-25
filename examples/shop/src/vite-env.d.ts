/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_BUGCAPSULE_TOKEN?: string;
  readonly VITE_BUGCAPSULE_BACKEND_URL?: string;
  readonly VITE_BUGCAPSULE_INGEST_KEY?: string;
  readonly VITE_BUGCAPSULE_GIT_SHA?: string;
  readonly VITE_BUGCAPSULE_GIT_DIRTY?: string;
  readonly VITE_BUGCAPSULE_ALLOW_REPLAY?: string;
  readonly VITE_BUGCAPSULE_DEMO_FIX?: string;
  readonly VITE_SHOP_API_URL?: string;
}
