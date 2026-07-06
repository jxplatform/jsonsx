/**
 * The built-in project templates shown on the New Project modal's Template tab. The ids are the
 * contract with `@jxsuite/create/templates` (createProject validates them server-side); the copy
 * here is presentation only. Hardcoded rather than imported: `@jxsuite/create` is a Node CLI
 * package and Studio runs in the browser.
 */

export interface TemplateInfo {
  id: string;
  name: string;
  tagline: string;
  /** Glyph shown in the card's preview area. */
  glyph: string;
  /** The template's default $media map (mirrors @jxsuite/create's mediaForTemplate). */
  media: Record<string, string>;
}

const DESKTOP_FIRST_MEDIA = {
  "--": "1280px",
  "--lg": "(max-width: 1024px)",
  "--md": "(max-width: 768px)",
  "--sm": "(max-width: 640px)",
};

const MOBILE_FIRST_MEDIA = {
  "--": "375px",
  "--sm": "(min-width: 640px)",
  "--md": "(min-width: 768px)",
  "--lg": "(min-width: 1024px)",
};

export const PROJECT_TEMPLATES: readonly TemplateInfo[] = [
  {
    glyph: "+",
    id: "blank",
    media: DESKTOP_FIRST_MEDIA,
    name: "Blank",
    tagline: "Start from scratch",
  },
  {
    glyph: "🖥",
    id: "desktop-first",
    media: DESKTOP_FIRST_MEDIA,
    name: "Desktop First",
    tagline: "Max-width breakpoints",
  },
  {
    glyph: "📱",
    id: "mobile-first",
    media: MOBILE_FIRST_MEDIA,
    name: "Mobile First",
    tagline: "Min-width breakpoints",
  },
  {
    glyph: "📲",
    id: "mobile-app",
    media: MOBILE_FIRST_MEDIA,
    name: "Mobile App",
    tagline: "App shell with bottom navigation",
  },
];
