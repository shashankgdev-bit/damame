import { defineConfig } from "tsup";

/**
 * The published package is fully self-contained: every workspace package and
 * runtime dep (commander, picocolors, zod) is bundled in, so `npm install
 * damame` pulls zero dependencies. app.html is copied alongside the bundle by
 * the build script — the server reads it via `new URL("./app.html",
 * import.meta.url)`, which resolves to dist/ in the bundle and src/ui/ in dev.
 */
export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "dist",
  clean: true,
  noExternal: [/.*/],
  banner: {
    // shebang + createRequire shim: bundled CJS deps (commander) call
    // require('node:events') etc., which ESM output must provide.
    js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
