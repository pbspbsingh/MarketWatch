import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

export async function createTestServer() {
  const cacheDir = await mkdtemp(join(tmpdir(), "marketwatch-vite-tests-"));
  try {
    const server = await createServer({
      root: fileURLToPath(new URL("../", import.meta.url)),
      configFile: false,
      cacheDir,
      // These servers only load modules in Node. Never rewrite the browser's dependency bundles.
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true, hmr: false, ws: false },
      appType: "custom",
    });
    return {
      ssrLoadModule: server.ssrLoadModule.bind(server),
      async close() {
        try { await server.close(); }
        finally { await rm(cacheDir, { recursive: true, force: true }); }
      },
    };
  } catch (error) {
    await rm(cacheDir, { recursive: true, force: true });
    throw error;
  }
}
