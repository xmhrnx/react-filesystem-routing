import { watch, type FSWatcher } from "chokidar";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isIgnoredName } from "./scanner.js";
import type { ResolvedConfig } from "./types.js";

/**
 * Whether a watched path cannot affect the generated routes: the generated
 * file itself, or anything the scanner would skip (judged by the path's
 * segments *relative to the pages directory*, so that dot-directories above
 * the project, such as `~/.projects/app`, don't hide every file).
 */
export function isIrrelevantPath(path: string, config: ResolvedConfig): boolean {
  const absolute = resolve(config.pages, path);
  if (absolute === config.outFile) return true;
  const rel = relative(config.pages, absolute);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
  return rel.split(sep).some((segment) => isIgnoredName(segment, config));
}

/**
 * Watch the pages directory for structural changes (files or directories
 * added or removed) and call `onChange` for each. Content edits are ignored:
 * routes depend only on file names, never on file contents. Existing files do
 * not trigger events on startup.
 */
export function watchPages(config: ResolvedConfig, onChange: () => void): FSWatcher {
  const watcher = watch(config.pages, {
    ignoreInitial: true,
    ignored: (path: string) => isIrrelevantPath(path, config),
  });
  for (const event of ["add", "unlink", "addDir", "unlinkDir"] as const) {
    watcher.on(event, onChange);
  }
  return watcher;
}
