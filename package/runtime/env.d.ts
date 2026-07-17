interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
}

interface ImportMetaHot {
  dispose(callback: () => void): void;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
  readonly hot?: ImportMetaHot;
}
