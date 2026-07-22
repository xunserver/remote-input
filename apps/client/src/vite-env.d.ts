/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PROTOCOL_DEBUG?:
    | "summary"
    | "chunks"
    | "off"
    | "true"
    | "false"
    | "1"
    | "0";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
