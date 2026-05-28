/**
 * Studio-api.js — Studio filesystem integration
 *
 * REST endpoints under /__studio/* that provide server-backed file operations so the studio can
 * work universally (not just Chrome with File System Access API).
 *
 * All paths are relative to the project root. Directory traversal above root is rejected.
 */

import { resolve, relative, basename, dirname, isAbsolute } from "node:path";
import { readdir, stat, readFile, writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { transpileJxMarkdown } from "@jxsuite/parser/transpile";
import { loadContentTypes, queryContentType, findEntry } from "@jxsuite/compiler/content-loader";
import * as claude from "./claude-session.js";

/** Normalise a path to forward slashes (Windows `path` module returns backslashes). */
const fwd = (/** @type {string} */ p) => p.replaceAll("\\", "/");

/**
 * Check that a path is under either the server root OR the active project root. This allows file
 * operations on external projects that have been explicitly activated via /__studio/activate.
 *
 * @param {string} filePath
 * @param {string} root
 * @param {string | null} activeProjectRoot
 */
function assertAccessible(filePath, root, activeProjectRoot) {
  const rel = relative(root, filePath);
  if (!rel.startsWith("..") && !rel.startsWith("/")) return;
  if (activeProjectRoot) {
    const relActive = relative(activeProjectRoot, filePath);
    if (!relActive.startsWith("..") && !relActive.startsWith("/")) return;
  }
  throw new Error("Path outside project root");
}

/** @type {Record<string, string>} */
const statusMap = { M: "M", T: "T", A: "A", D: "D", R: "R", C: "C", U: "U" };

/**
 * Parse raw `git status --porcelain=v2 --branch` output into structured data.
 *
 * @param {string} out
 * @returns {{
 *   branch: string;
 *   ahead: number;
 *   behind: number;
 *   files: { path: string; status: string; staged: boolean }[];
 *   isRepo?: boolean;
 *   remotes?: string[];
 * }}
 */
export function parseGitStatus(out) {
  let branch = "";
  let ahead = 0;
  let behind = 0;
  /** @type {{ path: string; status: string; staged: boolean }[]} */
  const files = [];

  for (const line of out.split("\n")) {
    if (!line) continue;

    if (line.startsWith("# branch.head ")) {
      branch = line.slice("# branch.head ".length);
    } else if (line.startsWith("# branch.ab ")) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) {
        ahead = parseInt(m[1], 10);
        behind = parseInt(m[2], 10);
      }
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const parts = line.split(" ");
      const xy = parts[1];
      const stagedCode = xy[0];
      const unstagedCode = xy[1];
      let filePath;
      if (line.startsWith("2 ")) {
        const tabIdx = line.indexOf("\t");
        const pathPart = line.slice(tabIdx + 1);
        filePath = pathPart.split("\t").pop() || "";
      } else {
        filePath = parts.slice(8).join(" ");
      }
      if (stagedCode !== ".") {
        files.push({ path: filePath, status: statusMap[stagedCode] || stagedCode, staged: true });
      }
      if (unstagedCode !== ".") {
        files.push({
          path: filePath,
          status: statusMap[unstagedCode] || unstagedCode,
          staged: false,
        });
      }
    } else if (line.startsWith("? ")) {
      files.push({ path: line.slice(2), status: "U", staged: false });
    }
  }

  return { branch, ahead, behind, files };
}

/**
 * Handle /__studio/* requests.
 *
 * @param {Request} req
 * @param {URL} url
 * @param {string} root
 * @param {string | null} [activeProjectRoot]
 * @returns {Promise<Response | null>}
 */
export async function handleStudioApi(req, url, root, activeProjectRoot = null) {
  const path = url.pathname;

  // Project metadata
  if (path === "/__studio/project" && req.method === "GET") {
    try {
      const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
      return Response.json({
        root,
        name: pkg.name ?? basename(root),
        workspaces: pkg.workspaces ?? [],
      });
    } catch {
      return Response.json({ root, name: basename(root), workspaces: [] });
    }
  }

  // Project info — probe a directory for site-project characteristics
  if (path === "/__studio/project-info" && req.method === "GET") {
    const dir = url.searchParams.get("dir") || activeProjectRoot || root;
    const absDir = isAbsolute(dir) ? dir : resolve(root, dir);
    try {
      assertAccessible(absDir, root, activeProjectRoot);
    } catch (/** @type {unknown} */ e) {
      return Response.json(
        { error: /** @type {{ message?: string }} */ (e).message },
        { status: 400 },
      );
    }
    try {
      const projectRoot = fwd(absDir);
      const conventionalDirs = [
        "pages",
        "layouts",
        "components",
        "content",
        "data",
        "public",
        "styles",
      ];
      const directories = [];
      for (const d of conventionalDirs) {
        try {
          const s = await stat(resolve(absDir, d));
          if (s.isDirectory()) directories.push(d);
        } catch {}
      }

      let isSiteProject = false;
      let projectConfig = null;
      try {
        const raw = JSON.parse(await readFile(resolve(absDir, "project.json"), "utf8"));
        if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
          isSiteProject = true;
          projectConfig = raw;
        }
      } catch {}

      return Response.json({ isSiteProject, projectConfig, directories, projectRoot });
    } catch (/** @type {unknown} */ e) {
      return Response.json(
        { error: /** @type {{ message?: string }} */ (e).message },
        { status: 500 },
      );
    }
  }

  // Resolve nearest project.json ancestor for a given file path
  if (path === "/__studio/resolve-site" && req.method === "GET") {
    const filePath = url.searchParams.get("path");
    if (!filePath) return Response.json({ error: "Missing path param" }, { status: 400 });
    try {
      // Walk up from file's directory looking for project.json
      let dir = dirname(
        filePath.startsWith("~") ? filePath.replace("~", process.env.HOME || "") : filePath,
      );
      while (dir) {
        const candidate = resolve(dir, "project.json");
        if (existsSync(candidate)) {
          const config = JSON.parse(readFileSync(candidate, "utf8"));
          const relPath = fwd(dir);
          const absFile = filePath.startsWith("~")
            ? filePath.replace("~", process.env.HOME || "")
            : filePath;
          const fileRelPath = fwd(relative(dir, absFile));
          return Response.json({
            sitePath: dir,
            relPath: relPath,
            fileRelPath,
            projectConfig: config,
          });
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      return Response.json({ sitePath: null });
    } catch (/** @type {unknown} */ e) {
      return Response.json(
        { error: /** @type {{ message?: string }} */ (e).message },
        { status: 500 },
      );
    }
  }

  // Find a project directory by name — searches $HOME for the first matching directory with a
  // project.json. Dev-mode workaround for when showDirectoryPicker() can't provide absolute paths.
  if (path === "/__studio/find-project" && req.method === "GET") {
    const name = url.searchParams.get("name");
    if (!name) return Response.json({ error: "Missing name" }, { status: 400 });
    try {
      const home = process.env.HOME || process.env.USERPROFILE || "";
      if (!home) return Response.json({ path: null });
      const glob = new Bun.Glob(`**/${name}/project.json`);
      try {
        for await (const match of glob.scan({ cwd: home, dot: false })) {
          if (match.includes("node_modules") || match.includes(".Trash")) continue;
          const abs = resolve(home, dirname(match));
          return Response.json({ path: abs });
        }
      } catch {}
      return Response.json({ path: null });
    } catch (/** @type {unknown} */ e) {
      return Response.json(
        { error: /** @type {{ message?: string }} */ (e).message },
        { status: 500 },
      );
    }
  }

  // Discover site projects — find all project.json files under root
  if (path === "/__studio/sites" && req.method === "GET") {
    try {
      const glob = new Bun.Glob("**/project.json");
      const sites = [];
      for await (const match of glob.scan({ cwd: root, dot: false })) {
        if (
          match.includes("node_modules") ||
          fwd(match).includes("dist/") ||
          fwd(match).includes(".claude/")
        )
          continue;
        const fp = resolve(root, match);
        try {
          const raw = JSON.parse(await readFile(fp, "utf8"));
          if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
            const projectDir = fwd(dirname(fp));
            sites.push({ path: projectDir, config: raw });
          }
        } catch {}
      }
      return Response.json(sites);
    } catch (/** @type {unknown} */ e) {
      return Response.json(
        { error: /** @type {{ message?: string }} */ (e).message },
        { status: 500 },
      );
    }
  }

  // Create a new project
  if (path === "/__studio/create-project" && req.method === "POST") {
    try {
      const body = await req.json();
      const { name, description, url: siteUrl, adapter, directory } = body;
      if (!name || !directory) {
        return Response.json({ error: "name and directory are required" }, { status: 400 });
      }
      const destPath = resolve(root, directory);
      assertAccessible(destPath, root, activeProjectRoot);

      const { generateProject } = await import("@jxsuite/create/generate");
      await generateProject(destPath, { name, description, url: siteUrl, adapter });

      const config = JSON.parse(await readFile(resolve(destPath, "project.json"), "utf8"));
      const projectRoot = fwd(relative(root, destPath));
      return Response.json({ root: projectRoot, config });
    } catch (/** @type {unknown} */ e) {
      return Response.json(
        { error: /** @type {{ message?: string }} */ (e).message },
        { status: 500 },
      );
    }
  }

  // List files
  if (path === "/__studio/files" && req.method === "GET") {
    const dir = url.searchParams.get("dir") || activeProjectRoot || root;
    const pattern = url.searchParams.get("glob");
    const absDir = isAbsolute(dir) ? dir : resolve(root, dir);
    try {
      assertAccessible(absDir, root, activeProjectRoot);
    } catch (/** @type {unknown} */ e) {
      return Response.json(
        { error: /** @type {{ message?: string }} */ (e).message },
        { status: 400 },
      );
    }

    /** Report a path relative to the active project root (or server root as fallback). */
    const reportRelative = (/** @type {string} */ fp) => {
      if (activeProjectRoot) {
        const rel = relative(activeProjectRoot, fp);
        if (!rel.startsWith("..")) return fwd(rel);
      }
      return fwd(relative(root, fp));
    };

    try {
      if (pattern) {
        const glob = new Bun.Glob(pattern);
        const files = [];
        for await (const match of glob.scan({ cwd: absDir, dot: false })) {
          const fp = resolve(absDir, match);
          try {
            const s = await stat(fp);
            if (!s.isDirectory()) {
              files.push({
                name: basename(match),
                path: reportRelative(fp),
                size: s.size,
                modified: s.mtime.toISOString(),
              });
            }
          } catch {}
        }
        return Response.json(files);
      }

      const entries = await readdir(absDir, { withFileTypes: true });
      const files = [];
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const fp = resolve(absDir, entry.name);
        const s = await stat(fp);
        files.push({
          name: entry.name,
          path: reportRelative(fp),
          type: entry.isDirectory() ? "directory" : "file",
          size: s.size,
          modified: s.mtime.toISOString(),
        });
      }
      return Response.json(files);
    } catch (/** @type {unknown} */ e) {
      return Response.json(
        { error: /** @type {{ message?: string }} */ (e).message },
        { status: 500 },
      );
    }
  }

  // Component discovery — scan project for custom element definitions
  if (path === "/__studio/components" && req.method === "GET") {
    const dir = url.searchParams.get("dir") || activeProjectRoot || root;
    const scanRoot = isAbsolute(dir) ? dir : resolve(root, dir);
    try {
      assertAccessible(scanRoot, root, activeProjectRoot);
    } catch (/** @type {unknown} */ e) {
      return Response.json(
        { error: /** @type {{ message?: string }} */ (e).message },
        { status: 400 },
      );
    }
    try {
      const glob = new Bun.Glob("**/*.{json,md}");
      const components = [];
      for await (const match of glob.scan({ cwd: scanRoot, dot: false })) {
        if (
          match.includes("node_modules") ||
          fwd(match).includes("dist/") ||
          fwd(match).includes(".claude/")
        )
          continue;
        const fp = resolve(scanRoot, match);
        try {
          let content;
          if (match.endsWith(".md")) {
            const source = await readFile(fp, "utf8");
            const fmMatch = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
            if (!fmMatch) continue;
            if (!/^tagName:\s*.+-.+/m.test(fmMatch[1])) continue;
            content = transpileJxMarkdown(source);
          } else {
            content = JSON.parse(await readFile(fp, "utf8"));
          }
          if (content.tagName && content.tagName.includes("-")) {
            components.push({
              tagName: content.tagName,
              $id: content.$id || null,
              path: fwd(match),
              source: "jx",
              props: Object.entries(content.state || {})
                .filter(([, d]) => {
                  if (d == null) return false;
                  // Shorthand: "key": "value" or "key": 0 etc.
                  if (typeof d !== "object") return true;
                  // Full form: skip computed/handler/prototype entries
                  return !d.$prototype && !d.$handler && !d.$compute;
                })
                .map(([name, d]) => {
                  if (typeof d !== "object") {
                    // Shorthand: infer type from value
                    return { name, type: typeof d, default: d };
                  }
                  return { name, type: d.type, default: d.default, format: d.format };
                }),
              hasElements: Array.isArray(content.$elements) && content.$elements.length > 0,
            });
          }
        } catch {} // skip non-JSON or parse errors
      }

      // Discover CEM-bearing npm packages
      try {
        const projectPkgPath = resolve(scanRoot, "package.json");
        if (existsSync(projectPkgPath)) {
          const pkg = JSON.parse(await readFile(projectPkgPath, "utf8"));
          const deps = { ...pkg.dependencies, ...pkg.devDependencies };
          for (const name of Object.keys(deps)) {
            try {
              const depPkgPath = resolve(
                scanRoot,
                "node_modules",
                ...name.split("/"),
                "package.json",
              );
              // Fall back to root node_modules for hoisted packages
              const fallbackPath = resolve(
                root,
                "node_modules",
                ...name.split("/"),
                "package.json",
              );
              const actualPath = existsSync(depPkgPath)
                ? depPkgPath
                : existsSync(fallbackPath)
                  ? fallbackPath
                  : null;
              if (!actualPath) continue;
              const depPkg = JSON.parse(await readFile(actualPath, "utf8"));
              if (!depPkg.customElements) continue;
              const cemPath = resolve(dirname(actualPath), depPkg.customElements);
              if (!existsSync(cemPath)) continue;
              const cem = JSON.parse(await readFile(cemPath, "utf8"));
              for (const mod of cem.modules || []) {
                for (const decl of mod.declarations || []) {
                  if (decl.customElement && decl.tagName) {
                    components.push({
                      tagName: decl.tagName,
                      $id: null,
                      path: null,
                      modulePath: mod.path,
                      source: "npm",
                      package: name,
                      description: decl.description || null,
                      props: (decl.attributes || []).map(
                        (/** @type {Record<string, unknown>} */ a) => ({
                          name: a.name,
                          type: /** @type {Record<string, unknown> | undefined} */ (a.type)?.text,
                          default: a.default,
                          description: a.description || null,
                        }),
                      ),
                      members: (decl.members || []).filter(
                        (/** @type {Record<string, unknown>} */ m) =>
                          m.kind === "field" && m.privacy !== "private",
                      ),
                      slots: decl.slots || [],
                      events: decl.events || [],
                      cssProperties: decl.cssProperties || [],
                      hasElements: false,
                    });
                  }
                }
              }
            } catch {} // skip packages without valid CEM
          }
        }
      } catch {} // skip if no project package.json

      return Response.json(components);
    } catch (/** @type {unknown} */ e) {
      return Response.json(
        { error: /** @type {{ message?: string }} */ (e).message },
        { status: 500 },
      );
    }
  }

  // ─── Package management ──────────────────────────────────────────────────────

  // List CEM-bearing npm packages
  if (path === "/__studio/packages" && req.method === "GET") {
    const dir = url.searchParams.get("dir") || activeProjectRoot || root;
    const scanRoot = isAbsolute(dir) ? dir : resolve(root, dir);
    try {
      const pkgPath = resolve(scanRoot, "package.json");
      if (!existsSync(pkgPath)) return Response.json([]);
      const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      /**
       * @type {{
       *   name: string;
       *   version: string;
       *   hasCem: boolean;
       *   customElementsPath: string | null;
       * }[]}
       */
      const packages = [];
      for (const [name, version] of Object.entries(deps)) {
        const depPkgPath = resolve(scanRoot, "node_modules", ...name.split("/"), "package.json");
        const fallbackPath = resolve(root, "node_modules", ...name.split("/"), "package.json");
        const actualPath = existsSync(depPkgPath)
          ? depPkgPath
          : existsSync(fallbackPath)
            ? fallbackPath
            : null;
        if (!actualPath) continue;
        try {
          const depPkg = JSON.parse(await readFile(actualPath, "utf8"));
          packages.push({
            name,
            version: /** @type {string} */ (version),
            hasCem: !!depPkg.customElements,
            customElementsPath: depPkg.customElements || null,
          });
        } catch {}
      }
      return Response.json(packages);
    } catch (/** @type {unknown} */ e) {
      return Response.json(
        { error: /** @type {{ message?: string }} */ (e).message },
        { status: 500 },
      );
    }
  }

  // Read CEM from a specific package
  if (path === "/__studio/cem" && req.method === "GET") {
    const pkg = url.searchParams.get("pkg");
    if (!pkg) return new Response("Missing pkg", { status: 400 });
    const dir = url.searchParams.get("dir") || activeProjectRoot || root;
    const scanRoot = isAbsolute(dir) ? dir : resolve(root, dir);
    try {
      const depPkgPath = resolve(scanRoot, "node_modules", ...pkg.split("/"), "package.json");
      const fallbackPath = resolve(root, "node_modules", ...pkg.split("/"), "package.json");
      const actualPath = existsSync(depPkgPath)
        ? depPkgPath
        : existsSync(fallbackPath)
          ? fallbackPath
          : null;
      if (!actualPath) return Response.json({ cem: null });
      const depPkg = JSON.parse(await readFile(actualPath, "utf8"));
      if (!depPkg.customElements) return Response.json({ cem: null });
      const cemPath = resolve(dirname(actualPath), depPkg.customElements);
      if (!existsSync(cemPath)) return Response.json({ cem: null });
      const cem = JSON.parse(await readFile(cemPath, "utf8"));
      return Response.json({ cem });
    } catch (/** @type {unknown} */ e) {
      return Response.json(
        { error: /** @type {{ message?: string }} */ (e).message },
        { status: 500 },
      );
    }
  }

  // Add an npm package
  if (path === "/__studio/packages/add" && req.method === "POST") {
    try {
      const body = await req.json();
      const name = body.name;
      if (!name || typeof name !== "string")
        return Response.json({ error: "Missing name" }, { status: 400 });
      const dir = body.dir || activeProjectRoot;
      const cwd = dir ? (isAbsolute(dir) ? dir : resolve(root, dir)) : root;
      const args = ["add", name];
      if (body.dev) args.splice(1, 0, "-d");
      const proc = Bun.spawn(["bun", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        return Response.json(
          { error: stderr || `bun add exited with ${exitCode}` },
          { status: 500 },
        );
      }
      return Response.json({ ok: true });
    } catch (/** @type {unknown} */ e) {
      return Response.json(
        { error: /** @type {{ message?: string }} */ (e).message },
        { status: 500 },
      );
    }
  }

  // Remove an npm package
  if (path === "/__studio/packages/remove" && req.method === "POST") {
    try {
      const body = await req.json();
      const name = body.name;
      if (!name || typeof name !== "string")
        return Response.json({ error: "Missing name" }, { status: 400 });
      const dir = body.dir || activeProjectRoot;
      const cwd = dir ? (isAbsolute(dir) ? dir : resolve(root, dir)) : root;
      const proc = Bun.spawn(["bun", "remove", name], { cwd, stdout: "pipe", stderr: "pipe" });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        return Response.json(
          { error: stderr || `bun remove exited with ${exitCode}` },
          { status: 500 },
        );
      }
      return Response.json({ ok: true });
    } catch (/** @type {unknown} */ e) {
      return Response.json(
        { error: /** @type {{ message?: string }} */ (e).message },
        { status: 500 },
      );
    }
  }

  // Read file
  if (path === "/__studio/file" && req.method === "GET") {
    const fp = url.searchParams.get("path");
    if (!fp) return new Response("Missing path", { status: 400 });
    const abs = fp.startsWith("~") ? fp.replace("~", process.env.HOME || "") : fp;
    try {
      assertAccessible(abs, root, activeProjectRoot);
    } catch (/** @type {unknown} */ e) {
      return new Response(/** @type {{ message?: string }} */ (e).message, { status: 400 });
    }
    try {
      return Response.json({
        content: await readFile(abs, "utf8"),
        path: fp,
      });
    } catch (/** @type {unknown} */ e) {
      return /** @type {{ code?: string }} */ (e).code === "ENOENT"
        ? new Response("Not found", { status: 404 })
        : Response.json(
            { error: /** @type {{ message?: string }} */ (e).message },
            { status: 500 },
          );
    }
  }

  // Write file
  if (path === "/__studio/file" && req.method === "PUT") {
    const fp = url.searchParams.get("path");
    if (!fp) return new Response("Missing path", { status: 400 });
    const abs = resolve(root, fp);
    try {
      assertAccessible(abs, root, activeProjectRoot);
    } catch (/** @type {unknown} */ e) {
      return new Response(/** @type {{ message?: string }} */ (e).message, { status: 400 });
    }
    try {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, await req.text(), "utf8");
      return Response.json({ ok: true, path: fwd(relative(root, abs)) });
    } catch (/** @type {unknown} */ e) {
      return Response.json(
        { error: /** @type {{ message?: string }} */ (e).message },
        { status: 500 },
      );
    }
  }

  // Upload binary file
  if (path === "/__studio/file/upload" && req.method === "POST") {
    const fp = url.searchParams.get("path");
    if (!fp) return new Response("Missing path", { status: 400 });
    const abs = resolve(root, fp);
    try {
      assertAccessible(abs, root, activeProjectRoot);
    } catch (/** @type {unknown} */ e) {
      return new Response(/** @type {{ message?: string }} */ (e).message, { status: 400 });
    }
    try {
      await mkdir(dirname(abs), { recursive: true });
      const buffer = await req.arrayBuffer();
      await Bun.write(abs, new Uint8Array(buffer));
      return Response.json({ ok: true, path: fwd(relative(root, abs)) });
    } catch (/** @type {unknown} */ e) {
      return Response.json(
        { error: /** @type {{ message?: string }} */ (e).message },
        { status: 500 },
      );
    }
  }

  // Delete file
  if (path === "/__studio/file" && req.method === "DELETE") {
    const fp = url.searchParams.get("path");
    if (!fp) return new Response("Missing path", { status: 400 });
    const abs = resolve(root, fp);
    try {
      assertAccessible(abs, root, activeProjectRoot);
    } catch (/** @type {unknown} */ e) {
      return new Response(/** @type {{ message?: string }} */ (e).message, { status: 400 });
    }
    try {
      await unlink(abs);
      return Response.json({ ok: true, path: fwd(relative(root, abs)) });
    } catch (/** @type {unknown} */ e) {
      return /** @type {{ code?: string }} */ (e).code === "ENOENT"
        ? new Response("Not found", { status: 404 })
        : Response.json(
            { error: /** @type {{ message?: string }} */ (e).message },
            { status: 500 },
          );
    }
  }

  // Rename file
  if (path === "/__studio/file/rename" && req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    const { from, to } = body;
    if (!from || !to) return new Response("Missing from or to", { status: 400 });
    const absFrom = resolve(root, from);
    const absTo = resolve(root, to);
    try {
      assertAccessible(absFrom, root, activeProjectRoot);
      assertAccessible(absTo, root, activeProjectRoot);
    } catch (/** @type {unknown} */ e) {
      return new Response(/** @type {{ message?: string }} */ (e).message, { status: 400 });
    }
    try {
      await mkdir(dirname(absTo), { recursive: true });
      await rename(absFrom, absTo);
      return Response.json({
        ok: true,
        from: fwd(relative(root, absFrom)),
        to: fwd(relative(root, absTo)),
      });
    } catch (/** @type {unknown} */ e) {
      return Response.json(
        { error: /** @type {{ message?: string }} */ (e).message },
        { status: 500 },
      );
    }
  }

  // Locate a file by name within the project root
  if (path === "/__studio/locate" && req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    const { name } = body;
    if (!name) return new Response("Missing name", { status: 400 });

    try {
      const glob = new Bun.Glob(`**/${name}`);
      const matches = [];
      for await (const match of glob.scan({ cwd: root, dot: false })) {
        // Skip node_modules / dist / hidden dirs
        if (match.includes("node_modules") || fwd(match).includes("dist/")) continue;
        matches.push(fwd(match));
      }
      if (matches.length === 0) return Response.json({ path: null });
      return Response.json({
        path: matches[0],
        ...(matches.length > 1 ? { alternatives: matches } : {}),
      });
    } catch (/** @type {unknown} */ e) {
      return Response.json(
        { error: /** @type {{ message?: string }} */ (e).message },
        { status: 500 },
      );
    }
  }

  // Discover a plugin module's schema for studio form rendering
  if (path === "/__studio/plugin-schema" && req.method === "GET") {
    const src = url.searchParams.get("src");
    const prototype = url.searchParams.get("prototype");
    const base = url.searchParams.get("base");
    if (!src) return new Response("Missing src param", { status: 400 });

    let moduleAbsPath;
    try {
      if (base) {
        const docUrlPath = new URL(base).pathname;
        const docDir = docUrlPath.slice(0, docUrlPath.lastIndexOf("/") + 1);
        moduleAbsPath = resolve(resolve(root, "." + docDir), src);
      } else {
        moduleAbsPath = resolve(root, src);
      }
    } catch (/** @type {unknown} */ e) {
      return Response.json({
        schema: null,
        error: /** @type {{ message?: string }} */ (e).message,
      });
    }

    // .class.json: read and extract schema directly
    if (moduleAbsPath.endsWith(".class.json")) {
      try {
        const content = readFileSync(moduleAbsPath, "utf8");
        const classDef = JSON.parse(content);
        return Response.json({ schema: extractStudioSchema(classDef, moduleAbsPath) });
      } catch (/** @type {unknown} */ e) {
        return Response.json({
          schema: null,
          error: /** @type {{ message?: string }} */ (e).message,
        });
      }
    }

    // Sibling .class.json auto-discovery: check for <ClassName>.class.json next to the .js module
    const exportName = prototype || src;
    const classJsonPath = resolve(dirname(moduleAbsPath), `${exportName}.class.json`);
    if (existsSync(classJsonPath)) {
      try {
        const content = readFileSync(classJsonPath, "utf8");
        const classDef = JSON.parse(content);
        return Response.json({ schema: extractStudioSchema(classDef, classJsonPath) });
      } catch {
        // Fall through to JS module import
      }
    }

    // Fallback: import JS module (backwards compat for classes without .class.json)
    try {
      const mod = await import(moduleAbsPath);
      const ExportedClass = mod[exportName] ?? mod.default?.[exportName];
      if (typeof ExportedClass !== "function") {
        return Response.json({ schema: null, error: `Export "${exportName}" not found` });
      }
      return Response.json({ schema: ExportedClass.schema ?? null });
    } catch (/** @type {unknown} */ e) {
      return Response.json({
        schema: null,
        error: /** @type {{ message?: string }} */ (e).message,
      });
    }
  }

  // ── Git endpoints ──────────────────────────────────────────────────────────

  if (path.startsWith("/__studio/git/")) {
    const cwd = activeProjectRoot || root;
    const gitCmd = path.slice("/__studio/git/".length);

    const runGit = async (/** @type {string[]} */ args) => {
      const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      if (exitCode !== 0) throw new Error(stderr || `git exited with ${exitCode}`);
      return stdout;
    };

    try {
      if (gitCmd === "status" && req.method === "GET") {
        // Check if we're in a git repo first
        const checkProc = Bun.spawn(["git", "rev-parse", "--is-inside-work-tree"], {
          cwd,
          stdout: "pipe",
          stderr: "pipe",
        });
        const checkExit = await checkProc.exited;
        if (checkExit !== 0) {
          return Response.json({
            isRepo: false,
            branch: "",
            files: [],
            ahead: 0,
            behind: 0,
            remotes: [],
          });
        }

        const [out, remotesOut] = await Promise.all([
          runGit(["status", "--porcelain=v2", "--branch"]),
          runGit(["remote"]),
        ]);
        const status = parseGitStatus(out);
        status.isRepo = true;
        status.remotes = remotesOut.trim().split("\n").filter(Boolean);
        return Response.json(status);
      }

      if (gitCmd === "init" && req.method === "POST") {
        await runGit(["init"]);
        return Response.json({ ok: true });
      }

      if (gitCmd === "add-remote" && req.method === "POST") {
        const { name, url: remoteUrl } = await req.json();
        if (!name || !remoteUrl) return new Response("name and url required", { status: 400 });
        await runGit(["remote", "add", name, remoteUrl]);
        return Response.json({ ok: true });
      }

      if (gitCmd === "branches" && req.method === "GET") {
        const out = await runGit(["branch", "--format=%(refname:short)\t%(HEAD)"]);
        let current = "";
        const branches = [];
        for (const line of out.trim().split("\n")) {
          if (!line) continue;
          const [name, head] = line.split("\t");
          branches.push(name);
          if (head === "*") current = name;
        }
        return Response.json({ current, branches });
      }

      if (gitCmd === "log" && req.method === "GET") {
        const limit = url.searchParams.get("limit") || "20";
        const out = await runGit(["log", `--max-count=${limit}`, "--format=%H\t%s\t%an\t%aI"]);
        const entries = out
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [hash, message, author, date] = line.split("\t");
            return { hash, message, author, date };
          });
        return Response.json(entries);
      }

      if (gitCmd === "stage" && req.method === "POST") {
        const { files } = await req.json();
        if (!Array.isArray(files) || files.length === 0)
          return Response.json({ error: "Missing files" }, { status: 400 });
        for (const f of files) {
          if (f.includes("..")) return Response.json({ error: "Invalid path" }, { status: 400 });
        }
        await runGit(["add", "--", ...files]);
        return Response.json({ ok: true });
      }

      if (gitCmd === "unstage" && req.method === "POST") {
        const { files } = await req.json();
        if (!Array.isArray(files) || files.length === 0)
          return Response.json({ error: "Missing files" }, { status: 400 });
        await runGit(["restore", "--staged", "--", ...files]);
        return Response.json({ ok: true });
      }

      if (gitCmd === "commit" && req.method === "POST") {
        const { message } = await req.json();
        if (!message || typeof message !== "string")
          return Response.json({ error: "Missing message" }, { status: 400 });
        const statusOut = await runGit(["status", "--porcelain"]);
        const hasStaged = statusOut
          .split("\n")
          .some((l) => l.length > 0 && l[0] !== " " && l[0] !== "?");
        const args = hasStaged ? ["commit", "-m", message] : ["commit", "-a", "-m", message];
        const out = await runGit(args);
        const hashMatch = out.match(/\[[\w/]+ ([a-f0-9]+)\]/);
        return Response.json({ ok: true, hash: hashMatch?.[1] || "" });
      }

      if (gitCmd === "push" && req.method === "POST") {
        let body = {};
        try {
          body = await req.json();
        } catch {}
        const { setUpstream } = /** @type {{ setUpstream?: boolean }} */ (body);
        if (setUpstream) {
          const branch = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
          await runGit(["push", "-u", "origin", branch]);
        } else {
          await runGit(["push"]);
        }
        return Response.json({ ok: true });
      }

      if (gitCmd === "pull" && req.method === "POST") {
        await runGit(["pull"]);
        return Response.json({ ok: true });
      }

      if (gitCmd === "fetch" && req.method === "POST") {
        await runGit(["fetch"]);
        return Response.json({ ok: true });
      }

      if (gitCmd === "checkout" && req.method === "POST") {
        const { branch } = await req.json();
        if (!branch || typeof branch !== "string")
          return Response.json({ error: "Missing branch" }, { status: 400 });
        await runGit(["checkout", branch]);
        return Response.json({ ok: true });
      }

      if (gitCmd === "create-branch" && req.method === "POST") {
        const { name } = await req.json();
        if (!name || typeof name !== "string")
          return Response.json({ error: "Missing name" }, { status: 400 });
        await runGit(["checkout", "-b", name]);
        return Response.json({ ok: true });
      }

      if (gitCmd === "diff" && req.method === "GET") {
        const fp = url.searchParams.get("path");
        if (!fp) return Response.json({ error: "Missing path" }, { status: 400 });
        if (fp.includes("..")) return Response.json({ error: "Invalid path" }, { status: 400 });
        const diff = await runGit(["diff", "--", fp]);
        return Response.json({ diff });
      }

      if (gitCmd === "show" && req.method === "GET") {
        const fp = url.searchParams.get("path");
        const ref = url.searchParams.get("ref") || "HEAD";
        if (!fp) return Response.json({ error: "Missing path" }, { status: 400 });
        if (fp.includes("..")) return Response.json({ error: "Invalid path" }, { status: 400 });
        const content = await runGit(["show", `${ref}:${fp}`]);
        return Response.json({ content, format: fp.endsWith(".md") ? "markdown" : "json" });
      }

      if (gitCmd === "discard" && req.method === "POST") {
        const { files } = await req.json();
        if (!Array.isArray(files) || files.length === 0)
          return Response.json({ error: "Missing files" }, { status: 400 });
        for (const f of files) {
          if (f.includes("..")) return Response.json({ error: "Invalid path" }, { status: 400 });
        }
        await runGit(["checkout", "--", ...files]);
        return Response.json({ ok: true });
      }

      if (gitCmd === "clone" && req.method === "POST") {
        const { url } = await req.json();
        if (!url || typeof url !== "string")
          return Response.json({ error: "Missing url" }, { status: 400 });
        const repoName = basename(url.replace(/\.git$/, ""));
        const dest = resolve(cwd, repoName);
        const proc = Bun.spawn(["git", "clone", url, dest], {
          cwd,
          stdout: "pipe",
          stderr: "pipe",
        });
        const exitCode = await proc.exited;
        const stderr = await new Response(proc.stderr).text();
        if (exitCode !== 0) throw new Error(stderr || `git clone exited with ${exitCode}`);
        return Response.json({ ok: true, root: dest });
      }
    } catch (/** @type {unknown} */ e) {
      return Response.json(
        { error: /** @type {{ message?: string }} */ (e).message },
        { status: 500 },
      );
    }
  }

  // ─── Content Type Resolution ──────────────────────────────────────────────

  if (path === "/__studio/content" && req.method === "POST") {
    try {
      const body = await req.json();
      const { $prototype, contentType, id, filter, sort, limit } = body;
      const projectRoot = activeProjectRoot || root;

      let projectConfig;
      try {
        projectConfig = JSON.parse(readFileSync(resolve(projectRoot, "project.json"), "utf8"));
      } catch {
        return Response.json({ error: "No project.json found" }, { status: 404 });
      }

      if (!projectConfig.contentTypes?.[contentType]) {
        return Response.json({ error: `Content type "${contentType}" not found` }, { status: 404 });
      }

      const contentTypes = await loadContentTypes(projectRoot, projectConfig);
      const entries = contentTypes.get(contentType);
      if (!entries || entries.length === 0) {
        return Response.json($prototype === "ContentCollection" ? [] : null);
      }

      if ($prototype === "ContentCollection") {
        const result = queryContentType(entries, { filter, sort, limit });
        return Response.json(result);
      }

      if ($prototype === "ContentEntry") {
        const entry = findEntry(entries, id);
        return Response.json(entry ?? null);
      }

      return Response.json({ error: "Invalid $prototype" }, { status: 400 });
    } catch (/** @type {unknown} */ e) {
      return Response.json(
        { error: /** @type {{ message?: string }} */ (e).message },
        { status: 500 },
      );
    }
  }

  // ─── AI Assistant ─────────────────────────────────────────────────────────

  if (path === "/__studio/ai/auth-status" && req.method === "GET") {
    const status = await claude.getAuthStatus();
    return Response.json(status);
  }

  if (path === "/__studio/ai/session" && req.method === "POST") {
    try {
      const body = await req.json();
      const projectDir = activeProjectRoot || root;
      const result = claude.createSession(projectDir, body.message, {
        systemPrompt: body.systemPrompt,
      });
      return Response.json(result);
    } catch (/** @type {any} */ e) {
      return Response.json({ error: e.message }, { status: 500 });
    }
  }

  if (
    path.startsWith("/__studio/ai/session/") &&
    path.endsWith("/stream") &&
    req.method === "GET"
  ) {
    const id = path.split("/")[4];
    return claude.streamSession(id);
  }

  if (
    path.startsWith("/__studio/ai/session/") &&
    path.endsWith("/message") &&
    req.method === "POST"
  ) {
    try {
      const id = path.split("/")[4];
      const body = await req.json();
      claude.sendMessage(id, body.message);
      return Response.json({ ok: true });
    } catch (/** @type {any} */ e) {
      return Response.json({ error: e.message }, { status: 500 });
    }
  }

  if (path.startsWith("/__studio/ai/session/") && path.endsWith("/stop") && req.method === "POST") {
    const id = path.split("/")[4];
    claude.stopSession(id);
    return Response.json({ ok: true });
  }

  if (path.startsWith("/__studio/ai/session/") && req.method === "DELETE") {
    const id = path.split("/")[4];
    claude.deleteSession(id);
    return Response.json({ ok: true });
  }

  if (path.startsWith("/__studio/ai/session/") && req.method === "GET") {
    const id = path.split("/")[4];
    const info = claude.getSession(id);
    if (!info) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json(info);
  }

  return null;
}

/**
 * Extract a studio-friendly schema from a .class.json definition. Transforms $defs.parameters and
 * $defs.fields into the flat { description, properties, required } shape that renderSchemaFields()
 * in the studio already consumes.
 *
 * @param {ClassJsonDef} classDef
 * @param {string} classJsonPath
 * @returns {{
 *   description: string | undefined;
 *   properties: Record<string, Record<string, unknown>>;
 *   required: string[];
 * }}
 */
function extractStudioSchema(classDef, classJsonPath) {
  // If extends.$ref points to a parent, recursively merge
  let parentSchema = null;
  if (classDef.extends && typeof classDef.extends === "object" && classDef.extends.$ref) {
    try {
      const parentPath = resolve(dirname(classJsonPath), classDef.extends.$ref);
      const parentContent = readFileSync(parentPath, "utf8");
      const parentDef = JSON.parse(parentContent);
      parentSchema = extractStudioSchema(parentDef, parentPath);
    } catch {
      // Parent not found — proceed without inheritance
    }
  }

  const params = classDef.$defs?.parameters ?? {};
  const fields = classDef.$defs?.fields ?? {};
  /** @type {Record<string, Record<string, unknown>>} */
  const properties = {};
  /** @type {string[]} */
  const required = [];

  // Start with parent properties (child overrides)
  if (parentSchema?.properties) {
    Object.assign(properties, parentSchema.properties);
  }
  if (parentSchema?.required) {
    required.push(...parentSchema.required);
  }

  // Build properties from parameters (constructor config surface)
  for (const [key, param] of Object.entries(params)) {
    const id = param.identifier ?? key;
    /** @type {Record<string, unknown>} */
    const prop = {};
    if (param.type && typeof param.type === "object") Object.assign(prop, param.type);
    if (param.description) prop.description = param.description;
    if (param.examples) prop.examples = param.examples;
    if (param.format) prop.format = param.format;
    properties[id] = prop;
  }

  // Build properties from fields (config-visible ones only)
  for (const [key, field] of Object.entries(fields)) {
    if (field.role !== "field") continue;
    if (field.access === "private") continue;
    const id = field.identifier ?? key;
    /** @type {Record<string, unknown>} */
    const prop = {};
    if (field.type && typeof field.type === "object") Object.assign(prop, field.type);
    if (field.description) prop.description = field.description;
    if (field.default !== undefined) prop.default = field.default;
    if (field.initializer !== undefined && prop.default === undefined)
      prop.default = field.initializer;
    if (field.examples) prop.examples = field.examples;
    properties[id] = prop;
  }

  // Determine required from constructor parameters that have no default
  const ctorParams = classDef.$defs?.constructor?.parameters ?? [];
  /** @type {Set<string>} */
  const requiredSet = new Set(required);
  for (const p of ctorParams) {
    const name = p.$ref ? p.$ref.split("/").pop() : (p.identifier ?? p.name);
    if (name && properties[name] && properties[name].default === undefined) {
      requiredSet.add(name);
    }
  }

  return {
    description: classDef.description ?? classDef.title,
    properties,
    required: [...requiredSet],
  };
}
