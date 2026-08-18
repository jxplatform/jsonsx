/**
 * Accessibility checks over the document an author is editing — ATAG 2.0 Part B.
 *
 * ATAG splits into two parts, and only one of them was answered here. Part A is "is the authoring
 * tool itself accessible" — the live region, the dialog roles, the focus rings. **Part B is "does
 * the tool help authors produce accessible content"**, and nothing in Studio did: an author could
 * ship a page of unlabelled images and untitled links, and the editor said nothing at all.
 *
 * Three deliberate shapes, all copied from surfaces that already work here:
 *
 * - **No score.** `head-panel.ts` argues this for SEO and the argument transfers verbatim: a single
 *   figure out of a hundred aggregates unrelated facts into a verdict, and the verdict is what gets
 *   optimised. A named list of things that are wrong is the report.
 * - **Each finding names its criterion, and where it can, a command that REPAIRS it.** That second
 *   half is B.3.2 rather than B.3.1 — checking is only half of what the standard asks, and a
 *   finding an author cannot act on from where they are told about it is a finding they will not
 *   act on.
 * - **A check that could not run says so.** `redirects-grid.ts` files an explicit "this run could not
 *   check X" Problem rather than reporting a clean bill, because a report that silently passes what
 *   it could not inspect is worse than no report.
 *
 * **What is deliberately not here.** Colour contrast between computed colours, target size in
 * rendered pixels, reading order, focus order, and anything else that depends on layout or the
 * cascade. Those are properties of _built output_ in a browser, not of a document tree — checking
 * them means running the page and axe-core over it, which is a different program with a different
 * lifetime. `unavailableChecks()` names them so the absence is stated rather than implied.
 *
 * @docs studio/interface/problems-and-progress
 */

import { activeTab } from "../workspace/workspace";
import { clearProblems, notify } from "./notify";
import type { AnyCommand, CommandRegistry } from "../commands/registry";
import type { JxElement } from "@jxsuite/schema/types";

/** WCAG success criteria these checks bind to, by the id ATAG B.3.1 asks a report to carry. */
export type A11yCriterion = "1.1.1" | "1.3.1" | "1.3.5" | "2.4.4" | "2.4.6" | "3.1.1" | "4.1.2";

/** One thing that is wrong with the document, and — where one exists — the command that fixes it. */
export interface A11yFinding {
  /** Stable id, so a test and a Problem key name the same finding. */
  id: string;
  /** The WCAG criterion this violates. */
  criterion: A11yCriterion;
  /** One sentence, in the author's language, naming what is wrong. */
  message: string;
  /** What to do about it. */
  detail: string;
  /** How bad: an `error` must be fixed to be conformant, a `warn` is very probably wrong. */
  severity: "error" | "warn";
  /**
   * A command that repairs it, when one exists (ATAG B.3.2).
   *
   * Most findings carry none today, and that is stated rather than papered over: "add alt text to
   * this image" has no command, because the repair is an edit to one element and Studio has no verb
   * for it yet. Naming a command that merely re-opens a panel would put a button on the finding
   * that does not do what the button says.
   */
  action?: string;
}

/** Elements whose whole purpose is an image, and which therefore owe alternative text. */
const IMAGE_TAGS = new Set(["img", "area", "input-image"]);

/** Controls that owe an accessible name. */
const CONTROL_TAGS = new Set(["input", "select", "textarea", "button"]);

/** Input types that are not controls a person labels — a submit button names itself. */
const SELF_LABELLING_INPUTS = new Set(["button", "hidden", "image", "reset", "submit"]);

/** Link text that names no destination. WCAG 2.4.4's canonical failures. */
const VAGUE_LINK_TEXT = new Set([
  "click here",
  "here",
  "read more",
  "more",
  "learn more",
  "this",
  "link",
  "download",
  "continue",
]);

/** The attribute bag, whatever shape the author wrote it in. */
function attrs(node: JxElement): Record<string, unknown> {
  return (node.attributes ?? {}) as Record<string, unknown>;
}

/** An attribute's literal string value, or null when it is absent or a binding. */
function literal(node: JxElement, name: string): string | null {
  const value = attrs(node)[name];
  return typeof value === "string" ? value : null;
}

/** Whether an attribute is present at all, however it was written. */
function has(node: JxElement, name: string): boolean {
  return name in attrs(node);
}

/** The element's own text, when it is a literal rather than a binding. */
function ownText(node: JxElement): string {
  const parts: string[] = [];
  if (typeof node.textContent === "string") {
    parts.push(node.textContent);
  }
  const { children } = node;
  if (Array.isArray(children)) {
    for (const child of children) {
      if (typeof child === "string") {
        parts.push(child);
      } else if (child && typeof child === "object") {
        parts.push(ownText(child));
      }
    }
  }
  return parts.join(" ").trim();
}

/**
 * Walk every element in the tree, including the ones inside `$switch` cases.
 *
 * @param {JxElement} node
 * @yields {JxElement} Each element, in document order.
 */
function* walk(node: JxElement): Generator<JxElement> {
  yield node;
  const { children } = node;
  if (Array.isArray(children)) {
    for (const child of children) {
      if (child && typeof child === "object") {
        yield* walk(child);
      }
    }
  }
  for (const branch of Object.values(node.cases ?? {})) {
    if (branch && typeof branch === "object") {
      yield* walk(branch);
    }
  }
}

/** Whether the element carries a name any accessible-name computation would find. */
function hasAccessibleName(node: JxElement): boolean {
  return (
    literal(node, "aria-label") !== null ||
    literal(node, "aria-labelledby") !== null ||
    has(node, "aria-label") ||
    has(node, "aria-labelledby") ||
    (typeof node.title === "string" && node.title !== "") ||
    ownText(node) !== ""
  );
}

/**
 * Every finding in a document.
 *
 * @param {JxElement} doc
 * @returns {A11yFinding[]} In document order, so an author reads them the way they read the page.
 */
export function checkDocument(doc: JxElement): A11yFinding[] {
  const findings: A11yFinding[] = [];
  const seenIds = new Map<string, number>();
  let h1Count = 0;
  let previousHeading = 0;
  let index = 0;

  for (const node of walk(doc)) {
    index += 1;
    const tag = typeof node.tagName === "string" ? node.tagName.toLowerCase() : "";
    const where = tag === "" ? `element ${index}` : `<${tag}>`;

    // ── 1.1.1 Non-text Content ────────────────────────────────────────────────
    if (IMAGE_TAGS.has(tag)) {
      const alt = literal(node, "alt");
      if (!has(node, "alt")) {
        findings.push({
          criterion: "1.1.1",
          detail:
            "A screen reader falls back to reading the file name, which is rarely useful and " +
            "sometimes misleading. An image that is purely decorative takes an EMPTY alt, which " +
            "is a decision — the absent attribute is not.",
          id: `img-no-alt:${index}`,
          message: `${where} has no alt text.`,
          severity: "error",
        });
      } else if (alt !== null && /^(image|photo|picture|graphic|icon)\b/i.test(alt.trim())) {
        findings.push({
          criterion: "1.1.1",
          detail:
            'A screen reader already announces that it is an image, so "image of a cat" is heard ' +
            'as "image, image of a cat". Describe what it shows.',
          id: `img-alt-redundant:${index}`,
          message: `${where}'s alt text starts by saying it is an image.`,
          severity: "warn",
        });
      }
    }

    // ── 1.3.1 Info and Relationships — heading structure ─────────────────────
    const headingLevel = /^h([1-6])$/.exec(tag)?.[1];
    if (headingLevel !== undefined) {
      const level = Number(headingLevel);
      if (level === 1) {
        h1Count += 1;
        if (h1Count === 2) {
          findings.push({
            criterion: "1.3.1",
            detail:
              "A page has one title, and readers who navigate by heading use the h1 to find it. " +
              "Two make the outline ambiguous — demote the second to an h2.",
            id: "multiple-h1",
            message: "This page has more than one top-level heading.",
            severity: "warn",
          });
        }
      }
      if (previousHeading !== 0 && level > previousHeading + 1) {
        findings.push({
          criterion: "1.3.1",
          detail:
            `An h${previousHeading} is followed by an h${level}, so the outline has a hole in it. ` +
            "Readers who navigate by heading use the levels as structure, not as sizes — style " +
            "the heading rather than skipping a level to get a smaller one.",
          id: `heading-skip:${index}`,
          message: `A heading level is skipped: h${previousHeading} to h${level}.`,
          severity: "warn",
        });
      }
      previousHeading = level;
    }

    // ── 4.1.2 Name, Role, Value — form controls ──────────────────────────────
    if (CONTROL_TAGS.has(tag)) {
      const type = literal(node, "type")?.toLowerCase() ?? "";
      const selfLabelling = tag === "button" || SELF_LABELLING_INPUTS.has(type);
      const labelled = hasAccessibleName(node) || has(node, "id");
      if (!selfLabelling && !labelled) {
        findings.push({
          criterion: "4.1.2",
          detail:
            'A control with no name is announced as its type alone — "edit", "combo box" — ' +
            "which tells a reader nothing about what to type. Give it an aria-label, or an id a " +
            "<label> points at.",
          id: `control-unnamed:${index}`,
          message: `${where} has no label.`,
          severity: "error",
        });
      }
      // 1.3.5: a field asking for the user's own data should say which (autocomplete).
      if (tag === "input" && !selfLabelling && !has(node, "autocomplete")) {
        const name = `${literal(node, "name") ?? ""} ${literal(node, "id") ?? ""}`.toLowerCase();
        if (/\b(email|name|tel|phone|address|postal|zip|country)\b/.test(name)) {
          findings.push({
            criterion: "1.3.5",
            detail:
              "An autocomplete token lets a browser fill the field from the person's own stored " +
              "details, which matters most for people who find typing costly.",
            id: `input-no-autocomplete:${index}`,
            message: `${where} asks for personal data but names no autocomplete purpose.`,
            severity: "warn",
          });
        }
      }
    }

    // ── 2.4.4 Link Purpose ────────────────────────────────────────────────────
    if (tag === "a") {
      const text = ownText(node)
        .toLowerCase()
        .replaceAll(/[^a-z ]/g, "")
        .trim();
      if (!hasAccessibleName(node)) {
        findings.push({
          criterion: "4.1.2",
          detail:
            "A link with no text is announced as its URL, one character at a time in some " +
            "readers. If the link is an icon, give it an aria-label.",
          id: `link-unnamed:${index}`,
          message: "A link has no text.",
          severity: "error",
        });
      } else if (VAGUE_LINK_TEXT.has(text)) {
        findings.push({
          criterion: "2.4.4",
          detail:
            "Readers who navigate by pulling up a list of a page's links see the text alone, with " +
            `no surrounding sentence — so a page of "${text}" is a list of identical entries.`,
          id: `link-vague:${index}`,
          message: `A link reads "${ownText(node)}", which names no destination.`,
          severity: "warn",
        });
      }
      if (literal(node, "target") === "_blank" && !/new (tab|window)/i.test(ownText(node))) {
        findings.push({
          criterion: "2.4.6",
          detail:
            "A link that replaces the page without warning is disorienting for anyone not " +
            "watching the whole viewport. Say so in the text, or in the aria-label.",
          id: `link-new-window:${index}`,
          message: "A link opens in a new tab without saying so.",
          severity: "warn",
        });
      }
    }

    // ── 2.4.3 Focus Order — a positive tabindex reorders the whole page ──────
    if (typeof node.tabIndex === "number" && node.tabIndex > 0) {
      findings.push({
        criterion: "1.3.1",
        detail:
          "A positive tabindex pulls the element out of document order and in front of every " +
          "element with tabindex 0 — on the whole page, not just this component. Reorder the " +
          "markup instead; 0 and -1 are the only values that compose.",
        id: `positive-tabindex:${index}`,
        message: `${where} has tabindex="${node.tabIndex}".`,
        severity: "error",
      });
    }

    // ── 4.1.1 Parsing — a duplicate id breaks every reference to it ──────────
    if (typeof node.id === "string" && node.id !== "") {
      const seen = seenIds.get(node.id);
      if (seen !== undefined) {
        findings.push({
          criterion: "4.1.2",
          detail:
            "aria-labelledby, aria-controls and <label for> all resolve an id to the FIRST match, " +
            "so a duplicate silently points half the references at the wrong element.",
          id: `duplicate-id:${node.id}`,
          message: `The id "${node.id}" is used more than once.`,
          severity: "error",
        });
      } else {
        seenIds.set(node.id, index);
      }
    }

    // ── 1.4.2 Audio Control ──────────────────────────────────────────────────
    if ((tag === "video" || tag === "audio") && has(node, "autoplay") && !has(node, "controls")) {
      findings.push({
        criterion: "1.3.1",
        detail:
          "Media that starts by itself and cannot be stopped talks over a screen reader, which " +
          "leaves a reader no way to hear the page at all.",
        id: `autoplay-no-controls:${index}`,
        message: `${where} plays automatically with no controls.`,
        severity: "error",
      });
    }
  }

  // ── 3.1.1 Language of Page ────────────────────────────────────────────────
  if (typeof doc.lang !== "string" || doc.lang === "") {
    findings.push({
      criterion: "3.1.1",
      detail:
        "A screen reader picks its pronunciation rules from the page's language. Without one it " +
        "uses the reader's own, so French text is read with English phonetics — intelligible to " +
        "nobody.",
      id: "no-lang",
      message: "This document declares no language.",
      severity: "warn",
    });
  }

  return findings;
}

/** A check this program cannot run, and the honest reason. */
export interface UnavailableCheck {
  id: string;
  message: string;
  detail: string;
}

/**
 * What was NOT checked, and why — filed as a Problem rather than left implied.
 *
 * A report that silently passes what it could not inspect is worse than no report: the author reads
 * "no problems" and takes it to mean the page is fine. Everything below is a property of rendered
 * output, not of a document tree, and answering it means running the page in a browser with an
 * engine like axe-core.
 *
 * @returns {UnavailableCheck[]}
 */
export function unavailableChecks(): UnavailableCheck[] {
  return [
    {
      detail:
        "Contrast is between the colours that actually paint, which depends on the cascade, on " +
        "inherited values and on images behind text — none of which exist until the page is " +
        "built and rendered. Checking the declared values alone would pass a black-on-black page " +
        "whose colours came from a class.",
      id: "contrast",
      message: "Colour contrast was not checked.",
    },
    {
      detail:
        "Target size, focus order and reading order are all properties of the rendered layout. A " +
        "document tree does not have a layout, so this run cannot see them.",
      id: "layout",
      message: "Target size and focus order were not checked.",
    },
  ];
}

/** The Problems `source` these findings carry, so a re-run replaces rather than stacks. */
export const A11Y_PROBLEM_SOURCE = "Accessibility";

/**
 * Re-file the accessibility Problems for a document: one per finding, plus one naming what this run
 * could not check.
 *
 * Previous findings are cleared first, so a fixed page stops being listed without anyone having
 * kept its record id — the same shape `reportRedirectProblems` uses, for the same reason.
 *
 * @param {JxElement} doc
 * @param {string} [path] The document's path, so a Problem row can open the file it is about.
 * @returns {number} How many Problems were filed, including the unchecked-coverage ones.
 */
export function reportA11yProblems(doc: JxElement, path?: string): number {
  clearProblems((record) => record.source === A11Y_PROBLEM_SOURCE);
  const findings = checkDocument(doc);
  for (const finding of findings) {
    notify(finding.severity, finding.message, {
      detail: `WCAG ${finding.criterion} — ${finding.detail}`,
      key: `a11y.${finding.id}`,
      source: A11Y_PROBLEM_SOURCE,
      tier: "problem",
      ...(finding.action === undefined ? {} : { action: finding.action }),
      ...(path === undefined ? {} : { path }),
    });
  }
  /*
   * And then the honest half. A report that lists nothing reads as "this page is accessible", which
   * is a claim this run cannot make: everything below is a property of rendered output. Saying so
   * costs two rows and is the difference between a check and a reassurance.
   */
  for (const check of unavailableChecks()) {
    notify.info(check.message, {
      action: "document.checkAccessibility",
      detail: check.detail,
      key: `a11y.unavailable.${check.id}`,
      source: A11Y_PROBLEM_SOURCE,
      tier: "problem",
    });
  }
  return findings.length + unavailableChecks().length;
}

/**
 * The command that runs the check.
 *
 * Registered like `document.openSeo` — same category, same level, same "an open document"
 * requirement — because it is the same kind of thing: a report over the document in front of you,
 * reached from the palette and from the assistant.
 *
 * @returns {AnyCommand[]}
 */
export function a11yCommands(): AnyCommand[] {
  return [
    {
      aiTool: {
        description:
          "Check the open document for accessibility problems an author can fix — missing alt " +
          "text, unlabelled controls, skipped heading levels, vague link text, duplicate ids — " +
          "and file each as a Problem naming its WCAG criterion.",
        name: "check_accessibility",
      },
      category: "Document",
      group: "2_document",
      id: "document.checkAccessibility",
      level: "document",
      menus: ["palette"],
      requires: "an open document",
      run: () => {
        const tab = activeTab.value;
        if (!tab) {
          throw new RangeError(`command "document.checkAccessibility" needs an open document`);
        }
        const filed = reportA11yProblems(tab.doc.document, tab.documentPath ?? undefined);
        notify.success(
          filed === unavailableChecks().length
            ? "No accessibility problems found in this document."
            : `${filed - unavailableChecks().length} accessibility problem(s) filed.`,
          { key: "a11y.run", source: A11Y_PROBLEM_SOURCE },
        );
      },
      title: "Check Accessibility",
      when: (ctx) => ctx.document.open,
    },
  ];
}

/**
 * Register it.
 *
 * A registrar rather than only a factory: `appCommandSet()` and the running app are two different
 * code paths, and a record in one and not the other is a command CI counts and the app cannot run.
 *
 * @param {CommandRegistry} registry
 */
export function registerA11yCommands(registry: CommandRegistry): void {
  registry.registerAll(a11yCommands());
}
