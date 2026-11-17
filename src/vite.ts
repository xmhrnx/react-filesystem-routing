import type { Plugin, ResolvedConfig as ViteResolvedConfig, ViteDevServer } from "vite";
import { loadPluginConfig } from "./config.js";
import { updateRoutes } from "./generator.js";
import type { ResolvedConfig, UserConfig } from "./types.js";
import { watchPages } from "./watch.js";

export interface VitePluginOptions {
  /** Path to a config file, relative to the Vite root. */
  config?: string;
  /** Inline config, merged over the config file (if any) and the defaults. */
  userConfig?: UserConfig;
}

/**
 * Vite plugin: generates the routes module on startup, and again whenever a
 * file or directory is added to or removed from the pages directory.
 */
export function reactFsRouter(options: VitePluginOptions = {}): Plugin {
  let resolved: ResolvedConfig | undefined;

  return {
    name: "react-fs-router",
    async configResolved(viteConfig: ViteResolvedConfig) {
      resolved = await loadPluginConfig(options, viteConfig.root);
      updateRoutes(resolved);
    },
    buildStart() {
      if (resolved) updateRoutes(resolved);
    },
    configureServer(server: ViteDevServer) {
      if (!resolved) return;
      const current = resolved;
      const watcher = watchPages(current, () => {
        try {
          if (updateRoutes(current)) server.ws.send({ type: "full-reload" });
        } catch (err) {
          server.config.logger.error(`[react-fs-router] ${(err as Error).message}`);
        }
      });
      server.httpServer?.once("close", () => void watcher.close());
    },
  };
}
