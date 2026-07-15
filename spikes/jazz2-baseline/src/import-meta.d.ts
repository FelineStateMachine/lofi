interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly VITE_JAZZ_APP_ID?: string;
  readonly VITE_JAZZ_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
