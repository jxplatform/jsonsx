/**
 * Check-image-lock.ts — the capture lock, and `docs:images:check` (UX-REDESIGN-PLAN §13.5).
 *
 * `scripts/docs/check-doc-refs.ts` asserts that a referenced image resolves into `docs/images/`,
 * that its basename is a name the manifest COULD produce, and `existsSync`. Nothing compares bytes,
 * and no CI job anywhere runs `bun run screenshots` — which is how two shots stayed red on main for
 * weeks under green CI, and why "screenshots come only from scripts/screenshots (never hand-taken)"
 * has been prose in CLAUDE.md and an honour system.
 *
 * This file mechanises it. `scripts/screenshots/capture.lock.json` is committed beside the
 * still-committed PNGs and records, per image, the bytes that were produced and the shot definition
 * they were produced from. Three assertions follow, all blocking:
 *
 * 1. **Exists + manifest-producible** — today's behaviour, now checked against the LOCK, so it holds
 *    on any checkout rather than on whatever happens to be in one working tree.
 * 2. **Never hand-taken** — a PNG in `docs/images/` whose `sha256` has no lock entry FAILS. An editor,
 *    a resize, a `curl` into the directory: all three are now a red X with a name on them.
 * 3. **Current** — each shot's definition hash is recomputed from the working tree and compared with
 *    what the capture recorded. A shot whose declared inputs changed without a re-capture fails.
 *    This is the wholly new guarantee, and the one the honour system could never give.
 *
 * Division of labour with `docs:check`, deliberately:
 *
 * - **`docs:check`** owns the assertions that need PAGE context to be actionable — "docs/x.md
 *   references an image no lock names", "docs/x.md references a quarantined shot". It imports
 *   {@link readLock}, {@link lockedImagePaths} and {@link quarantineRefFindings} from here; it does
 *   not hash a byte.
 * - **`docs:images:check`** (this file's CLI) owns the assertions that need BYTES — it is the only
 *   check that reads 25 MB of PNGs — plus definition currency, lock integrity and the quarantine
 *   report. Its failure has a different owner and a different fix ("re-run the lane", not "fix your
 *   frontmatter"), so it is a separate script rather than more code inside `check-doc-refs.ts`,
 *   which is 328 lines of top-level statements that cannot be imported without running.
 *
 * Both are chained into `docs:verify`, which is what CI runs.
 *
 * **The runner writes the lock; this file defines it.** `scripts/screenshots/run.ts` imports
 * {@link hashShotDefinition} / {@link shotDefinitionHashes}, {@link describeImage},
 * {@link readLock} and {@link writeLock} rather than reimplementing the format — a second
 * implementation of the hash is a lock that passes while meaning nothing.
 *
 * Usage:
 *
 *     bun scripts/check-image-lock.ts                      # the gate
 *     bun scripts/check-image-lock.ts --report out.md \    # the lane's PR comment
 *       --before-lock old.json --before-images /tmp/before/docs/images \
 *       --repo owner/name --before-sha <sha> --after-sha <sha>
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

import { changedPixelRatio, decodePng, readPngSize } from "./lib/png";

/**
 * Paths here are repo-relative, resolved against the repo root rather than `cwd` — the same rule
 * `check-shot-contract.ts` states for the same reason: CI runs from the root and a test runs from
 * `packages/studio`, and a path that means two things depending on where you stand is the bug class
 * these checks exist to catch.
 */
const REPO_ROOT = resolve(import.meta.dir, "..");

export function fromRoot(path: string): string {
  return isAbsolute(path) ? path : resolve(REPO_ROOT, path);
}

export const DEFAULT_MANIFEST = "scripts/screenshots/manifest.json";
export const DEFAULT_LOCK = "scripts/screenshots/capture.lock.json";
export const DEFAULT_IMAGES_DIR = "docs/images";
export const DEFAULT_DOCS_DIR = "docs";

/** The lock FILE's shape. A bump means the shape changed, never that the pictures did. */
export const LOCK_VERSION = 1;

/**
 * The hashing scheme's version, mixed into every definition hash.
 *
 * Changing what counts as part of a shot's definition (the pruned keys, the inherited defaults)
 * must invalidate every recorded hash — otherwise a scheme change silently blesses stale images.
 * Bumping this is a full re-baseline and should be treated as one.
 */
export const DEFINITION_HASH_VERSION = 1;

/**
 * Shot fields that describe the shot rather than the picture, and so are excluded from its hash.
 *
 * `docs` is the page association the report reads; `status` is quarantine. Editing either must NOT
 * demand a re-capture — a quarantine note that forced 3 images to be re-shot would guarantee nobody
 * ever writes one.
 */
export const NON_VISUAL_SHOT_KEYS: readonly string[] = ["docs", "status"];

/** Only `bun run screenshots` writes the lock, and it stamps its origin here. */
const CAPTURED_BY_RE = /^screenshots@[\w.:/#-]+$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const SHA256_RE = /^[\da-f]{64}$/;

// ─── The lock format ──────────────────────────────────────────────────────────

/**
 * The machine a capture came off.
 *
 * Recorded per image and not per file, because a partial re-capture legitimately leaves a lock
 * holding two triples — and a lock that hid that would be claiming a consistency it does not have.
 * Fontset is in here because the Spectrum UI stack resolves differently on NixOS and Ubuntu: a hash
 * lock without a fontset id is a lock over bytes nobody can reproduce.
 */
export interface CaptureRuntime {
  /** Chromium MAJOR only — a patch bump that moves no pixel should not read as drift. */
  chromium: string;
  /** {@link fontsetId} over the resolvable font families. `unknown` when fontconfig is absent. */
  fontset: string;
  /** `ubuntu-24.04`, `nixos-25.05`, `darwin-24` — {@link detectOs}. */
  os: string;
}

/** One captured image. Self-contained: every entry is verifiable without reading another. */
export interface LockImage {
  /** The manifest shot that produced it. */
  shot: string;
  sha256: string;
  width: number;
  height: number;
  bytes: number;
  /** {@link hashShotDefinition} of the shot as it stood at capture time. */
  definition: string;
  capturedAt: string;
  /** `screenshots@ci/<run-id>` or `screenshots@local`. */
  capturedBy: string;
  runtime: CaptureRuntime;
}

export interface CaptureLock {
  lock: number;
  /** Repo-relative path of the manifest these entries were captured from. */
  manifest: string;
  /** Repo-relative image path → entry, sorted by key on write. */
  images: Record<string, LockImage>;
}

export function emptyLock(manifest: string = DEFAULT_MANIFEST): CaptureLock {
  return { images: {}, lock: LOCK_VERSION, manifest };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((entry) => isRecord(entry)) : [];
}

/** Read the lock, or `null` when it does not exist yet (a first capture, and not an error). */
export function readLock(path: string = DEFAULT_LOCK): CaptureLock | null {
  const file = fromRoot(path);
  if (!existsSync(file)) {
    return null;
  }
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isRecord(parsed) || !isRecord(parsed.images)) {
    throw new Error(`${path} is not a capture lock (expected an object with an "images" map)`);
  }
  return {
    images: parsed.images as Record<string, LockImage>,
    lock: typeof parsed.lock === "number" ? parsed.lock : 0,
    manifest: typeof parsed.manifest === "string" ? parsed.manifest : DEFAULT_MANIFEST,
  };
}

/** Entry keys in a fixed order, so a re-capture's diff is the values and never the shape. */
function orderEntry(image: LockImage): LockImage {
  return {
    bytes: image.bytes,
    capturedAt: image.capturedAt,
    capturedBy: image.capturedBy,
    definition: image.definition,
    height: image.height,
    runtime: {
      chromium: image.runtime.chromium,
      fontset: image.runtime.fontset,
      os: image.runtime.os,
    },
    sha256: image.sha256,
    shot: image.shot,
    width: image.width,
  };
}

/** The exact bytes {@link writeLock} commits — separated so a test never touches the disk. */
export function serializeLock(lock: CaptureLock): string {
  const images: Record<string, LockImage> = {};
  for (const path of Object.keys(lock.images).toSorted()) {
    images[path] = orderEntry(lock.images[path]!);
  }
  return `${JSON.stringify({ images, lock: LOCK_VERSION, manifest: lock.manifest }, null, 2)}\n`;
}

/** Write the lock. The ONLY writer is `bun run screenshots`; everything else reads it. */
export async function writeLock(lock: CaptureLock, path: string = DEFAULT_LOCK): Promise<void> {
  await Bun.write(fromRoot(path), serializeLock(lock));
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** First 8 hex digits — enough to name a hash in an error without printing 64 characters. */
export function shortHash(hash: string): string {
  return hash.slice(0, 8);
}

/**
 * Build a lock entry from the bytes just written.
 *
 * Throws on a non-PNG: `width`/`height` are not optional in the format, and an entry that silently
 * recorded `0×0` would make the lock a worse record than no lock.
 */
export function describeImage(
  bytes: Uint8Array,
  meta: {
    shot: string;
    definition: string;
    capturedBy: string;
    runtime: CaptureRuntime;
    capturedAt?: string;
  },
): LockImage {
  const size = readPngSize(bytes);
  if (!size) {
    throw new Error(`shot "${meta.shot}" produced bytes that are not a PNG`);
  }
  return {
    bytes: bytes.length,
    capturedAt: meta.capturedAt ?? new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    capturedBy: meta.capturedBy,
    definition: meta.definition,
    height: size.height,
    runtime: meta.runtime,
    sha256: sha256Hex(bytes),
    shot: meta.shot,
    width: size.width,
  };
}

// ─── The runtime triple ───────────────────────────────────────────────────────

/** `HeadlessChrome/141.0.7390.54` or `141.0.7390.54` → `141`; anything else → `unknown`. */
export function chromiumMajor(version: string): string {
  return /(\d+)\./.exec(version)?.[1] ?? "unknown";
}

/**
 * A stable id for a set of font families.
 *
 * Not the font FILES: two distros ship the same families from different paths, and a path-sensitive
 * id would report drift on every base-image rebuild. Families are what the Spectrum stack resolves
 * against, so families are what the lock records.
 */
export function fontsetId(families: readonly string[]): string {
  const unique = [...new Set(families.map((family) => family.trim()).filter(Boolean))].toSorted();
  if (unique.length === 0) {
    return "unknown";
  }
  return `fc:${sha256Hex(unique.join("\n")).slice(0, 12)}`;
}

/** Ask fontconfig what is installed. `[]` when `fc-list` is absent (macOS without it, or Nix). */
export function detectFontFamilies(): string[] {
  const fc = Bun.which("fc-list", { PATH: process.env.PATH ?? "" });
  if (!fc) {
    return [];
  }
  const proc = Bun.spawnSync([fc, "--format", "%{family[0]}\n"], { stderr: "ignore" });
  if (!proc.success) {
    return [];
  }
  return proc.stdout.toString().split("\n");
}

/** `ubuntu-24.04` from `/etc/os-release`, else `<platform>-<major kernel/darwin version>`. */
export function detectOs(release = "/etc/os-release"): string {
  if (existsSync(release)) {
    const text = readFileSync(release, "utf8");
    const id = /^ID=("?)([^"\n]+)\1$/m.exec(text)?.[2];
    const version = /^VERSION_ID=("?)([^"\n]+)\1$/m.exec(text)?.[2];
    if (id) {
      return version ? `${id}-${version}` : id;
    }
  }
  return `${process.platform}-${process.arch}`;
}

/** The triple to stamp into every entry of a capture run. */
export function captureRuntime(browserVersion: string): CaptureRuntime {
  return {
    chromium: chromiumMajor(browserVersion),
    fontset: fontsetId(detectFontFamilies()),
    os: detectOs(),
  };
}

/** `screenshots@ci/<run-id>` under GitHub Actions, `screenshots@local` otherwise. */
export function captureOrigin(env: Record<string, string | undefined> = process.env): string {
  return env.GITHUB_RUN_ID ? `screenshots@ci/${env.GITHUB_RUN_ID}` : "screenshots@local";
}

// ─── The definition hash ──────────────────────────────────────────────────────

/** Recursively sort keys and drop `undefined` and `//`-prefixed comment keys. Arrays keep order. */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalise(entry));
  }
  if (!isRecord(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).toSorted()) {
    if (key.startsWith("//") || value[key] === undefined) {
      continue;
    }
    out[key] = canonicalise(value[key]);
  }
  return out;
}

/** Everything a shot inherits that can move a pixel. */
export interface ShotDefinitionContext {
  contract?: unknown;
  defaults?: unknown;
}

/**
 * The hash that answers "is this image current?".
 *
 * It covers the shot as authored MINUS {@link NON_VISUAL_SHOT_KEYS}, plus the manifest defaults the
 * shot inherits — so editing `defaults.viewport` correctly invalidates all 61 shots, and adding a
 * `docs:` slug correctly invalidates none. The manifest's `server` block is excluded: a dev-server
 * URL is infrastructure, and treating it as part of the picture would re-baseline the repo every
 * time the port moved.
 */
export function hashShotDefinition(shot: unknown, context: ShotDefinitionContext = {}): string {
  const pruned: Record<string, unknown> = {};
  if (isRecord(shot)) {
    for (const [key, value] of Object.entries(shot)) {
      if (!NON_VISUAL_SHOT_KEYS.includes(key)) {
        pruned[key] = value;
      }
    }
  }
  const payload = canonicalise({
    contract: context.contract ?? null,
    defaults: context.defaults ?? null,
    shot: pruned,
    v: DEFINITION_HASH_VERSION,
  });
  return sha256Hex(JSON.stringify(payload));
}

/** Shot name → definition hash, for a whole manifest. What both the runner and the gate call. */
export function shotDefinitionHashes(manifest: unknown): Map<string, string> {
  const root = isRecord(manifest) ? manifest : {};
  const context: ShotDefinitionContext = { contract: root.contract, defaults: root.defaults };
  const hashes = new Map<string, string>();
  for (const shot of records(root.shots)) {
    if (typeof shot.name === "string") {
      hashes.set(shot.name, hashShotDefinition(shot, context));
    }
  }
  return hashes;
}

// ─── Manifest reading ─────────────────────────────────────────────────────────

export interface ShotStatus {
  state: string;
  reason?: string;
  since?: string;
}

export interface ManifestShot {
  name: string;
  // `| undefined` throughout: `exactOptionalPropertyTypes` is on, and these are built by reading
  // Untyped JSON where "absent" and "present but undefined" arrive as the same thing.
  docs?: string[] | undefined;
  status?: ShotStatus | undefined;
  /** Every image basename the shot can produce, in either contract shape. */
  images: Set<string>;
  raw: Record<string, unknown>;
}

/**
 * Image basenames a shot can produce, read in BOTH contract shapes.
 *
 * Contract 1 is `name` + `regions[].name` + `variants[].suffix`; §13.2's contract is
 * `capture[].image`. Reading both means S2's conversion does not have to touch this file — the same
 * tolerance `check-shot-contract.ts` buys for the same reason.
 */
export function shotImageNames(shot: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  const name = typeof shot.name === "string" ? shot.name : "";
  if (name) {
    names.add(name);
  }
  for (const region of records(shot.regions)) {
    if (typeof region.name === "string") {
      names.add(region.name);
    }
  }
  for (const capture of records(shot.capture)) {
    if (typeof capture.image === "string") {
      names.add(capture.image);
    }
  }
  for (const variant of [...records(shot.variants), ...records(shot.then)]) {
    if (typeof variant.suffix === "string" && name) {
      names.add(`${name}${variant.suffix}`);
    }
    for (const capture of records(variant.capture)) {
      if (typeof capture.image === "string") {
        names.add(capture.image);
      }
    }
  }
  return names;
}

export function readShots(manifest: unknown): ManifestShot[] {
  const root = isRecord(manifest) ? manifest : {};
  const shots: ManifestShot[] = [];
  for (const raw of records(root.shots)) {
    if (typeof raw.name !== "string") {
      continue;
    }
    const status = isRecord(raw.status) ? (raw.status as unknown as ShotStatus) : undefined;
    shots.push({
      docs: Array.isArray(raw.docs)
        ? raw.docs.filter((s): s is string => typeof s === "string")
        : undefined,
      images: shotImageNames(raw),
      name: raw.name,
      raw,
      status,
    });
  }
  return shots;
}

/** Every image basename the pipeline can produce — what `docs:check` name-matches against. */
export function manifestImageNames(manifest: unknown): Set<string> {
  const names = new Set<string>();
  for (const shot of readShots(manifest)) {
    for (const name of shot.images) {
      names.add(name);
    }
  }
  return names;
}

/** Docs slug → shot names that illustrate it, from the shots' own `docs:` field. */
export function shotsByDocsPage(manifest: unknown): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const shot of readShots(manifest)) {
    for (const slug of shot.docs ?? []) {
      map.set(slug, [...(map.get(slug) ?? []), shot.name]);
    }
  }
  return map;
}

export function quarantinedShots(manifest: unknown): ManifestShot[] {
  return readShots(manifest).filter((shot) => shot.status?.state === "quarantined");
}

// ─── Docs image references ────────────────────────────────────────────────────

/**
 * Markdown image targets. Any page-relative path, so a ref pointing somewhere other than
 * `docs/images/` is caught by `check-doc-refs.ts` rather than skipped silently.
 */
const IMAGE_RE = /!\[[^\]]*]\(<?([^\s)>]+\.(?:png|webp|jpg|jpeg))>?\s*(?:"[^"]*")?\)/g;

/** Drop fenced blocks and inline code spans — image syntax quoted as an example is prose. */
export function withoutCode(source: string): string {
  return source.replaceAll(/```[\s\S]*?```/g, "").replaceAll(/`[^\n`]*`/g, "");
}

/** Every image target a markdown source references, code blocks excluded. */
export function imageTargets(source: string): string[] {
  return [...withoutCode(source).matchAll(IMAGE_RE)].map((match) => match[1]!);
}

export interface DocImageRef {
  /** Repo-relative page path, e.g. `docs/studio/publish.md`. */
  page: string;
  /** Repo-relative image path, e.g. `docs/images/git-panel.png`. */
  image: string;
  /** The image's basename without extension — the name a shot produces. */
  name: string;
}

/** Scan `docs/**` for refs that land in `docs/images/`. Others are `check-doc-refs.ts`'s business. */
export function collectDocImageRefs(
  docsDir: string = DEFAULT_DOCS_DIR,
  imagesDir: string = DEFAULT_IMAGES_DIR,
): DocImageRef[] {
  const root = fromRoot(docsDir);
  const images = fromRoot(imagesDir);
  const refs: DocImageRef[] = [];
  for (const rel of [...new Bun.Glob("**/*.md").scanSync({ cwd: root })].toSorted()) {
    const file = join(root, rel);
    for (const target of imageTargets(readFileSync(file, "utf8"))) {
      if (target.startsWith("/") || /^[a-z][\w+.-]*:/i.test(target)) {
        continue;
      }
      const resolved = resolve(dirname(file), target);
      if (dirname(resolved) !== images) {
        continue;
      }
      refs.push({
        image: relative(REPO_ROOT, resolved).replaceAll("\\", "/"),
        name: basename(resolved, extname(resolved)),
        page: relative(REPO_ROOT, file).replaceAll("\\", "/"),
      });
    }
  }
  return refs;
}

// ─── What `docs:check` imports ────────────────────────────────────────────────

/** Repo-relative image paths the lock names. */
export function lockedImagePaths(lock: CaptureLock | null): Set<string> {
  return new Set(Object.keys(lock?.images ?? {}));
}

export interface QuarantineFinding {
  page: string;
  message: string;
}

/**
 * Pages that illustrate themselves with a quarantined shot.
 *
 * Quarantine exists so rot is VISIBLE; a quarantined shot silently illustrating a published page is
 * the opposite. Reported with page context, which is why `docs:check` owns the failure.
 */
export function quarantineRefFindings(
  manifest: unknown,
  refs: readonly DocImageRef[],
  lock: CaptureLock | null,
): QuarantineFinding[] {
  const findings: QuarantineFinding[] = [];
  for (const shot of quarantinedShots(manifest)) {
    const names = new Set(shot.images);
    for (const [path, entry] of Object.entries(lock?.images ?? {})) {
      if (entry.shot === shot.name) {
        names.add(basename(path, extname(path)));
      }
    }
    const reason = shot.status?.reason ?? "no reason given";
    const since = shot.status?.since ? `, since ${shot.status.since}` : "";
    for (const ref of refs) {
      if (names.has(ref.name)) {
        findings.push({
          message:
            `references "${ref.name}" from quarantined shot "${shot.name}" (${reason}${since}) — ` +
            `a quarantined shot must not illustrate a page; fix the shot or drop the image`,
          page: ref.page,
        });
      }
    }
  }
  return findings;
}

// ─── The check ────────────────────────────────────────────────────────────────

export interface ImageOnDisk {
  /** Repo-relative. */
  path: string;
  sha256: string;
  bytes: number;
}

export interface LockCheckInput {
  manifest: unknown;
  lock: CaptureLock | null;
  disk: readonly ImageOnDisk[];
  refs?: readonly DocImageRef[];
}

export interface LockCheckResult {
  violations: string[];
  warnings: string[];
  notes: string[];
  images: number;
  shots: number;
}

function formatBytes(bytes: number): string {
  return bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(1)} MB`
    : `${Math.round(bytes / 1000)} KB`;
}

function describeRuntime(runtime: CaptureRuntime | undefined): string {
  if (!runtime) {
    return "no runtime";
  }
  return `chromium ${runtime.chromium} · ${runtime.fontset} · ${runtime.os}`;
}

/** The three §13.5 assertions, plus lock integrity, as one pure pass over preloaded facts. */
export function checkImageLock(input: LockCheckInput): LockCheckResult {
  const { disk, lock, manifest } = input;
  const refs = input.refs ?? [];
  const violations: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];
  const shots = readShots(manifest);
  const hashes = shotDefinitionHashes(manifest);
  const byName = new Map(shots.map((shot) => [shot.name, shot]));

  if (!lock) {
    if (disk.length > 0 || shots.length > 0) {
      violations.push(
        `${DEFAULT_LOCK} does not exist, and ${DEFAULT_IMAGES_DIR} holds ${disk.length} image(s). ` +
          `The lock is written only by "bun run screenshots" (§13.5) — capture, or let the ` +
          `screenshots lane capture and push it for you.`,
      );
    }
    return { images: disk.length, notes, shots: shots.length, violations, warnings };
  }
  if (lock.lock !== LOCK_VERSION) {
    violations.push(
      `${DEFAULT_LOCK} declares lock ${lock.lock}; scripts/check-image-lock.ts implements ` +
        `${LOCK_VERSION}`,
    );
  }

  // 2. Never hand-taken: every byte on disk was produced by a capture.
  const entries = lock.images;
  for (const image of disk) {
    const entry = entries[image.path];
    if (!entry) {
      violations.push(
        `${image.path} has no entry in ${DEFAULT_LOCK} — screenshots are never hand-taken ` +
          `(§13.5). Produce it with "bun run screenshots", or delete it.`,
      );
      continue;
    }
    if (entry.sha256 !== image.sha256) {
      violations.push(
        `${image.path} does not match the lock: ${shortHash(image.sha256)}… on disk ` +
          `(${formatBytes(image.bytes)}), ${shortHash(entry.sha256)}… locked ` +
          `(${formatBytes(entry.bytes)}) — the bytes were changed by something other than ` +
          `"bun run screenshots".`,
      );
    }
  }

  // 1. Exists: every locked image is present, and belongs to a shot that still exists.
  const onDisk = new Set(disk.map((image) => image.path));
  const staleByShot = new Map<string, string[]>();
  const runtimeTally = new Map<string, number>();
  for (const path of Object.keys(entries).toSorted()) {
    const entry = entries[path]!;
    if (!onDisk.has(path)) {
      violations.push(
        `${DEFAULT_LOCK} names ${path}, which is not on disk — restore the image, or drop the ` +
          `entry and re-capture.`,
      );
    }
    if (!SHA256_RE.test(entry.sha256 ?? "")) {
      violations.push(`${DEFAULT_LOCK} entry ${path} has no valid sha256`);
    }
    if (!CAPTURED_BY_RE.test(entry.capturedBy ?? "")) {
      violations.push(
        `${DEFAULT_LOCK} entry ${path} records capturedBy ${JSON.stringify(entry.capturedBy)}; ` +
          `only "bun run screenshots" writes the lock and it stamps "screenshots@<origin>".`,
      );
    }
    if (!ISO_RE.test(entry.capturedAt ?? "")) {
      violations.push(
        `${DEFAULT_LOCK} entry ${path} records capturedAt ${JSON.stringify(entry.capturedAt)}, ` +
          `which is not an ISO-8601 UTC timestamp.`,
      );
    }
    const { runtime } = entry;
    if (!runtime?.chromium || !runtime.fontset || !runtime.os) {
      violations.push(
        `${DEFAULT_LOCK} entry ${path} records an incomplete runtime triple ` +
          `(${describeRuntime(runtime)}) — Chromium major, fontset id and OS are what make a hash ` +
          `lock reproducible across machines.`,
      );
    } else {
      const key = describeRuntime(runtime);
      runtimeTally.set(key, (runtimeTally.get(key) ?? 0) + 1);
    }

    const shot = byName.get(entry.shot);
    if (!shot) {
      violations.push(
        `${DEFAULT_LOCK} entry ${path} names shot "${entry.shot}", which ${DEFAULT_MANIFEST} no ` +
          `longer declares — delete the image and the entry, or restore the shot.`,
      );
      continue;
    }
    // 3. Current: the shot's declared inputs have not moved since the capture.
    const expected = hashes.get(entry.shot);
    if (expected !== undefined && expected !== entry.definition) {
      staleByShot.set(entry.shot, [...(staleByShot.get(entry.shot) ?? []), path]);
    }
  }

  for (const [shot, paths] of [...staleByShot].toSorted(([a], [b]) => a.localeCompare(b))) {
    const locked = entries[paths[0]!]!.definition;
    violations.push(
      `shot "${shot}" changed since ${paths.join(", ")} ${paths.length === 1 ? "was" : "were"} ` +
        `captured (definition ${shortHash(locked)}… → ${shortHash(hashes.get(shot)!)}…) — ` +
        `re-capture; the screenshots lane does this and pushes it to your branch.`,
    );
  }

  // Shots nothing has ever photographed. A warning: authoring a shot and capturing it are two
  // Commits, and the lane closes the gap. It is only a VIOLATION once a page depends on it, which
  // `docs:check` reports with the page's name.
  const referenced = new Set(refs.map((ref) => ref.name));
  const capturedShots = new Set(Object.values(entries).map((entry) => entry.shot));
  for (const shot of shots) {
    if (capturedShots.has(shot.name) || shot.status?.state === "quarantined") {
      continue;
    }
    const used = [...shot.images].some((name) => referenced.has(name));
    const tail = used ? " and a docs page already references it" : "";
    warnings.push(
      `shot "${shot.name}" has never been captured (no entry in ${DEFAULT_LOCK})${tail}`,
    );
  }

  for (const shot of shots) {
    const { status } = shot;
    if (!status) {
      continue;
    }
    if (status.state !== "quarantined") {
      violations.push(
        `manifest shot "${shot.name}" declares status.state ` +
          `${JSON.stringify(status.state)}; the contract declares "quarantined".`,
      );
      continue;
    }
    if (!status.reason || !status.since) {
      violations.push(
        `manifest shot "${shot.name}" is quarantined without a ` +
          `${status.reason ? "since" : "reason"} — quarantine is a note to the next person, not a ` +
          `mute button.`,
      );
    }
    const since = status.since ? ` (since ${status.since})` : "";
    notes.push(`quarantined: ${shot.name} — ${status.reason ?? "no reason given"}${since}`);
  }

  if (runtimeTally.size > 1) {
    const spread = [...runtimeTally]
      .toSorted(([, a], [, b]) => b - a)
      .map(([key, count]) => `${key} ×${count}`)
      .join("; ");
    notes.push(`lock spans ${runtimeTally.size} runtimes: ${spread}`);
  }

  return { images: disk.length, notes, shots: shots.length, violations, warnings };
}

// ─── The lane's report ────────────────────────────────────────────────────────

/** Identifies the lane's single PR comment, so it is updated rather than duplicated. */
export const REPORT_MARKER = "<!-- jx-screenshots-report -->";

export interface ReportInput {
  /** The lock as committed before the capture. */
  before: CaptureLock | null;
  /** The lock the capture just wrote. */
  after: CaptureLock;
  refs: readonly DocImageRef[];
  /** Repo-relative image path → PNG bytes, for the pixel diff. Omit to fall back to byte sizes. */
  beforeBytes?: ReadonlyMap<string, Uint8Array> | undefined;
  afterBytes?: ReadonlyMap<string, Uint8Array> | undefined;
  /** `owner/name`, plus the two shas, to address before/after thumbnails on github.com. */
  repo?: string | undefined;
  beforeSha?: string | undefined;
  afterSha?: string | undefined;
}

export interface ReportRow {
  path: string;
  shot: string;
  state: "added" | "changed" | "removed";
  change: string;
  pages: string[];
}

/** How much of the picture actually moved, in the most specific terms the inputs support. */
export function describeChange(input: {
  state: ReportRow["state"];
  before?: LockImage | undefined;
  after?: LockImage | undefined;
  beforeBytes?: Uint8Array | undefined;
  afterBytes?: Uint8Array | undefined;
}): string {
  if (input.state === "added") {
    return `new · ${input.after ? formatBytes(input.after.bytes) : "?"}`;
  }
  if (input.state === "removed") {
    return "removed";
  }
  const before = input.before!;
  const after = input.after!;
  if (before.width !== after.width || before.height !== after.height) {
    return `${before.width}×${before.height} → ${after.width}×${after.height}`;
  }
  if (input.beforeBytes && input.afterBytes) {
    const a = decodePng(input.beforeBytes);
    const b = decodePng(input.afterBytes);
    if (a && b) {
      const ratio = changedPixelRatio(a, b);
      if (ratio !== null) {
        return `${(ratio * 100).toFixed(2)}% of pixels`;
      }
    }
  }
  return `${formatBytes(before.bytes)} → ${formatBytes(after.bytes)}`;
}

/** Rows for every image whose bytes are not what the previous lock recorded. */
export function reportRows(input: ReportInput): ReportRow[] {
  const pagesByName = new Map<string, string[]>();
  for (const ref of input.refs) {
    pagesByName.set(ref.name, [...(pagesByName.get(ref.name) ?? []), ref.page]);
  }
  const paths = [
    ...new Set([...Object.keys(input.before?.images ?? {}), ...Object.keys(input.after.images)]),
  ].toSorted();
  const rows: ReportRow[] = [];
  for (const path of paths) {
    const before = input.before?.images[path];
    const after = input.after.images[path];
    if (before && after && before.sha256 === after.sha256) {
      continue;
    }
    const state: ReportRow["state"] = after ? (before ? "changed" : "added") : "removed";
    const name = basename(path, extname(path));
    rows.push({
      change: describeChange({
        after,
        afterBytes: input.afterBytes?.get(path),
        before,
        beforeBytes: input.beforeBytes?.get(path),
        state,
      }),
      pages: pagesByName.get(name) ?? [],
      path,
      shot: (after ?? before)!.shot,
      state,
    });
  }
  return rows;
}

function thumbnail(repo: string | undefined, sha: string | undefined, path: string): string {
  if (!repo || !sha) {
    return "—";
  }
  return `<img width="220" src="https://github.com/${repo}/blob/${sha}/${path}?raw=true">`;
}

/**
 * The lane's PR comment.
 *
 * A table, not a verdict. "12.4% of pixels changed on a shot that illustrates
 * `docs/studio/design/components.md`" is a thing a human can judge in five seconds; a red X on the
 * same information is a thing a human learns to click past, which is how the pictures went stale
 * under green CI in the first place.
 */
export function buildReport(input: ReportInput): string {
  const rows = reportRows(input);
  const lines = [REPORT_MARKER, "", "### Screenshots"];
  if (rows.length === 0) {
    lines.push(
      "",
      "No image changed — every capture matches `scripts/screenshots/capture.lock.json`.",
      "",
    );
    return lines.join("\n");
  }
  lines.push(
    "",
    `**${rows.length} image(s) changed.** Re-captured and pushed to this branch with the updated ` +
      "lock. This is **not** a failure — CI cannot judge whether a picture is right, only whether " +
      "the shot ran. Read the pages in the last column before merging.",
    "",
    "| shot | image | change | before | after | docs pages |",
    "| --- | --- | --- | --- | --- | --- |",
  );
  for (const row of rows) {
    const before = row.state === "added" ? "—" : thumbnail(input.repo, input.beforeSha, row.path);
    const after = row.state === "removed" ? "—" : thumbnail(input.repo, input.afterSha, row.path);
    const pages = row.pages.length > 0 ? row.pages.join("<br>") : "_none_";
    lines.push(
      `| \`${row.shot}\` | \`${basename(row.path)}\` | ${row.change} | ${before} | ${after} | ${pages} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

/** Read every PNG in a directory as `{path, sha256, bytes}`, repo-relative. */
export function readImagesOnDisk(imagesDir: string = DEFAULT_IMAGES_DIR): ImageOnDisk[] {
  const dir = fromRoot(imagesDir);
  if (!existsSync(dir)) {
    return [];
  }
  const images: ImageOnDisk[] = [];
  for (const name of readdirSync(dir).toSorted()) {
    const file = join(dir, name);
    if (!statSync(file).isFile() || !/\.(?:jpe?g|png|webp)$/i.test(name)) {
      continue;
    }
    const bytes = new Uint8Array(readFileSync(file));
    images.push({
      bytes: bytes.length,
      path: `${imagesDir}/${name}`,
      sha256: sha256Hex(bytes),
    });
  }
  return images;
}

function readBytesDir(dir: string | undefined, paths: readonly string[]): Map<string, Uint8Array> {
  const bytes = new Map<string, Uint8Array>();
  if (!dir) {
    return bytes;
  }
  for (const path of paths) {
    const file = join(fromRoot(dir), basename(path));
    if (existsSync(file)) {
      bytes.set(path, new Uint8Array(readFileSync(file)));
    }
  }
  return bytes;
}

const USAGE =
  "Usage: bun scripts/check-image-lock.ts [--manifest <m.json>] [--lock <lock.json>] " +
  "[--images <dir>] [--docs <dir>]\n" +
  "       bun scripts/check-image-lock.ts --report <out.md> [--before-lock <lock.json>] " +
  "[--before-images <dir>] [--repo <owner/name>] [--before-sha <sha>] [--after-sha <sha>]";

const FLAGS = new Set([
  "--after-sha",
  "--before-images",
  "--before-lock",
  "--before-sha",
  "--docs",
  "--images",
  "--lock",
  "--manifest",
  "--repo",
  "--report",
]);

export function parseArgs(argv: readonly string[]): Record<string, string> | null {
  const options: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (!FLAGS.has(flag) || value === undefined) {
      return null;
    }
    options[flag.slice(2)] = value;
  }
  return options;
}

export async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);
  if (!options) {
    console.error(USAGE);
    return 2;
  }
  const manifestPath = options.manifest ?? DEFAULT_MANIFEST;
  const lockPath = options.lock ?? DEFAULT_LOCK;
  const imagesDir = options.images ?? DEFAULT_IMAGES_DIR;
  const docsDir = options.docs ?? DEFAULT_DOCS_DIR;

  let manifest: unknown;
  let lock: CaptureLock | null;
  try {
    manifest = JSON.parse(readFileSync(fromRoot(manifestPath), "utf8")) as unknown;
    lock = readLock(lockPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const refs = collectDocImageRefs(docsDir, imagesDir);

  if (options.report !== undefined) {
    const before = options["before-lock"] === undefined ? null : readLock(options["before-lock"]);
    const after = lock ?? emptyLock(manifestPath);
    const paths = [
      ...new Set([...Object.keys(before?.images ?? {}), ...Object.keys(after.images)]),
    ];
    const markdown = buildReport({
      after,
      afterBytes: readBytesDir(imagesDir, paths),
      afterSha: options["after-sha"],
      before,
      beforeBytes: readBytesDir(options["before-images"], paths),
      beforeSha: options["before-sha"],
      refs,
      repo: options.repo,
    });
    await Bun.write(fromRoot(options.report), markdown);
    console.log(markdown);
    return 0;
  }

  const result = checkImageLock({ disk: readImagesOnDisk(imagesDir), lock, manifest, refs });
  for (const note of result.notes) {
    console.log(`  ${note}`);
  }
  if (result.warnings.length > 0) {
    console.warn(`image lock: ${result.warnings.length} warning(s):`);
    for (const warning of result.warnings) {
      console.warn(`  ${warning}`);
    }
  }
  if (result.violations.length > 0) {
    console.error(`image lock: ${result.violations.length} violation(s):\n`);
    for (const violation of result.violations) {
      console.error(`  ✗ ${violation}`);
    }
    console.error(
      "\nDocs images and the capture lock are written only by `bun run screenshots`, and the " +
        "screenshots CI lane re-captures and pushes both for you (UX-REDESIGN-PLAN §13.5).",
    );
    return 1;
  }
  console.log(
    `image lock: ${result.images} image(s) over ${result.shots} shot(s) match ${lockPath}, ` +
      `and every shot definition is current.`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
