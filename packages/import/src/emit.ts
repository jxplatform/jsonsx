import type { JxElement } from "@jxsuite/schema/types";
import { componentize } from "./componentize.ts";
import { stripClasses } from "./strip-classes.ts";
import type { ComponentizeOptions, ComponentizeResult } from "./componentize.ts";
import type { ImportIo } from "./io.ts";

/**
 * The `$media` key the base width lives under — a number of CSS pixels, not a query.
 *
 * Studio's canvas reads it to size the default artboard (`utils/canvas-media.ts`), and an import
 * never wrote one, so every imported project's base canvas fell back to 320px while its narrowest
 * real breakpoint was three times that. Mirrors `settings/contexts-section.ts`'s `BASE_KEY`.
 */
const BASE_MEDIA_KEY = "--";

/** The width a `--<width>` breakpoint key names, for sorting. Non-numeric keys sort first. */
function mediaKeyWidth(key: string): number {
  const width = Number(key.replace(/^--/, ""));
  return Number.isFinite(width) ? width : -1;
}

export interface EmitResult {
  /** Project-relative, forward-slashed paths of every file written, in the order they were written. */
  files: string[];
  /** How many source-site class names were removed on the way out. */
  classesStripped: number;
  /**
   * The exact `project.json` text that was written.
   *
   * Returned rather than left to be read back, because a caller with no filesystem cannot read it
   * back at all: Jx Cloud commits the emitted file set to git and needs the configuration to name
   * the project, and re-deriving it here would be a second writer on the same bytes.
   */
  projectJson: string;
}

export interface EmitOptions {
  io: ImportIo;
  title: string;
  document: JxElement;
  sourceUrl: string;
  /** $media breakpoints to seed into project.json (Phase 1). */
  breakpoints?: Record<string, string>;
  /** The capture viewport width, written as the `$media` base entry. */
  baseWidth?: number;
  /** Phase 4: componentization options. Pass false to skip. */
  componentizeOptions?: ComponentizeOptions | false;
}

export interface MultiEmitOptions {
  /** Where the emitted files go. See `io.ts` — a disk is one implementation, not the requirement. */
  io: ImportIo;
  title: string;
  sourceUrl: string;
  /** Map of route path (e.g. "pages/index.json") → Jx document. */
  pages: Map<string, JxElement>;
  /** Optional layout to write to layouts/base.json. */
  layout?: JxElement | undefined;
  /** $media breakpoints to seed into project.json. */
  breakpoints?: Record<string, string> | undefined;
  /** The capture viewport width, written as the `$media` base entry. */
  baseWidth?: number | undefined;
  /** Phase 4: componentization options. Pass false to skip. */
  componentizeOptions?: ComponentizeOptions | false | undefined;
  /** Pre-computed componentization result (from AI pass). Overrides componentizeOptions. */
  precomputedComponents?: ComponentizeResult | undefined;
  /** Font-face CSS rule texts to emit as public/assets/fonts.css (R2). */
  fontFaceRules?: string[] | undefined;
  /** URL rewrite map for fonts — maps original font URLs to local paths. */
  fontRewriteMap?: Map<string, string> | undefined;
  /** CSS custom property tokens to hoist into project.json.$style (R5). */
  styleTokens?: Record<string, string> | undefined;
}

export async function emitProject({
  io,
  title,
  document,
  sourceUrl,
  breakpoints,
  baseWidth,
  componentizeOptions,
}: EmitOptions): Promise<EmitResult> {
  return emitMultiPageProject({
    io,
    title,
    sourceUrl,
    pages: new Map([["pages/index.json", document]]),
    breakpoints,
    baseWidth,
    componentizeOptions,
  });
}

export async function emitMultiPageProject({
  io,
  title,
  pages,
  layout,
  breakpoints,
  baseWidth,
  componentizeOptions,
  precomputedComponents,
  fontFaceRules,
  fontRewriteMap,
  styleTokens,
}: MultiEmitOptions): Promise<EmitResult> {
  /* Seeded even when nothing lands in them, so a host that opened the project at the seed event
     sees the shape it expects rather than a directory that grows one folder at a time. A sink with
     no directories declines by not implementing it. */
  for (const dir of ["pages", "layouts", "components", "public"]) {
    await io.mkdir?.(dir);
  }

  /*
   * Only keys the project schema declares (#228). `title` and `description` are page-level keys and
   * `$style` is not a key at all, and all three made every imported project fail `jx validate` —
   * and, because Studio's Contexts editor validates the WHOLE configuration before saving, made an
   * imported project's base width uneditable, reporting `(root): must NOT have unevaluated
   * properties` three times while naming nothing.
   *
   * The source URL has no schema-legal home and does not get one. `$head`'s description meta is the
   * nearest candidate and the wrong one: it is the site's own user-facing description, and
   * "Imported from …" is provenance, not a description of the site. The importer reports it instead.
   */
  const projectJson: Record<string, unknown> = {
    name: title || "Imported Site",
    imports: {},
    images: { optimize: false },
  };

  if (baseWidth !== undefined) {
    projectJson.$media = { [BASE_MEDIA_KEY]: `${Math.round(baseWidth)}px` };
  }
  if (breakpoints && Object.keys(breakpoints).length > 0) {
    /* Ascending, and the base first. `$media` is a map, so its order IS the order Studio's Contexts
       list and the pane's size switcher offer these in; a crawl merged them in page-visit order,
       which is not an order at all. */
    const sorted = Object.entries(breakpoints).toSorted(
      ([a], [b]) => mediaKeyWidth(a) - mediaKeyWidth(b),
    );
    projectJson.$media = { ...(projectJson.$media as object), ...Object.fromEntries(sorted) };
  }

  if (styleTokens && Object.keys(styleTokens).length > 0) {
    projectJson.style = styleTokens;
  }

  const files: string[] = [];

  // Phase 4: componentize pages
  let finalPages = pages;
  const componentFiles = new Map<string, JxElement>();

  const compResult =
    precomputedComponents ??
    (componentizeOptions !== false ? componentize(pages, componentizeOptions ?? {}) : null);

  if (compResult && compResult.components.size > 0) {
    finalPages = compResult.rewrittenPages;

    for (const [fileName, comp] of compResult.components) {
      const compDoc: JxElement = {
        ...comp.template,
        $id: comp.$id,
        tagName: comp.tagName,
      };

      /* Derived placeholders fill in for props the template interpolates but nobody declared;
         a value the template DECLARED wins over them. This was an assignment over the spread, so
         a component that carried its own `state` — the `active` index a tab group switches on —
         lost it on the way out, and every interpolation referencing it went dead. */
      const derived: Record<string, string> = {};
      extractStateDefaults(comp.template, derived);
      const declared = (comp.template.state ?? {}) as Record<string, unknown>;
      const state = { ...derived, ...declared };
      if (Object.keys(state).length > 0) {
        compDoc.state = state as Record<string, string>;
      }

      componentFiles.set(fileName, compDoc);
    }
  }

  // R2: Emit @font-face CSS with URLs rewritten to local paths
  if (fontFaceRules && fontFaceRules.length > 0) {
    let fontCss = fontFaceRules.join("\n\n");
    if (fontRewriteMap) {
      // A @font-face rule carries the url() form its AUTHOR wrote — usually root-relative
      // ("/wp-content/.../lato.woff2"), sometimes protocol-relative. The rewrite map is keyed by the
      // Absolute URL the downloader resolved, so matching on that alone rewrote nothing: every
      // Downloaded font stayed unreferenced and the page fell back to system fonts.
      //
      // Replaced in ONE pass, longest form first. Replacing form by form re-scans text this loop
      // Already rewrote, and a bare pathname ("/a.woff2") then matches inside the local path it
      // Just produced ("/assets/fonts/a.woff2" to "/assets/fonts/assets/fonts/a.woff2").
      const byForm = new Map<string, string>();
      for (const [originalUrl, localPath] of fontRewriteMap) {
        const local = localPath.startsWith("public/")
          ? localPath.slice("public/".length)
          : localPath;
        const href = local.startsWith("/") ? local : `/${local}`;
        const forms = new Set([originalUrl]);
        try {
          const u = new URL(originalUrl);
          forms.add(`//${u.host}${u.pathname}${u.search}`);
          forms.add(`${u.pathname}${u.search}`);
        } catch {
          // Already a relative reference — the literal form is all there is.
        }
        for (const form of forms) {
          if (form) {
            byForm.set(form, href);
          }
        }
      }
      const forms = [...byForm.keys()].toSorted((a, b) => b.length - a.length);
      if (forms.length > 0) {
        const pattern = new RegExp(
          forms.map((f) => f.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)).join("|"),
          "g",
        );
        fontCss = fontCss.replaceAll(pattern, (m) => byForm.get(m) ?? m);
      }
    }
    const fontsCssPath = "public/assets/fonts.css";
    await io.write(fontsCssPath, fontCss);
    files.push(fontsCssPath);

    // Add fonts.css to project head
    if (!projectJson.$head) {
      projectJson.$head = [];
    }
    (projectJson.$head as unknown[]).push({
      tagName: "link",
      attributes: { rel: "stylesheet", href: "/assets/fonts.css" },
    });
  }

  const projectText = `${JSON.stringify(projectJson, null, 2)}\n`;
  await io.write("project.json", projectText);
  files.push("project.json");

  /*
   * Classes go here, at the last possible moment, and that placement is the whole design.
   *
   * `componentize` groups by structure and `ai-componentize` reads the template to choose a name —
   * `product-card` over `component-div-0` — and the class names are the strongest signal either has.
   * Stripping earlier would cost that; stripping later is impossible. So both passes see the source
   * site's classes, and nothing downstream of this line does.
   */
  let classesStripped = 0;
  for (const compDoc of componentFiles.values()) {
    classesStripped += stripClasses(compDoc);
  }
  for (const doc of finalPages.values()) {
    classesStripped += stripClasses(doc);
  }

  // Write components
  for (const [fileName, compDoc] of componentFiles) {
    const compPath = `components/${fileName}`;
    await io.write(compPath, `${JSON.stringify(compDoc, null, 2)}\n`);
    files.push(compPath);
  }

  // Build $elements refs for component registration
  const elementRefs: JxElement[] =
    componentFiles.size > 0
      ? [...componentFiles.keys()].map(
          (f) => ({ $ref: `../components/${f}` }) as unknown as JxElement,
        )
      : [];

  // Write each page
  for (const [route, doc] of finalPages) {
    const pageDoc = { ...doc };
    if (elementRefs.length > 0) {
      pageDoc.$elements = [
        ...elementRefs,
        ...((pageDoc.$elements as JxElement[]) ?? []),
      ] as JxElement[];
    }
    await io.write(route, `${JSON.stringify(pageDoc, null, 2)}\n`);
    files.push(route);
  }

  // Write layout
  const layoutPath = "layouts/base.json";
  const layoutDoc: JxElement = layout ?? {
    tagName: "div",
    children: [{ tagName: "slot" }],
  };
  if (elementRefs.length > 0 && layout) {
    (layoutDoc as Record<string, unknown>).$elements = [
      ...elementRefs,
      ...(((layoutDoc as Record<string, unknown>).$elements as JxElement[]) ?? []),
    ];
  }
  classesStripped += stripClasses(layoutDoc);
  await io.write(layoutPath, `${JSON.stringify(layoutDoc, null, 2)}\n`);
  files.push(layoutPath);

  return { classesStripped, files, projectJson: projectText };
}

/**
 * The state key a whole-string `${state.x}` names, or null.
 *
 * The identifier check is the point. The capture used to be `([^}]+)`, so `${state.active !== 0}` —
 * an expression, not a reference — minted a state entry literally called `active !== 0` beside the
 * real one. Only a bare identifier is a key; anything else is an expression over state and has no
 * default of its own to declare.
 */
function stateKey(text: string): string | undefined {
  const key = text.match(/^\$\{state\.([^}]+)\}$/)?.[1];
  return key !== undefined && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : undefined;
}

function extractStateDefaults(node: JxElement | string, out: Record<string, string>) {
  if (typeof node === "string") {
    const key = stateKey(node);
    if (key && !(key in out)) {
      out[key] = "";
    }
    return;
  }
  if (typeof node.textContent === "string") {
    const key = stateKey(node.textContent);
    if (key && !(key in out)) {
      out[key] = "";
    }
  }
  if (node.attributes) {
    for (const v of Object.values(node.attributes)) {
      if (typeof v === "string") {
        const key = stateKey(v);
        if (key && !(key in out)) {
          out[key] = "";
        }
      }
    }
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      extractStateDefaults(child as JxElement | string, out);
    }
  }
}
