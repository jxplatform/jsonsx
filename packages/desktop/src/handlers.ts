import { readdir, readFile, writeFile, rename, stat, mkdir, rm } from "node:fs/promises";
import { resolve, relative, join, basename, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { DirEntry, ComponentMeta, OpenProjectResult, CodeServiceResult } from "./rpc-schema";

// ─── State ────────────────────────────────────────────────────────────────────

let projectRoot: string | null = null;
let fileDialogFn: (() => Promise<string | null>) | null = null;

export function setProjectRoot(root: string | null) {
  projectRoot = root;
}

export function getProjectRoot(): string | null {
  return projectRoot;
}

export function setFileDialog(fn: () => Promise<string | null>) {
  fileDialogFn = fn;
}

// ─── Guards ───────────────────────────────────────────────────────────────────

function requireRoot(): string {
  if (!projectRoot) throw new Error("No project open");
  return projectRoot;
}

function assertUnderRoot(absPath: string, root: string) {
  const rel = relative(root, absPath);
  if (rel.startsWith("..") || rel.startsWith("/")) {
    throw new Error("Path outside project root");
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

export async function openProject(): Promise<OpenProjectResult | null> {
  if (!fileDialogFn) throw new Error("No file dialog configured");
  const selectedPath = await fileDialogFn();
  if (!selectedPath) return null;

  const filePath = resolve(selectedPath);
  if (!existsSync(filePath) || basename(filePath) !== "project.json") {
    throw new Error("Selected file is not a project.json");
  }

  const raw = await readFile(filePath, "utf8");
  const config = JSON.parse(raw);
  projectRoot = dirname(filePath);

  return {
    config,
    handle: {
      root: ".",
      name: config.name || basename(projectRoot),
      projectConfig: config,
    },
  };
}

export async function listDirectory(params: { dir: string }): Promise<DirEntry[]> {
  const root = requireRoot();
  const absDir = resolve(root, params.dir);
  assertUnderRoot(absDir, root);

  const entries = await readdir(absDir, { withFileTypes: true });
  const result: DirEntry[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const absPath = join(absDir, entry.name);
    try {
      const s = await stat(absPath);
      result.push({
        name: entry.name,
        path: relative(root, absPath),
        type: entry.isDirectory() ? "directory" : "file",
        size: s.size,
        modified: s.mtime.toISOString(),
      });
    } catch {}
  }

  return result;
}

export async function handleReadFile(params: { path: string }): Promise<string> {
  const root = requireRoot();
  const abs = resolve(root, params.path);
  assertUnderRoot(abs, root);
  return readFile(abs, "utf8");
}

export async function handleReadFileAsDataUrl(params: { path: string }): Promise<string> {
  const root = requireRoot();
  let abs = resolve(root, params.path);
  assertUnderRoot(abs, root);

  if (!existsSync(abs)) {
    const publicAbs = resolve(root, "public", params.path);
    assertUnderRoot(publicAbs, root);
    if (!existsSync(publicAbs)) {
      throw new Error(`File not found: ${params.path}`);
    }
    abs = publicAbs;
  }

  const buffer = await readFile(abs);
  const base64 = Buffer.from(buffer).toString("base64");
  const ext = params.path.split(".").pop()?.toLowerCase() || "";
  const mimeMap: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    webp: "image/webp",
    ico: "image/x-icon",
    avif: "image/avif",
  };
  const mime = mimeMap[ext] || "application/octet-stream";
  return `data:${mime};base64,${base64}`;
}

export async function handleWriteFile(params: { path: string; content: string }): Promise<void> {
  const root = requireRoot();
  const abs = resolve(root, params.path);
  assertUnderRoot(abs, root);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, params.content, "utf8");
}

export async function handleDeleteFile(params: { path: string }): Promise<void> {
  const root = requireRoot();
  const abs = resolve(root, params.path);
  assertUnderRoot(abs, root);
  await rm(abs, { force: true, maxRetries: 3, retryDelay: 100 });
}

export async function handleRenameFile(params: { from: string; to: string }): Promise<void> {
  const root = requireRoot();
  const absFrom = resolve(root, params.from);
  const absTo = resolve(root, params.to);
  assertUnderRoot(absFrom, root);
  assertUnderRoot(absTo, root);
  await mkdir(dirname(absTo), { recursive: true });
  await rename(absFrom, absTo);
}

export async function handleCreateDirectory(params: { path: string }): Promise<void> {
  const root = requireRoot();
  const abs = resolve(root, params.path);
  assertUnderRoot(abs, root);
  await mkdir(abs, { recursive: true });
}

export async function handleUploadFile(params: { path: string; data: string }): Promise<void> {
  const root = requireRoot();
  const abs = resolve(root, params.path);
  assertUnderRoot(abs, root);
  await mkdir(dirname(abs), { recursive: true });
  const buffer = Buffer.from(params.data, "base64");
  await Bun.write(abs, buffer);
}

export async function handleResolveSiteContext(params: {
  filePath: string;
}): Promise<{ sitePath: string | null }> {
  const root = requireRoot();
  let dir = resolve(root, dirname(params.filePath));

  while (true) {
    const rel = relative(root, dir);
    if (rel.startsWith("..") || rel.startsWith("/")) break;

    const candidate = join(dir, "project.json");
    if (existsSync(candidate)) {
      return { sitePath: relative(root, dir) || "." };
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return { sitePath: null };
}

export async function discoverComponents(params: { dir?: string }): Promise<ComponentMeta[]> {
  const root = requireRoot();
  const scanRoot = params.dir ? resolve(root, params.dir) : root;
  if (params.dir) assertUnderRoot(scanRoot, root);

  const glob = new Bun.Glob("**/*.json");
  const components: ComponentMeta[] = [];

  for await (const match of glob.scan({ cwd: scanRoot, dot: false })) {
    if (match.includes("node_modules") || match.includes("dist/") || match.includes(".claude/"))
      continue;
    const fp = resolve(scanRoot, match);
    try {
      const content = JSON.parse(await readFile(fp, "utf8"));
      if (content.tagName && content.tagName.includes("-")) {
        components.push({
          tagName: content.tagName,
          $id: content.$id || null,
          path: match,
          props: Object.entries(content.state || {})
            .filter(([, d]) => {
              if (d == null) return false;
              if (typeof d !== "object") return true;
              return !(d as any).$prototype && !(d as any).$handler && !(d as any).$compute;
            })
            .map(([name, d]) => {
              if (typeof d !== "object") {
                return { name, type: typeof d, default: d };
              }
              return {
                name,
                type: (d as any).type,
                default: (d as any).default,
                format: (d as any).format,
              };
            }),
          hasElements: Array.isArray(content.$elements) && content.$elements.length > 0,
        });
      }
    } catch {}
  }

  return components;
}

export async function codeService(_params: any): Promise<CodeServiceResult | null> {
  return null;
}

export async function locateFile(params: { name: string }): Promise<string | null> {
  const root = requireRoot();
  const glob = new Bun.Glob(`**/${params.name}`);
  const matches: string[] = [];

  for await (const match of glob.scan({ cwd: root, dot: false })) {
    if (match.includes("node_modules") || match.includes("dist/")) continue;
    matches.push(match.split("\\").join("/"));
  }

  return matches.length > 0 ? matches[0] : null;
}

export async function fetchPluginSchema(params: {
  src: string;
  prototype?: string;
  base?: string;
}): Promise<unknown> {
  const root = requireRoot();

  let moduleAbsPath: string;
  try {
    if (params.base) {
      const docUrlPath = new URL(params.base).pathname;
      const docDir = docUrlPath.slice(0, docUrlPath.lastIndexOf("/") + 1);
      moduleAbsPath = resolve(resolve(root, "." + docDir), params.src);
    } else {
      moduleAbsPath = resolve(root, params.src);
    }
  } catch {
    return null;
  }

  if (moduleAbsPath.endsWith(".class.json")) {
    try {
      const content = readFileSync(moduleAbsPath, "utf8");
      const classDef = JSON.parse(content);
      return extractStudioSchema(classDef, moduleAbsPath);
    } catch {
      return null;
    }
  }

  const exportName = params.prototype || params.src;
  const classJsonPath = resolve(dirname(moduleAbsPath), `${exportName}.class.json`);
  if (existsSync(classJsonPath)) {
    try {
      const content = readFileSync(classJsonPath, "utf8");
      const classDef = JSON.parse(content);
      return extractStudioSchema(classDef, classJsonPath);
    } catch {}
  }

  try {
    const mod = await import(moduleAbsPath);
    const ExportedClass = mod[exportName] ?? mod.default?.[exportName];
    if (typeof ExportedClass !== "function") return null;
    return ExportedClass.schema ?? null;
  } catch {
    return null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractStudioSchema(classDef: any, classJsonPath: string): any {
  let parentSchema: any = null;
  if (classDef.extends?.["$ref"]) {
    try {
      const parentPath = resolve(dirname(classJsonPath), classDef.extends["$ref"]);
      const parentContent = readFileSync(parentPath, "utf8");
      const parentDef = JSON.parse(parentContent);
      parentSchema = extractStudioSchema(parentDef, parentPath);
    } catch {}
  }

  const params = classDef.$defs?.parameters ?? {};
  const fields = classDef.$defs?.fields ?? {};
  const properties: Record<string, any> = {};
  const required: string[] = [];

  if (parentSchema?.properties) Object.assign(properties, parentSchema.properties);
  if (parentSchema?.required) required.push(...parentSchema.required);

  for (const [key, param] of Object.entries(params)) {
    const p = param as any;
    const id = p.identifier ?? key;
    const prop: any = {};
    if (p.type && typeof p.type === "object") Object.assign(prop, p.type);
    if (p.description) prop.description = p.description;
    if (p.examples) prop.examples = p.examples;
    if (p.format) prop.format = p.format;
    properties[id] = prop;
  }

  for (const [key, field] of Object.entries(fields)) {
    const f = field as any;
    if (f.role !== "field") continue;
    if (f.access === "private") continue;
    const id = f.identifier ?? key;
    const prop: any = {};
    if (f.type && typeof f.type === "object") Object.assign(prop, f.type);
    if (f.description) prop.description = f.description;
    if (f.default !== undefined) prop.default = f.default;
    if (f.initializer !== undefined && prop.default === undefined) prop.default = f.initializer;
    if (f.examples) prop.examples = f.examples;
    properties[id] = prop;
  }

  const ctorParams: any[] = classDef.$defs?.constructor?.parameters ?? [];
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
