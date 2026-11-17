import type { FSWatcher } from "chokidar";
import { loadPluginConfig } from "./config.js";
import { updateRoutes } from "./generator.js";
import type { ResolvedConfig, UserConfig } from "./types.js";
import { watchPages } from "./watch.js";

export interface WebpackPluginOptions {
  /** Path to a config file, relative to the webpack `context`. */
  config?: string;
  /** Inline config, merged over the config file (if any) and the defaults. */
  userConfig?: UserConfig;
}

interface MinimalCompiler {
  context?: string;
  hooks: {
    beforeRun: { tapPromise: (name: string, fn: () => Promise<void>) => void };
    watchRun: { tapPromise: (name: string, fn: () => Promise<void>) => void };
    watchClose: { tap: (name: string, fn: () => void) => void };
  };
}

const PLUGIN_NAME = "ReactFsRouterWebpackPlugin";

/**
 * Webpack plugin: generates the routes module before each build. In watch
 * mode it also watches the pages directory, so that adding or removing a page
 * regenerates the module (which webpack then picks up as a normal change).
 * One-off builds start no watcher, so the process can exit.
 */
export class ReactFsRouterWebpackPlugin {
  private watcher?: FSWatcher;
  private config?: Promise<ResolvedConfig>;

  constructor(private options: WebpackPluginOptions = {}) {}

  apply(compiler: MinimalCompiler): void {
    const getConfig = (): Promise<ResolvedConfig> =>
      (this.config ??= loadPluginConfig(this.options, compiler.context ?? process.cwd()));

    compiler.hooks.beforeRun.tapPromise(PLUGIN_NAME, async () => {
      updateRoutes(await getConfig());
    });

    compiler.hooks.watchRun.tapPromise(PLUGIN_NAME, async () => {
      const config = await getConfig();
      updateRoutes(config);
      this.watcher ??= watchPages(config, () => {
        try {
          updateRoutes(config);
        } catch (err) {
          console.error("[react-fs-router]", err);
        }
      });
    });

    compiler.hooks.watchClose.tap(PLUGIN_NAME, () => {
      void this.watcher?.close();
      this.watcher = undefined;
    });
  }
}
