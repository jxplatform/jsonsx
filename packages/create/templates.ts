/**
 * Built-in project templates. All are thin variants of the blank skeleton: they share the files in
 * `template/` and differ in the generated project.json ($media direction, viewport meta) plus, for
 * mobile-app, an overlay of app-shell files from `templates/mobile-app/`.
 */

export type TemplateId = "blank" | "desktop-first" | "mobile-first" | "mobile-app";

export interface TemplateMeta {
  id: TemplateId;
  name: string;
  description: string;
}

export const TEMPLATES: readonly TemplateMeta[] = [
  {
    description: "A minimal desktop-first site with a header, footer, and one page.",
    id: "blank",
    name: "Blank",
  },
  {
    description: "The blank skeleton with desktop-first breakpoints (max-width media queries).",
    id: "desktop-first",
    name: "Desktop First",
  },
  {
    description: "The blank skeleton with mobile-first breakpoints (min-width media queries).",
    id: "mobile-first",
    name: "Mobile First",
  },
  {
    description: "A mobile-first app shell: a scrolling content area above a bottom nav bar.",
    id: "mobile-app",
    name: "Mobile App",
  },
];

/** @returns {TemplateMeta[]} The built-in template list, for pickers and menus */
export function listTemplates(): TemplateMeta[] {
  return [...TEMPLATES];
}

/** @param {string} id */
export function isTemplateId(id: string): id is TemplateId {
  return TEMPLATES.some((t) => t.id === id);
}

// Desktop-first: base canvas is the widest; narrower breakpoints cascade via max-width.
const DESKTOP_FIRST_MEDIA = {
  "--": "1280px",
  "--lg": "(max-width: 1024px)",
  "--md": "(max-width: 768px)",
  "--sm": "(max-width: 640px)",
};

// Mobile-first: base canvas is the narrowest; wider breakpoints cascade via min-width.
const MOBILE_FIRST_MEDIA = {
  "--": "375px",
  "--sm": "(min-width: 640px)",
  "--md": "(min-width: 768px)",
  "--lg": "(min-width: 1024px)",
};

/**
 * The project.json `$media` map for a template: desktop-first templates use max-width queries with
 * the widest base; mobile-first templates use min-width queries with the narrowest base.
 *
 * @param {TemplateId} id
 */
export function mediaForTemplate(id: TemplateId): Record<string, string> {
  return id === "mobile-first" || id === "mobile-app"
    ? { ...MOBILE_FIRST_MEDIA }
    : { ...DESKTOP_FIRST_MEDIA };
}
