/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly VITE_JAZZ_APP_ID?: string;
  readonly VITE_JAZZ_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __LOFI_JAZZ_APP_ID__: string;
declare const __LOFI_JAZZ_SERVER_URL__: string;
