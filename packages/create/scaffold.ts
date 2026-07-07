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
