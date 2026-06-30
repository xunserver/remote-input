import typescript from "@rollup/plugin-typescript";

export default {
  input: "sdk/src/index.ts",
  output: {
    file: "web/remote-input-sdk.js",
    format: "umd",
    name: "RemoteInput",
    sourcemap: false,
    exports: "named",
  },
  plugins: [
    typescript({
      tsconfig: "./tsconfig.json",
    }),
  ],
};
