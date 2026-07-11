/**
 * Pure scaffolding helpers — zero node imports so Studio can run them in the browser (the publish
 * flow writes wrangler.jsonc through the PAL) and cloud platforms can seed repos through the Git
 * Data API. generate.ts wraps these with filesystem I/O.
 */

const CF_ADAPTERS = new Set(["cloudflare-pages", "cloudflare-workers"]);

/** True when the adapter deploys through wrangler (needs a wrangler.jsonc). */
export function adapterNeedsWrangler(adapter: string | undefined): boolean {
  return Boolean(adapter && CF_ADAPTERS.has(adapter));
}

/**
 * A fresh wrangler.jsonc for the adapter. `name` becomes the Cloudflare project name — when the
 * project has a `build.deploy` block, pass its projectName so the config and the connected Pages
 * project agree.
 */
export function buildWranglerJsonc({ slug, adapter }: { slug: string; adapter: string }): string {
  const compatibilityDate = new Date().toISOString().slice(0, 10);

  // Nodejs_compat: server functions routinely pull in Node-flavored npm packages
  const config =
    adapter === "cloudflare-workers"
      ? {
          assets: { binding: "ASSETS", directory: "./dist" },
          compatibility_date: compatibilityDate,
          compatibility_flags: ["nodejs_compat"],
          main: "./dist/worker.js",
          name: slug,
        }
      : {
          compatibility_date: compatibilityDate,
          compatibility_flags: ["nodejs_compat"],
          name: slug,
          pages_build_output_dir: "./dist",
        };

  return `${JSON.stringify(config, null, "\t")}\n`;
}

/**
 * Deep-merge connector binding fragments into a wrangler.jsonc (plan Part 4a; consumed by `jx db
 * push`). Fragments are the `bindings` connector-capability results — e.g. `{ d1_databases: [{
 * binding, database_id }] }` or `{ hyperdrive: [{ binding, id }] }`.
 *
 * Merge rules: objects merge recursively; arrays whose elements carry a `binding` key are keyed by
 * it (same-binding entries merge, new ones append — user-added keys on an entry survive); other
 * values only land when the user has not set them (user keys are preserved). Unparseable
 * (comment-bearing) JSONC is returned unchanged with `patched: false` rather than risking data
 * loss.
 *
 * @param {string | null} existing - Current wrangler.jsonc content, or null when absent
 * @param {Record<string, unknown>[]} fragments - Binding fragments, applied in order
 * @returns {{ content: string; patched: boolean }}
 */
export function applyBindingFragments(
  existing: string | null,
  fragments: Record<string, unknown>[],
): { content: string; patched: boolean } {
  if (fragments.length === 0) {
    return { content: existing ?? "", patched: false };
  }
  let config: Record<string, unknown> = {};
  if (existing) {
    try {
      config = JSON.parse(existing) as Record<string, unknown>;
    } catch {
      // Comment-bearing JSONC — leave the user's file alone.
      return { content: existing, patched: false };
    }
  }
  for (const fragment of fragments) {
    mergeBindingValue(config, fragment);
  }
  return { content: `${JSON.stringify(config, null, "\t")}\n`, patched: true };
}

/** Recursively merge one fragment object into the target, per the applyBindingFragments rules. */
function mergeBindingValue(target: Record<string, unknown>, fragment: Record<string, unknown>) {
  for (const [key, incoming] of Object.entries(fragment)) {
    const current = target[key];
    if (Array.isArray(incoming)) {
      target[key] = mergeBindingArrays(Array.isArray(current) ? current : [], incoming);
      continue;
    }
    if (isPlainObject(incoming)) {
      if (isPlainObject(current)) {
        mergeBindingValue(current, incoming);
      } else if (current === undefined) {
        target[key] = structuredClone(incoming);
      }
      continue;
    }
    if (current === undefined) {
      target[key] = incoming;
    }
  }
}

/** Merge fragment array entries into an existing array, keyed by each entry's `binding`. */
function mergeBindingArrays(current: unknown[], incoming: unknown[]): unknown[] {
  const merged = [...current];
  for (const entry of incoming) {
    if (!isPlainObject(entry) || typeof entry.binding !== "string") {
      // Non-binding-keyed values: append when missing (dedupe by deep equality).
      const exists = merged.some((m) => JSON.stringify(m) === JSON.stringify(entry));
      if (!exists) {
        merged.push(structuredClone(entry));
      }
      continue;
    }
    const index = merged.findIndex(
      (m) => isPlainObject(m) && (m as Record<string, unknown>).binding === entry.binding,
    );
    if (index === -1) {
      merged.push(structuredClone(entry));
    } else {
      // Fragment values win for connector-owned keys; user-added extra keys survive.
      merged[index] = { ...(merged[index] as Record<string, unknown>), ...entry };
    }
  }
  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Patch an existing wrangler.jsonc for an adapter change (or a Pages project rename), touching only
 * the adapter-shape keys and preserving everything else the user added. Regenerates from scratch
 * when the input is missing or unparseable (wrangler.jsonc supports comments, which JSON.parse does
 * not — a commented config falls back to regeneration rather than data loss... it is returned
 * unchanged with `patched: false` so callers can warn).
 */
export function updateWranglerConfig(
  existing: string | null,
  { slug, adapter }: { slug: string; adapter: string },
): { content: string; patched: boolean } {
  if (!existing) {
    return { content: buildWranglerJsonc({ adapter, slug }), patched: true };
  }
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(existing) as Record<string, unknown>;
  } catch {
    // Comment-bearing JSONC — leave the user's file alone.
    return { content: existing, patched: false };
  }
  config["name"] = slug;
  if (adapter === "cloudflare-workers") {
    delete config["pages_build_output_dir"];
    config["main"] = "./dist/worker.js";
    config["assets"] = { binding: "ASSETS", directory: "./dist" };
  } else {
    delete config["main"];
    delete config["assets"];
    config["pages_build_output_dir"] = "./dist";
  }
  return { content: `${JSON.stringify(config, null, "\t")}\n`, patched: true };
}
