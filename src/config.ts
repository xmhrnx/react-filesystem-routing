import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { FileToFunction, PathFormatter, ResolvedConfig, UserConfig } from "./types.js";

export const DEFAULT_FUNCTIONS: Record<string, string> = {
  layout: "layout",
  loading: "loading",
  error: "error",
};

/** Default data-function file names (attached to the route rather than rendered). */
export const DEFAULT_LOADERS: Record<string, string> = {
  loader: "loader",
  action: "action",
};

export const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx"];

export const BUILTIN_ADAPTERS = ["react-router", "custom", "tanstack-router"] as const;

/** Default dynamic-segment formatting per adapter. */
export const DEFAULT_PATH_FORMATTERS: Record<string, PathFormatter> = {
  "react-router": { dynamic: (name) => `:${name}`, catchAll: (name) => `*${name}` },
  "tanstack-router": { dynamic: (name) => `$${name}`, catchAll: (name) => `*${name}` },
  custom: { dynamic: (name) => `:${name}`, catchAll: (name) => `*${name}` },
};

/** Typed identity helper for config files (provides intellisense without changing values). */
export function defineConfig(config: UserConfig): UserConfig {
  return config;
}

/** Resolve a possibly-relative path against a base directory. */
export function toAbsolute(path: string, base: string): string {
  return isAbsolute(path) ? path : resolve(base, path);
}

/** Normalize a user "functions" mapping into a callable file-name -> function-name mapper. */
export function resolveFunctionMapper(
  functions: Record<string, string> | FileToFunction | undefined,
): FileToFunction {
  if (typeof functions === "function") return functions;
  const map = functions ?? DEFAULT_FUNCTIONS;
  return (name: string) => map[name] ?? null;
}

/** Normalize a user "loaders" mapping into a callable file-name -> data-function-name mapper. */
export function resolveLoaderMapper(
  loaders: Record<string, string> | FileToFunction | undefined,
): FileToFunction {
  if (typeof loaders === "function") return loaders;
  const map = loaders ?? DEFAULT_LOADERS;
  return (name: string) => map[name] ?? null;
}

/** Merge user config with defaults and resolve all paths to absolute. */
export function resolveConfig(user: UserConfig = {}, cwd: string = process.cwd()): ResolvedConfig {
  const pages = toAbsolute(user.pages ?? "src/pages", cwd);
  const outDir = toAbsolute(user.outDir ?? pages, cwd);
  const adapter = user.adapter ?? "react-router";
  if (!(BUILTIN_ADAPTERS as readonly string[]).includes(adapter)) {
    console.warn(
      `[react-fs-router] Unknown adapter "${adapter}" (expected one of ${BUILTIN_ADAPTERS.join(", ")}); ` +
        `generating "custom" adapter output.`,
    );
  }
  const outFileName = user.outFileName ?? "routes.tsx";
  if (!outFileName.endsWith(".tsx")) {
    throw new Error(
      `[react-fs-router] outFileName "${outFileName}" must end in ".tsx": the generated module contains TypeScript and JSX.`,
    );
  }
  const defaultFormatter = DEFAULT_PATH_FORMATTERS[adapter] ?? DEFAULT_PATH_FORMATTERS["react-router"];

  return {
    pages,
    outDir,
    outFile: toAbsolute(outFileName, outDir),
    adapter,
    fileToFunction: resolveFunctionMapper(user.functions),
    fileToLoader: resolveLoaderMapper(user.loaders),
    extensions: user.extensions ?? DEFAULT_EXTENSIONS,
    ignore: user.ignore ?? [],
    ignorePrefix: user.ignorePrefix ?? "_",
    ignoreDotFiles: user.ignoreDotFiles ?? true,
    inheritLayout: user.inheritLayout ?? true,
    legacyBrowserRouter: user.legacyBrowserRouter ?? false,
    pathFormatter: {
      dynamic: user.formatDynamicSegment ?? defaultFormatter.dynamic,
      catchAll: user.formatCatchAllSegment ?? defaultFormatter.catchAll,
    },
    importPrefix: user.importPrefix ?? null,
  };
}

/** Config file names looked up (in order) when no explicit config path is given. */
export const DEFAULT_CONFIG_FILES = ["rfr.config.ts", "rfr.config.mts", "rfr.config.js", "rfr.config.mjs"];

/** Find the first default config file that exists in `cwd`, if any. */
export function findConfigFile(cwd: string = process.cwd()): string | null {
  for (const name of DEFAULT_CONFIG_FILES) {
    const file = resolve(cwd, name);
    if (existsSync(file)) return file;
  }
  return null;
}

/**
 * Load a config module (.ts or .js). Supports `export default {...}` or a
 * named `export const config`. Loading a .ts config needs a Node version that
 * can import TypeScript natively (22.18+/23.6+, or 22.6+ with
 * --experimental-strip-types); otherwise use a .js/.mjs config.
 */
export async function loadConfig(configPath: string): Promise<UserConfig> {
  let mod: unknown;
  try {
    mod = await import(pathToFileURL(resolve(configPath)).href);
  } catch (err) {
    if ((err as { code?: string }).code === "ERR_UNKNOWN_FILE_EXTENSION" && /\.[cm]?ts$/.test(configPath)) {
      throw new Error(
        `[react-fs-router] This Node version (${process.version}) cannot load the TypeScript config "${configPath}". ` +
          `Use Node 22.18+ / 23.6+, or rename it to rfr.config.js (or .mjs).`,
        { cause: err },
      );
    }
    throw err;
  }
  const namespace = mod as { default?: unknown; config?: unknown };
  const raw = namespace.default ?? namespace.config ?? mod;

  if (raw && typeof raw === "object") return raw as UserConfig;
  throw new Error(
    `Config file "${configPath}" must export a config object (default export or named "config").`,
  );
}

/**
 * Resolve the config for a bundler plugin: load the optional config file
 * (relative to `cwd`), then merge the inline `userConfig` over it.
 */
export async function loadPluginConfig(
  options: { config?: string; userConfig?: UserConfig },
  cwd: string,
): Promise<ResolvedConfig> {
  const fromFile = options.config ? await loadConfig(resolve(cwd, options.config)) : {};
  return resolveConfig({ ...fromFile, ...options.userConfig }, cwd);
}
