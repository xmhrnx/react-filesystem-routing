// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findConfigFile, loadPluginConfig, resolveConfig } from "./config.js";
import { generateRoutesModule, toIdentifier, updateRoutes } from "./generator.js";
import { scanDirectory } from "./tree.js";
import { isIrrelevantPath } from "./watch.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rfr-reg-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function page(rel: string, body = "export default function P() { return null; }"): void {
  const file = join(dir, "pages", rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, body);
}

function config(extra: Parameters<typeof resolveConfig>[0] = {}) {
  return resolveConfig({ pages: join(dir, "pages"), ...extra }, dir);
}

/** Syntax errors reported when transpiling the generated TSX module. */
function syntaxErrors(source: string): string[] {
  const out = ts.transpileModule(source, {
    reportDiagnostics: true,
    fileName: "routes.tsx",
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext },
  });
  return (out.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

describe("generated identifiers", () => {
  it("never uses a reserved word as an import binding", () => {
    expect(toIdentifier("/x/new.tsx")).toBe("_new");
    expect(toIdentifier("/x/default.tsx")).toBe("_default");
    expect(toIdentifier("/x/delete.tsx")).toBe("_delete");

    page("index.tsx");
    page("users/new.tsx");
    page("posts/delete.tsx");
    page("[class].tsx");
    const source = generateRoutesModule(config());

    expect(source).toContain('import _new from "./users/new";');
    expect(syntaxErrors(source)).toEqual([]);
  });

  it("does not let a page named like a generated binding shadow it", () => {
    page("index.tsx");
    page("admin/routes.tsx");
    page("admin/Router.tsx");
    const source = generateRoutesModule(config());

    expect(source).not.toMatch(/^import routes from/m);
    expect(source).not.toMatch(/^import Router from/m);
    expect(syntaxErrors(source)).toEqual([]);
  });

  it("emits typed, URL-encoding ROUTES builders", () => {
    page("users/[id].tsx");
    page("docs/[...slug].tsx");
    const source = generateRoutesModule(config());
    const build = (key: string) => {
      const match = source.match(new RegExp(`"${key}": (.*?),?\\n`));
      const js = ts.transpileModule(`const f = ${match![1]};`, {
        compilerOptions: { target: ts.ScriptTarget.ES2020 },
      }).outputText;
      return new Function(`${js}; return f;`)() as (...args: unknown[]) => string;
    };

    expect(build("USERS_ID")("a/b")).toBe("/users/a%2Fb");
    expect(build("DOCS_SLUG")("guides", "a b")).toBe("/docs/guides/a%20b");
  });
});

describe("ROUTES key collisions", () => {
  it("keeps /home next to the root HOME route", () => {
    page("index.tsx");
    page("home/index.tsx");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const source = generateRoutesModule(config());
    warn.mockRestore();

    expect(source).toContain('"HOME": "/"');
    expect(source).toContain('"HOME_2": "/home"');
  });
});

describe("route conflicts", () => {
  it("rejects a file and a directory index that render the same URL", () => {
    page("about.tsx");
    page("about/index.tsx");
    expect(() => scanDirectory(join(dir, "pages"), config())).toThrow(/Conflicting routes for "\/about"/);
  });

  it("rejects the same page under two extensions", () => {
    page("about.tsx");
    page("about.jsx");
    expect(() => scanDirectory(join(dir, "pages"), config())).toThrow(/Conflicting routes/);
    rmSync(join(dir, "pages"), { recursive: true });
    page("index.tsx");
    page("index.jsx");
    expect(() => scanDirectory(join(dir, "pages"), config())).toThrow(/Conflicting index page/);
  });

  it("still allows a page next to a directory without an index", () => {
    page("about.tsx");
    page("about/team.tsx");
    expect(() => scanDirectory(join(dir, "pages"), config())).not.toThrow();
  });
});

describe("config validation", () => {
  it("requires a .tsx output file", () => {
    expect(() => config({ outFileName: "routes.ts" })).toThrow(/must end in "\.tsx"/);
  });

  it("warns about unknown adapters", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    config({ adapter: "my-router" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Unknown adapter "my-router"'));
    warn.mockRestore();
  });

  it("finds a .js config when no .ts config exists", () => {
    expect(findConfigFile(dir)).toBeNull();
    writeFileSync(join(dir, "rfr.config.js"), "export default {}");
    expect(findConfigFile(dir)).toBe(join(dir, "rfr.config.js"));
  });

  it("loads the plugin config file and merges userConfig over it", async () => {
    writeFileSync(
      join(dir, "rfr.config.mjs"),
      'export default { pages: "from-file", adapter: "tanstack-router" };',
    );
    const resolved = await loadPluginConfig({ config: "rfr.config.mjs", userConfig: { pages: "inline" } }, dir);
    expect(resolved.pages).toBe(join(dir, "inline"));
    expect(resolved.adapter).toBe("tanstack-router");
  });
});

describe("writing and watching", () => {
  it("does not rewrite an unchanged routes file", () => {
    page("index.tsx");
    const cfg = config();
    expect(updateRoutes(cfg)).toBe(true);
    const mtime = statSync(cfg.outFile).mtimeMs;
    expect(updateRoutes(cfg)).toBe(false);
    expect(statSync(cfg.outFile).mtimeMs).toBe(mtime);
  });

  it("judges ignored paths relative to the pages directory", () => {
    const cfg = resolveConfig({ pages: join(dir, ".hidden", "app", "pages") }, dir);
    const pages = cfg.pages;
    // A dot-directory *above* the pages directory must not hide its files.
    expect(isIrrelevantPath(join(pages, "about.tsx"), cfg)).toBe(false);
    expect(isIrrelevantPath(pages, cfg)).toBe(false);
    // Ignored names inside the pages directory, and the output file, are skipped.
    expect(isIrrelevantPath(join(pages, ".cache", "x.tsx"), cfg)).toBe(true);
    expect(isIrrelevantPath(join(pages, "_drafts", "x.tsx"), cfg)).toBe(true);
    expect(isIrrelevantPath(cfg.outFile, cfg)).toBe(true);
  });
});
