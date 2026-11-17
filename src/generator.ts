import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, normalize, relative } from "node:path";
import type { ResolvedConfig, RouteMeta, RouteNode } from "./types.js";
import { scanDirectory } from "./tree.js";

interface FileRegistry {
  fileToId: Map<string, string>;
}

/**
 * Words that cannot be used as a binding name in an ES module (strict mode),
 * plus `undefined`/`NaN`/`Infinity`/`arguments`/`eval` which are legal-ish but
 * would shadow globals or be rejected.
 */
const RESERVED_WORDS = new Set([
  "arguments", "await", "break", "case", "catch", "class", "const", "continue",
  "debugger", "default", "delete", "do", "else", "enum", "eval", "export",
  "extends", "false", "finally", "for", "function", "if", "implements", "import",
  "in", "Infinity", "instanceof", "interface", "let", "NaN", "new", "null",
  "package", "private", "protected", "public", "return", "static", "super",
  "switch", "this", "throw", "true", "try", "typeof", "undefined", "var", "void",
  "while", "with", "yield",
]);

/** Sanitize arbitrary text into a valid, non-reserved JS identifier. */
export function toSafeIdentifier(text: string): string {
  const cleaned = text.replace(/[^A-Za-z0-9_$]/g, "_");
  if (!/^[A-Za-z_$]/.test(cleaned) || RESERVED_WORDS.has(cleaned)) return "_" + cleaned;
  return cleaned;
}

/** Convert a file base name into a valid JS identifier. */
export function toIdentifier(file: string): string {
  return toSafeIdentifier(basename(file, extname(file)));
}

/** Top-level names declared or imported by the generated routes module. */
const GENERATED_MODULE_NAMES = [
  "routes", "routesMeta", "routingMeta", "ignoreIdentifier", "ROUTES", "routeObjects",
  "routeTree", "Router", "FileSystemRouter", "resolveRoutes", "reactRouterAdapter",
  "reactRouterDataAdapter", "toRouteObjects", "toDataRouterObjects", "tanstackRouterAdapter",
  "toTanstackRouteTree", "RouteEntry", "ResolvedRoute", "ReactNode",
];

/** Assign a unique, readable import identifier to every referenced file. */
export function buildFileRegistry(tree: RouteNode[]): FileRegistry {
  const fileToId = new Map<string, string>();
  // Names the generated module declares or imports itself must not be reused.
  const used = new Set<string>(GENERATED_MODULE_NAMES);

  const register = (file: string): void => {
    if (fileToId.has(file)) return;
    const base = toIdentifier(file);
    let id = base;
    let i = 1;
    while (used.has(id)) id = `${base}${i++}`;
    used.add(id);
    fileToId.set(file, id);
  };

  const visit = (nodes: RouteNode[]): void => {
    for (const node of nodes) {
      if (node.component) register(node.component);
      if (node.layout) register(node.layout);
      for (const fn of Object.values(node.functions)) register(fn);
      for (const fn of Object.values(node.loaders)) register(fn);
      visit(node.children);
    }
  };

  visit(tree);
  return { fileToId };
}

/** Compute the import specifier for a file, relative to the generated file (or aliased). */
export function importSpecifier(file: string, config: ResolvedConfig): string {
  const noExt = file.replace(/\.[^.]+$/, "");

  if (config.importPrefix) {
    const rel = normalize(relative(config.pages, noExt)).replace(/[\\/]/g, "/");
    return `${config.importPrefix}/${rel}`.replace(/\/{2,}/g, "/");
  }

  const rel = normalize(relative(dirname(config.outFile), noExt)).replace(/[\\/]/g, "/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function toRouteMeta(node: RouteNode, config: ResolvedConfig): RouteMeta {
  return {
    type: node.type,
    path: node.path,
    component: node.component ? importSpecifier(node.component, config) : null,
    layout: node.layout ? importSpecifier(node.layout, config) : null,
    functions: Object.fromEntries(
      Object.entries(node.functions).map(([name, file]) => [name, importSpecifier(file, config)]),
    ),
    loaders: Object.fromEntries(
      Object.entries(node.loaders).map(([name, file]) => [name, importSpecifier(file, config)]),
    ),
    children: node.children.map((child) => toRouteMeta(child, config)),
  };
}

export type RouteSegmentKind = "literal" | "param" | "catch";

/** A parsed segment of a formatted route path (e.g. "/users/:id/edit"). */
export interface RouteSegment {
  kind: RouteSegmentKind;
  /** Literal text, param name, or catch-all name. */
  name: string;
}

/**
 * Split a formatted route path into segments. Dynamic segments start with
 * ":" (react-router/custom) or "$" (tanstack); catch-all segments start with "*".
 */
export function parseRouteSegments(path: string): RouteSegment[] {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      if (segment.startsWith(":") || segment.startsWith("$")) {
        return { kind: "param", name: segment.slice(1) };
      }
      if (segment.startsWith("*")) {
        return { kind: "catch", name: segment.slice(1) };
      }
      return { kind: "literal", name: segment };
    });
}

/** Turn a segment into an uppercase object-key token ("about" -> "ABOUT"). */
export function segmentToken(segment: RouteSegment): string {
  const raw = segment.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return raw.replace(/^_+|_+$/g, "");
}

/** Build an object key from path segments; the root index route is "HOME". */
export function routeKeyForSegments(segments: RouteSegment[]): string {
  const key = segments.map(segmentToken).filter(Boolean).join("_");
  return key || "HOME";
}

/** An addressable route's entry in the generated `ROUTES` navigation map. */
export interface RouteMapEntry {
  key: string;
  path: string;
  segments: RouteSegment[];
  /** Param/catch-all names in path order (the function's arguments). */
  params: string[];
  hasCatch: boolean;
  /**
   * Set when the natural key was already taken by another route (e.g.
   * "/my-page" and "/my_page" both sanitize to MY_PAGE): the original key,
   * while `key` holds the numbered replacement (MY_PAGE_2).
   */
  renamedFrom?: string;
}

/**
 * Collect every addressable route (files and directories that have an index
 * page) into `ROUTES` entries. Routes whose sanitized keys collide get a
 * numbered suffix (`_2`, `_3`, ...) so that no route is dropped.
 */
export function routeMapEntries(tree: RouteNode[]): RouteMapEntry[] {
  const entries: RouteMapEntry[] = [];
  const seen = new Set<string>();

  const visit = (nodes: RouteNode[]): void => {
    for (const node of nodes) {
      const addressable =
        node.type === "file" || (node.type === "directory" && node.component !== null);
      if (addressable) {
        const segments = parseRouteSegments(node.path);
        const baseKey = routeKeyForSegments(segments);
        let key = baseKey;
        for (let i = 2; seen.has(key); i++) key = `${baseKey}_${i}`;
        seen.add(key);
        entries.push({
          key,
          path: node.path,
          segments,
          params: segments.filter((s) => s.kind !== "literal").map((s) => s.name),
          hasCatch: segments.some((s) => s.kind === "catch"),
          ...(key !== baseKey ? { renamedFrom: baseKey } : {}),
        });
      }
      visit(node.children);
    }
  };

  visit(tree);
  return entries;
}

/** Escape text for literal inclusion in a JS template literal. */
function escapeTemplateText(text: string): string {
  return text.replace(/[\\`]/g, "\\$&").replace(/\$\{/g, "\\${");
}

function routeMapValueSource(entry: RouteMapEntry): string {
  if (entry.params.length === 0) return JSON.stringify(entry.path);

  const used = new Set<string>();
  const uniqueJsName = (name: string): string => {
    let id = toSafeIdentifier(name);
    while (used.has(id)) id += "_";
    used.add(id);
    return id;
  };

  // Param values are URL-encoded so that e.g. "a/b" stays a single segment.
  let template = "/";
  const args: string[] = [];
  for (const segment of entry.segments) {
    if (segment.kind === "literal") {
      template += escapeTemplateText(segment.name) + "/";
    } else if (segment.kind === "param") {
      const id = uniqueJsName(segment.name);
      args.push(`${id}: string | number`);
      template += "${encodeURIComponent(" + id + ")}/";
    } else {
      const id = uniqueJsName(segment.name);
      args.push(`...${id}: (string | number)[]`);
      template += "${" + id + ".map((s) => encodeURIComponent(s)).join('/')}";
    }
  }
  if (template.endsWith("/")) template = template.slice(0, -1);

  return `(${args.join(", ")}) => \`${template}\``;
}

/** Render the body of `export const ROUTES = { ... }` for the given entries. */
export function routeMapSource(entries: RouteMapEntry[]): string {
  return entries
    .map((entry) => `${JSON.stringify(entry.key)}: ${routeMapValueSource(entry)}`)
    .join(",\n");
}

function routeEntrySource(node: RouteNode, registry: FileRegistry): string {
  const component = node.component ? (registry.fileToId.get(node.component) ?? "null") : "null";
  const layout = node.layout ? (registry.fileToId.get(node.layout) ?? "null") : "null";
  const functions = Object.entries(node.functions)
    .map(([name, file]) => `${JSON.stringify(name)}: ${registry.fileToId.get(file) ?? "null"}`)
    .join(", ");
  const loaders = Object.entries(node.loaders)
    .map(([name, file]) => `${JSON.stringify(name)}: ${registry.fileToId.get(file) ?? "null"}`)
    .join(", ");
  const children = node.children.map((child) => routeEntrySource(child, registry)).join(", ");

  return `{ type: ${JSON.stringify(node.type)}, path: ${JSON.stringify(node.path)}, component: ${component}, layout: ${layout}, functions: { ${functions} }, loaders: { ${loaders} }, children: [${children}] }`;
}

function importsSource(registry: FileRegistry, config: ResolvedConfig): string {
  return [...registry.fileToId.entries()]
    .map(([file, id]) => `import ${id} from ${JSON.stringify(importSpecifier(file, config))};`)
    .join("\n");
}

/** Generate the routes module source for the resolved config. */
export function generateRoutesModule(config: ResolvedConfig): string {
  const tree = scanDirectory(config.pages, config);
  const registry = buildFileRegistry(tree);

  const routeEntries = tree.map((node) => routeEntrySource(node, registry)).join(",\n");
  const routesMeta = JSON.stringify(tree.map((node) => toRouteMeta(node, config)), null, 2);
  const imports = importsSource(registry, config);

  const isReactRouter = config.adapter === "react-router";
  const isTanstack = config.adapter === "tanstack-router";
  // Data router (route objects) is the default; opt into the legacy declarative
  // `<BrowserRouter>` component with `legacyBrowserRouter: true`.
  const legacyBrowserRouter = config.legacyBrowserRouter;

  const reactRouterImports = legacyBrowserRouter
    ? [
        'import { FileSystemRouter, resolveRoutes } from "react-fs-router/render";',
        'import { reactRouterAdapter, toRouteObjects } from "react-fs-router/adapters/react-router";',
        'import type { RouteEntry } from "react-fs-router/render";',
      ]
    : [
        'import { FileSystemRouter, resolveRoutes } from "react-fs-router/render";',
        'import { reactRouterDataAdapter, toDataRouterObjects } from "react-fs-router/adapters/react-router";',
        'import type { RouteEntry } from "react-fs-router/render";',
      ];

  const tanstackImports = [
    'import { FileSystemRouter, resolveRoutes } from "react-fs-router/render";',
    'import { tanstackRouterAdapter, toTanstackRouteTree } from "react-fs-router/adapters/tanstack";',
    'import type { RouteEntry } from "react-fs-router/render";',
  ].join("\n");

  const customImports = [
    'import { FileSystemRouter } from "react-fs-router/render";',
    'import type { RouteEntry, ResolvedRoute } from "react-fs-router/render";',
    'import type { ReactNode } from "react";',
  ].join("\n");

  const libImports = isReactRouter
    ? reactRouterImports.join("\n")
    : isTanstack
      ? tanstackImports
      : customImports;

  const routesBlock = `const routes: RouteEntry[] = [\n${routeEntries}\n];`;
  const routesMetaBlock = `export const routesMeta = ${routesMeta};`;

  const routingMetaBlock = `export const routingMeta = ${JSON.stringify(
    {
      adapter: config.adapter,
      ignorePrefix: config.ignorePrefix,
      ignoreDotFiles: config.ignoreDotFiles,
      ignore: config.ignore,
      inheritLayout: config.inheritLayout,
      legacyBrowserRouter: config.legacyBrowserRouter,
    },
    null,
    2,
  )};`;

  // Standalone identifier so consumers can read the resolved ignore prefix
  // (the leading character that marks a file as ignored) without parsing
  // routingMeta.
  const ignoreIdentifierBlock = `export const ignoreIdentifier = ${JSON.stringify(config.ignorePrefix)};`;

  // Navigation map: static paths are constants, dynamic paths are functions
  // that build the URL from their arguments (e.g. ROUTES.USERS_ID(14)).
  const mapEntries = routeMapEntries(tree);
  for (const entry of mapEntries) {
    if (entry.renamedFrom) {
      console.warn(
        `[react-fs-router] ROUTES key "${entry.renamedFrom}" is used by more than one route; ` +
          `"${entry.path}" is available as ROUTES.${entry.key}.`,
      );
    }
  }
  const routesObjectBlock = `export const ROUTES = {\n${routeMapSource(mapEntries)}\n} as const;`;

  const inheritLayout = JSON.stringify(config.inheritLayout);
  const reactRouterAdapterName = legacyBrowserRouter ? "reactRouterAdapter" : "reactRouterDataAdapter";
  const defaultExport = isReactRouter
    ? `export default function Router() {\n  return <FileSystemRouter routes={routes} inheritLayout={${inheritLayout}} adapter={${reactRouterAdapterName}} />;\n}`
    : isTanstack
      ? `export default function Router() {\n  return <FileSystemRouter routes={routes} inheritLayout={${inheritLayout}} adapter={tanstackRouterAdapter} />;\n}`
      : `export default function Router({ renderRoutes }: { renderRoutes?: (routes: ResolvedRoute[]) => ReactNode }) {\n  return <FileSystemRouter routes={routes} inheritLayout={${inheritLayout}} renderRoutes={renderRoutes} />;\n}`;

  const routeObjectsConverter = legacyBrowserRouter ? "toRouteObjects" : "toDataRouterObjects";
  const routeObjectsBlock = isReactRouter
    ? `export const routeObjects = ${routeObjectsConverter}(resolveRoutes(routes, ${inheritLayout}));`
    : "";
  const routeTreeBlock = isTanstack
    ? `export const routeTree = toTanstackRouteTree(resolveRoutes(routes, ${inheritLayout}));`
    : "";

  return [
    "// Generated by react-fs-router. Do not edit.",
    libImports,
    imports,
    "",
    routesBlock,
    "",
    routesMetaBlock,
    "",
    routingMetaBlock,
    ignoreIdentifierBlock,
    routesObjectBlock,
    routeObjectsBlock,
    routeTreeBlock,
    "",
    defaultExport,
    "",
  ].join("\n");
}

/**
 * Generate the routes module and write it to disk if its content changed.
 * Returns true when the file was (re)written. Skipping identical writes keeps
 * file watchers (ours, Vite's, webpack's) from re-triggering on no-op output.
 */
export function updateRoutes(config: ResolvedConfig): boolean {
  const source = generateRoutesModule(config);
  if (existsSync(config.outFile) && readFileSync(config.outFile, "utf8") === source) return false;
  mkdirSync(dirname(config.outFile), { recursive: true });
  writeFileSync(config.outFile, source, "utf8");
  return true;
}

/** Generate the routes module and write it to disk. Returns the output file path. */
export function writeRoutes(config: ResolvedConfig): string {
  updateRoutes(config);
  return config.outFile;
}
