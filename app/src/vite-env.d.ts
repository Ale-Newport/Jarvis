/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_JARVIS_BACKEND?: string;
  readonly VITE_JARVIS_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
