/// <reference lib="dom" />
/**
 * The rail foot's ⚙ Settings menu — a RENDERING of the `settings/menu` placement.
 *
 * The gear used to run one command. That was the right shape for a pinned slot and the wrong shape
 * for the question people bring to it: Studio has two settings families at two containment levels —
 * `app.preferences` (the application, ⌘,) and `settings.open` (this project, ⌘⇧,) — plus a third
 * editor over the same project document, `styles.open`. A slot can hold one of those and must lie
 * about the rest by omission. A menu can hold all three and say what each one is, because it prints
 * every row's own name, chord and gate beside it (§12.3). That is the whole argument for the matrix
 * row `settings/menu` admitting two levels, and for the divider this file draws where the level
 * changes.
 *
 * **Nothing here is a list of actions.** The rows are `registry.forPlacement("settings/menu")`, so
 * a record joins the menu by declaring the placement and leaves by not declaring it. The submenus
 * are the enumeration of each parent command's own `section` ARGUMENT, read from that argument's
 * own definition site — which is state the command already validates, not a second vocabulary
 * (§12.5).
 *
 * **A parent row runs its own command AND owns a submenu**, which the APG menu pattern does not
 * describe and Spectrum's stock `slot="submenu"` forbids outright:
 * `Menu.handlePointerBasedSelection` bails on `hasSubmenu`, so a parent emits no `change`, and
 * `MenuItem.handleSubmenuChange` reports the PARENT's value to the outer menu, which would break
 * the deep link as well. So the submenu is a second `renderPopover` and the parent keeps its own
 * `@click`. The deviation is recorded in `specs/studio-ui-guidelines.md` §8.4 and §14; nothing is
 * unreachable by keyboard because Enter runs the row, ArrowRight reaches every child, and every
 * child is also in the settings document's own inner nav.
 *
 * **There is no hover-intent timer, deliberately.** A timer is this suite's largest flake source
 * and buys a nicety rather than a capability; a submenu closes when the pointer enters a SIBLING
 * row, so diagonal travel into an open submenu crosses nothing that would shut it. Do not "fix"
 * this by adding one.
 *
 * The machinery is `editor/context-menu.ts:828-1094`'s, with its function names kept, so folding
 * both onto a shared `ui/menu.ts` is a move rather than a rewrite.
 *
 * @docs studio/interface/preferences
 * @docs studio/projects/settings
 */

import { html, nothing } from "lit-html";
import { errorMessage } from "@jxsuite/schema/parse";
import { activeRegistry } from "../commands/active-registry";
import { LEVELS } from "../commands/levels";
import { notify } from "../services/notify";
import { onSettingsDocumentChanged, sortedSettingsSections } from "../settings/section-registry";
import { PREFERENCES_SECTIONS } from "../settings/preferences-sections";
import { renderPopover } from "../ui/layers";
import { REGION_ATTR } from "../ui/regions";
import { rectOf } from "../utils/geometry";

import type { TemplateResult } from "lit-html";
import type { AnyCommand, CommandRegistry } from "../commands/registry";
import type { Level } from "../commands/levels";

/** The placement the rail's gear renders. One definition site for the string. */
export const SETTINGS_MENU_PLACEMENT = "settings/menu" as const;

/** One value a parent command's `section` argument accepts. */
interface MenuSection {
  key: string;
  label: string;
}

/** One row of the root menu. Everything it prints comes off the record. */
interface MenuRow {
  command: AnyCommand;
  enabled: boolean;
  reason: string | undefined;
  chord: string | undefined;
  /** Whether a divider opens this row's LEVEL group. */
  dividerAbove: boolean;
  /** The values this command's own `section` argument accepts. Empty ⇒ no submenu. */
  sections: readonly MenuSection[];
}

type PopoverHandle = ReturnType<typeof renderPopover>;

let _root: PopoverHandle | null = null;
let _sub: PopoverHandle | null = null;
let _rows: MenuRow[] = [];
let _activeIdx = 0;
/** Which root row owns the open submenu; -1 = none. */
let _subIdx = -1;
let _subActiveIdx = 0;
let _focus: "root" | "sub" = "root";
let _opener: HTMLElement | null = null;
let _rerender: (() => void) | null = null;
let _unsubscribe: (() => void) | null = null;
let _outside: ((e: MouseEvent) => void) | null = null;
let _x = 0;
let _y = 0;
let _sx = 0;
let _sy = 0;

// ─── Where a submenu's rows come from ─────────────────────────────────────────

/**
 * A command's `section` argument, enumerated from that argument's OWN definition site.
 *
 * NOT the second list of actions §12.5 forbids: it holds no titles, no handlers and no ordering of
 * its own. Each entry points at the array the command's validation already reads —
 * `app.preferences` refuses anything `isPreferencesSection` rejects, `settings.open` refuses
 * anything absent from `settingsSectionKeys()` — so a submenu row can never name a value its own
 * command would refuse.
 */
const SECTION_SOURCES: Readonly<Record<string, () => readonly MenuSection[]>> = {
  "app.preferences": () =>
    PREFERENCES_SECTIONS.map((section) => ({ key: section.id, label: section.title })),
  "settings.open": () =>
    sortedSettingsSections().map((section) => ({ key: section.key, label: section.label })),
};

/** The sections a row offers, or none. */
function menuSectionsFor(id: string): readonly MenuSection[] {
  return SECTION_SOURCES[id]?.() ?? [];
}

// ─── Rows ─────────────────────────────────────────────────────────────────────

/**
 * Ask the registry what belongs in the gear right now, ordered level-first.
 *
 * `forPlacement` already filters by `when` and sorts by `group` then title; `toSorted` is stable,
 * so that order survives inside each level group. The divider falls where the LEVEL changes, which
 * is the same boundary the rail's own panel groups draw — and the reason a menu may hold two levels
 * where a pinned slot may not.
 */
function buildSettingsMenuRows(registry: CommandRegistry): MenuRow[] {
  const commands = [...registry.forPlacement(SETTINGS_MENU_PLACEMENT)].toSorted(
    (a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level),
  );
  let level: Level | undefined;
  return commands.map((command, index) => {
    const dividerAbove = index > 0 && command.level !== level;
    ({ level } = command);
    const enabled = registry.isEnabled(command.id);
    const chord = registry.keymap.formatBinding(command.id);
    return {
      // A chord that just restates the row's own name teaches nothing and reads as a stutter.
      chord: chord?.toLowerCase() === command.title.toLowerCase() ? undefined : chord,
      command,
      dividerAbove,
      enabled,
      reason: enabled ? undefined : registry.disabledReason(command.id),
      // A row whose command cannot run offers no sections: every one of them runs that same refusal.
      sections: enabled ? menuSectionsFor(command.id) : [],
    };
  });
}

// ─── Running ──────────────────────────────────────────────────────────────────

/**
 * Run a row's command, surfacing a refusal instead of stranding it.
 *
 * `settings.open`'s `run` is async and throws a `RangeError` AFTER awaiting the contributed-section
 * sync, and `registry.run` does not catch. `editor/context-menu.ts`'s bare `void result` is safe
 * only because every element verb is synchronous; here an unknown section would reject into
 * nothing.
 */
function runRow(id: string, args?: Record<string, unknown>): void {
  const registry = activeRegistry();
  if (!registry) {
    return;
  }
  let result: unknown;
  try {
    result = registry.run(id, args as never);
  } catch (error) {
    notify.error(errorMessage(error), { source: id });
    return;
  }
  void Promise.resolve(result).catch((error: unknown) => {
    notify.error(errorMessage(error), { source: id });
  });
}

// ─── Focus ────────────────────────────────────────────────────────────────────

/** The rendered root rows, in order. */
function rootItems(): HTMLElement[] {
  return _root
    ? [..._root.host.querySelectorAll<HTMLElement>("sp-menu-item[data-command-id]")]
    : [];
}

/** The rendered submenu rows, in order. */
function subItems(): HTMLElement[] {
  return _sub ? [..._sub.host.querySelectorAll<HTMLElement>("sp-menu-item[data-section-key]")] : [];
}

/**
 * Move the roving tabindex (and the caret) to `index`, wrapping at both ends.
 *
 * `tabIndex` is written BEFORE `.focus()`: an `sp-menu-item` is an undefined custom element until
 * `ui/spectrum.ts` loads, and a plain unknown element is only focusable once it has one.
 */
function focusItem(items: HTMLElement[], index: number): number {
  if (items.length === 0) {
    return 0;
  }
  const next = ((index % items.length) + items.length) % items.length;
  for (const [at, item] of items.entries()) {
    item.tabIndex = at === next ? 0 : -1;
    item.toggleAttribute("focused", at === next);
  }
  items[next]?.focus();
  return next;
}

function focusRoot(index: number): void {
  _activeIdx = focusItem(rootItems(), index);
}

function focusSub(index: number): void {
  _subActiveIdx = focusItem(subItems(), index);
}

/** How many frames to keep re-applying a freshly opened submenu's caret before giving up. */
const FOCUS_SETTLE_FRAMES = 8;

/**
 * Move a freshly opened submenu's caret, and keep asking until it lands.
 *
 * `sp-menu-item.focus()` is a no-op until Spectrum has finished setting the item up, and `sp-menu`
 * runs its own roving-tabindex pass over its items after they connect — so applying once, even a
 * frame later, is still too early. The symptom is precise and bad: the logical caret is right
 * (Enter runs the correct section) while the focus RING stays on the parent row, so the keyboard
 * and the screen disagree about where you are. `panels/tab-strip.ts` records meeting the same
 * component behaviour from the other side.
 *
 * Rather than guess the settle point, this re-applies on each of the next few frames and stops the
 * moment the browser agrees. The first pass is synchronous so a test in happy-dom — where the
 * element is inert and focus is immediate — sees it on the same tick and never schedules a second.
 * Every pass is guarded, so a pointer that has since moved to another row is not yanked back.
 *
 * @param owner Which root row's submenu this is — the guard against a stale deferral.
 */
function focusSubSettled(index: number, owner: number): void {
  focusSub(index);
  let attempts = 0;
  const settle = () => {
    if (_focus !== "sub" || _subIdx !== owner || !_sub) {
      return;
    }
    const wanted = subItems()[_subActiveIdx];
    if (!wanted || document.activeElement === wanted) {
      return;
    }
    focusSub(_subActiveIdx);
    attempts += 1;
    if (attempts < FOCUS_SETTLE_FRAMES) {
      requestAnimationFrame(settle);
    }
  };
  requestAnimationFrame(settle);
}

// ─── Geometry ─────────────────────────────────────────────────────────────────

/**
 * Clamp a rendered popover into the viewport, writing the result back into module state.
 *
 * The predecessor mutated the `x`/`y` its own render had closed over, which is why
 * `editor/context-menu.ts:851-861` says re-rendering to move focus would re-run the placement from
 * stale coordinates. Writing into `_x`/`_y` makes `renderRoot()` idempotent instead, which is what
 * lets the section subscription repaint an open submenu freely.
 *
 * **Both axes are floored**, not just capped. Project Settings has ~16 sections once extensions
 * have contributed, and a submenu taller than the viewport would otherwise be pushed to a negative
 * `top` — its first rows off the top of the window, unreachable. The floor plus the
 * `.settings-submenu` height cap is what keeps the whole list reachable.
 */
/**
 * The lowest edge any menu in this stack may reach.
 *
 * The trigger's REGION, not the viewport. The gear sits in the rail, whose bottom is the status
 * bar's top — so clamping to the viewport lets a tall submenu run down over the status bar while
 * the root menu sits neatly above it. One floor for both levels is what keeps the stack looking
 * like one surface.
 */
function menuFloor(): number {
  const host = _opener?.closest<HTMLElement>(`[${REGION_ATTR}]`);
  return host ? rectOf(host).bottom : window.innerHeight;
}

/** Keep a popover inside the menu area — floored as well as capped, on both axes. */
function clampIntoMenuArea(
  box: DOMRect,
  origin: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: Math.max(4, Math.min(origin.x, window.innerWidth - box.width - 4)),
    y: Math.max(4, Math.min(origin.y, menuFloor() - box.height)),
  };
}

/**
 * Where the root menu wants to sit: hanging off the trigger's right edge, with its BOTTOM flush
 * with the bottom of the region the trigger lives in.
 *
 * Not the trigger's own bottom, and not "below the trigger". The gear is the last control in a
 * full-height rail whose foot abuts the status bar, so a menu dropped below it would be off-screen
 * and one aligned to the button would float six pixels of `.rail-footer` padding clear of the
 * status bar. Aligning to the REGION is what puts it flush, and it is expressed through the shell's
 * own addressing grammar rather than a selector into markup — so a menu button in another region
 * would align to that one without this function learning about it.
 */
function rootOrigin(box: DOMRect): { x: number; y: number } {
  if (!_opener) {
    return { x: _x, y: _y };
  }
  const anchor = rectOf(_opener);
  return { x: anchor.right + 4, y: menuFloor() - box.height };
}

/**
 * Place a popover, now and again after the browser has laid it out.
 *
 * **The second pass is the one that works.** A popover measures 0×0 until layout runs, and layout
 * does not run inside the call that rendered it — so the synchronous pass clamps against a
 * zero-height box and parks the menu at the bottom edge of the window, which is precisely where a
 * control at the foot of a full-height rail puts it. `editor/context-menu.ts` does its clamp inside
 * a `requestAnimationFrame` for this reason; keeping the first pass as well costs nothing and means
 * a caller that CAN measure (a repaint of an already-open menu) is right immediately.
 *
 * Running twice is safe because the clamp is idempotent and reads its own output: a first pass that
 * parked the origin too low is pulled back up by the second pass's `Math.min`.
 *
 * @param apply Receives the clamped origin — it writes module state and the element's style.
 */
function placePopover(
  el: HTMLElement,
  desired: (box: DOMRect) => { x: number; y: number },
  apply: (at: { x: number; y: number }) => void,
): void {
  const pass = () => {
    const box = rectOf(el);
    apply(clampIntoMenuArea(box, desired(box)));
  };
  pass();
  requestAnimationFrame(() => {
    if (el.isConnected) {
      pass();
    }
  });
}

// ─── Templates ────────────────────────────────────────────────────────────────

/**
 * The row's trailing cell: its chord, its chevron, or both.
 *
 * ONE slotted node, not two. Spectrum's menu-item grid gives `[slot=value]` a single cell with
 * `justify-self: end`, and that applies to each assigned node independently — so a `<kbd>` and a
 * chevron both slotted directly land on top of each other. Wrapping them makes the cell one flex
 * row, which is also where the gap between the title and the chord comes from.
 */
function valueTpl(chord: string | undefined, hasSections: boolean) {
  if (!chord && !hasSections) {
    return nothing;
  }
  return html`<span slot="value" class="settings-menu-value"
    >${chord ? html`<kbd class="cmd-chord">${chord}</kbd>` : nothing}${
      hasSections
        ? html`<sp-icon-chevron-right size="s" aria-hidden="true"></sp-icon-chevron-right>`
        : nothing
    }</span
  >`;
}

/**
 * One root row.
 *
 * A row that owns sections still ACTIVATES — `@click` runs its own command with no arguments, so
 * "Open Project Settings" opens Project Settings on its default section and the submenu is a second
 * way in rather than a replacement for the first. `aria-haspopup`/`aria-expanded` bind to `nothing`
 * on a row without sections so lit removes the attributes rather than emitting
 * `aria-haspopup="false"`.
 */
function rowTemplate(row: MenuRow, index: number): TemplateResult {
  const hasSections = row.sections.length > 0;
  const expanded = hasSections ? (_subIdx === index ? "true" : "false") : nothing;
  return html`${row.dividerAbove ? html`<sp-menu-divider role="separator"></sp-menu-divider>` : nothing}<sp-menu-item
      role="menuitem"
      data-command-id=${row.command.id}
      tabindex=${index === _activeIdx ? 0 : -1}
      ?focused=${index === _activeIdx}
      ?disabled=${!row.enabled}
      aria-disabled=${row.enabled ? "false" : "true"}
      aria-haspopup=${hasSections ? "menu" : nothing}
      aria-expanded=${expanded}
      @mouseenter=${() => {
        if (hasSections) {
          openSubmenu(index);
        } else {
          closeSubmenu({ restoreFocus: false });
        }
      }}
      @click=${() => activateRow(index)}
      >${row.command.title}${valueTpl(row.chord, hasSections)}${
        row.reason ? html`<span slot="description">Needs ${row.reason}</span>` : nothing
      }</sp-menu-item
    >`;
}

/** One submenu row — named by the argument value it passes, never by a reworded command title. */
function sectionTemplate(parent: MenuRow, section: MenuSection, index: number): TemplateResult {
  return html`<sp-menu-item
    role="menuitem"
    data-section-key=${section.key}
    tabindex=${index === _subActiveIdx ? 0 : -1}
    ?focused=${index === _subActiveIdx}
    @click=${() => activateSection(parent, section)}
    >${section.label}</sp-menu-item
  >`;
}

// ─── Rendering ────────────────────────────────────────────────────────────────

/** Draw (or redraw) the root menu at `_x`/`_y`, clamping once the nodes exist. */
function renderRoot(): void {
  if (!_root) {
    return;
  }
  _root.update(html`<sp-popover open style="position:fixed;z-index:10000;left:${_x}px;top:${_y}px">
    <sp-menu class="settings-menu" role="menu" aria-label="Settings"
      >${_rows.map((row, index) => rowTemplate(row, index))}</sp-menu
    >
  </sp-popover>`);
  const popover = _root.host.querySelector<HTMLElement>("sp-popover");
  if (popover) {
    placePopover(popover, rootOrigin, (at) => {
      ({ x: _x, y: _y } = at);
      popover.style.left = `${_x}px`;
      popover.style.top = `${_y}px`;
    });
  }
}

/** Draw (or redraw) the open submenu. Re-applies the roving focus at a clamped index. */
function renderSub(): void {
  const parent = _rows[_subIdx];
  if (!_sub || !parent) {
    return;
  }
  const { sections } = parent;
  _subActiveIdx = Math.min(_subActiveIdx, Math.max(0, sections.length - 1));
  _sub.update(html`<sp-popover
    open
    class="settings-submenu"
    style="position:fixed;z-index:10001;left:${_sx}px;top:${_sy}px"
  >
    <sp-menu role="menu" aria-label=${`Sections of ${parent.command.title}`}
      >${sections.map((section, index) => sectionTemplate(parent, section, index))}</sp-menu
    >
  </sp-popover>`);
  const popover = _sub.host.querySelector<HTMLElement>("sp-popover");
  if (popover) {
    placePopover(
      popover,
      () => ({ x: _sx, y: _sy }),
      (at) => {
        ({ x: _sx, y: _sy } = at);
        popover.style.left = `${_sx}px`;
        popover.style.top = `${_sy}px`;
      },
    );
  }
}

// ─── Activation ───────────────────────────────────────────────────────────────

/** Run the row's own command, with no arguments, then dismiss. Disabled rows do nothing. */
function activateRow(index: number): void {
  const row = _rows[index];
  if (!row?.enabled) {
    return;
  }
  const { id } = row.command;
  dismissSettingsMenu();
  runRow(id);
}

/** Run the PARENT's command with the section this row names, then dismiss both levels. */
function activateSection(parent: MenuRow, section: MenuSection): void {
  const { id } = parent.command;
  dismissSettingsMenu();
  runRow(id, { section: section.key });
}

// ─── The submenu level ────────────────────────────────────────────────────────

/**
 * Open the submenu for root row `index`, replacing whichever one was open.
 *
 * It subscribes to the section registry for as long as it is up. Six of Project Settings' sections
 * are contributed by extensions and register a tick after the built-ins
 * (`settings/extension-sections.ts`, fired by `format/format-host.ts`'s `refreshExtensionUi` on
 * project activation and after every `project.json` write), so a submenu opened in that window
 * would otherwise be permanently short. It deliberately does NOT call the sync itself: opening a
 * menu must not do IO.
 */
function openSubmenu(index: number): void {
  if (_subIdx === index) {
    return;
  }
  const row = _rows[index];
  if (!_root || !row || row.sections.length === 0) {
    return;
  }
  closeSubmenu({ restoreFocus: false });
  _subIdx = index;
  _subActiveIdx = 0;
  /* The root repaints FIRST, before the submenu exists.
     `aria-expanded` on the parent row is a binding, so the root has to be redrawn either way — but
     doing it afterwards let `sp-menu` re-assert focus on its own focused item and take it straight
     back off the submenu we had just handed it to. The caret and the focus ring then disagreed:
     ArrowRight ran the right section on Enter while the ring stayed on the parent row. */
  renderRoot();

  const rootRect = rectOf(_root.host.querySelector<HTMLElement>("sp-popover") ?? _root.host);
  const parentRow = rootItems()[index];
  _sx = rootRect.right - 2;
  _sy = parentRow ? rectOf(parentRow).top : rootRect.top;

  _sub = renderPopover(html`${nothing}`, {
    // One handler for two popovers — see `onOutsideMousedown`.
    dismissOnOutsideClick: false,
    region: "settings-sections",
  });
  renderSub();
  /* Flip to the menu's left when the submenu would leave the viewport on the right — after layout,
     for the same reason `placePopover` runs twice: an unlaid-out popover is 0 wide and would never
     appear to overflow anything. */
  const popover = _sub.host.querySelector<HTMLElement>("sp-popover");
  requestAnimationFrame(() => {
    if (!popover?.isConnected) {
      return;
    }
    const box = rectOf(popover);
    if (_sx + box.width > window.innerWidth - 4) {
      ({ x: _sx, y: _sy } = clampIntoMenuArea(box, {
        x: rootRect.left - box.width + 2,
        y: _sy,
      }));
      popover.style.left = `${_sx}px`;
      popover.style.top = `${_sy}px`;
    }
  });

  _unsubscribe = onSettingsDocumentChanged(() => {
    const registry = activeRegistry();
    if (!registry) {
      return;
    }
    _rows = buildSettingsMenuRows(registry);
    renderRoot();
    renderSub();
  });
}

/** Close the submenu level, optionally handing focus back to the row that owns it. */
function closeSubmenu(opts: { restoreFocus: boolean }): void {
  _unsubscribe?.();
  _unsubscribe = null;
  const owner = _subIdx;
  _sub?.dismiss();
  _sub = null;
  _subIdx = -1;
  _subActiveIdx = 0;
  if (owner !== -1) {
    _focus = "root";
    renderRoot();
    if (opts.restoreFocus) {
      focusRoot(owner);
    }
  }
}

// ─── Keyboard ─────────────────────────────────────────────────────────────────

/**
 * The menu keyboard contract, acting on the deepest open level.
 *
 * Bound on `document` in the CAPTURE phase, the shape `editor/slash-menu.ts` and
 * `editor/context-menu.ts` both use, and for the two reasons the latter states: the app's own
 * Escape walks the selection ladder and the canvas nudges on arrows, so neither must also fire; and
 * a bubble-phase handler on the popover would race Spectrum's own menu key handling.
 *
 * An unhandled key returns BEFORE `preventDefault`, so nothing else is swallowed.
 */
function onMenuKeydown(e: KeyboardEvent): void {
  if (!_root) {
    return;
  }
  const inSub = _focus === "sub" && _sub !== null;
  const count = inSub ? subItems().length : _rows.length;
  const move = (index: number) => (inSub ? focusSub(index) : focusRoot(index));
  const active = inSub ? _subActiveIdx : _activeIdx;

  switch (e.key) {
    case "ArrowDown": {
      move(active + 1);
      break;
    }
    case "ArrowUp": {
      move(active - 1);
      break;
    }
    case "Home": {
      move(0);
      break;
    }
    case "End": {
      move(count - 1);
      break;
    }
    case "ArrowRight": {
      if (inSub || !(_rows[_activeIdx]?.sections.length ?? 0)) {
        return;
      }
      const owner = _activeIdx;
      openSubmenu(owner);
      _focus = "sub";
      focusSubSettled(0, owner);
      break;
    }
    case "ArrowLeft": {
      if (!inSub) {
        return;
      }
      closeSubmenu({ restoreFocus: true });
      break;
    }
    case "Enter":
    case " ": {
      if (inSub) {
        const parent = _rows[_subIdx];
        const section = parent?.sections[_subActiveIdx];
        if (parent && section) {
          activateSection(parent, section);
        }
      } else {
        activateRow(_activeIdx);
      }
      break;
    }
    case "Escape": {
      // One level at a time: the submenu first, the whole menu second.
      if (inSub) {
        closeSubmenu({ restoreFocus: true });
      } else {
        dismissSettingsMenu();
      }
      break;
    }
    case "Tab": {
      dismissSettingsMenu();
      break;
    }
    default: {
      return;
    }
  }
  e.preventDefault();
  e.stopPropagation();
}

// ─── Dismissal ────────────────────────────────────────────────────────────────

/**
 * One outside-click handler for BOTH popovers, which is why neither uses `renderPopover`'s.
 *
 * `dismissOnOutsideClick` tests `slot.contains(e.target)` for ONE slot, so with two popovers a
 * mousedown in the submenu is "outside" the root — and `dismiss()` removes the node, so the submenu
 * row's own `click` would never arrive. The opener is inside too: the gear's `@click` owns the
 * toggle, and dismissing here first would make every second click re-open.
 */
function onOutsideMousedown(e: MouseEvent): void {
  const target = e.target as Node;
  if (_root?.host.contains(target) || _sub?.host.contains(target) || _opener?.contains(target)) {
    return;
  }
  dismissSettingsMenu();
}

/** Drop the menu's global state and hand the keyboard back to whatever opened it. */
function teardown(): void {
  document.removeEventListener("keydown", onMenuKeydown, true);
  /* Disarm the PENDING arm as well as the armed listener. The arm is deferred a frame so the click
     that opened the menu cannot immediately close it, so a menu dismissed inside that frame would
     otherwise arm AFTER its own death: a document-wide capture listener on a detached slot that
     answers the next mousedown by dismissing the LIVE menu. `ui/layers.ts` documents the same
     hazard at length; this is the same fix. */
  if (_outside) {
    document.removeEventListener("mousedown", _outside, true);
    _outside = null;
  }
  _unsubscribe?.();
  _unsubscribe = null;
  const opener = _opener;
  const rerender = _rerender;
  _rows = [];
  _activeIdx = 0;
  _subIdx = -1;
  _subActiveIdx = 0;
  _focus = "root";
  _opener = null;
  _rerender = null;
  // Only when the menu still held the keyboard: an outside CLICK has already moved focus somewhere
  // The author chose, and yanking it back to the gear would fight them.
  const active = document.activeElement;
  if (opener?.isConnected && (!active || active === document.body)) {
    opener.focus();
  }
  // Last, so `aria-expanded` repaints against the cleared state.
  rerender?.();
}

// ─── Public surface ───────────────────────────────────────────────────────────

/** Whether the gear menu is on screen. The rail reads it for `aria-expanded`. */
export function isSettingsMenuOpen(): boolean {
  return _root !== null;
}

/** Dismiss the menu and any open submenu. Idempotent. */
export function dismissSettingsMenu(): void {
  if (!_root) {
    return;
  }
  _sub?.dismiss();
  _sub = null;
  const root = _root;
  _root = null;
  root.dismiss();
  teardown();
}

/**
 * Open the gear menu anchored to `anchor` — or close it, when it is already open.
 *
 * `rerender` is called on open and on dismiss so the trigger's `aria-expanded` and its open-state
 * class stay lit BINDINGS rather than imperative attribute writes; a stale `aria-expanded` is a
 * defect this app has shipped before. Same seam as `showContextMenu(e, path, { rerender })`.
 *
 * @param anchor The control the menu hangs off — the rail's gear.
 */
export function openSettingsMenu(anchor: HTMLElement, opts: { rerender?: () => void } = {}): void {
  if (_root) {
    dismissSettingsMenu();
    return;
  }
  const registry = activeRegistry();
  if (!registry) {
    return;
  }
  const rows = buildSettingsMenuRows(registry);
  if (rows.length === 0) {
    return;
  }
  _rows = rows;
  _activeIdx = 0;
  _subIdx = -1;
  _focus = "root";
  _opener = anchor;
  _rerender = opts.rerender ?? null;

  // A seed only: `rootOrigin` recomputes both axes from the measured box on every placement pass.
  const rect = rectOf(anchor);
  _x = rect.right + 4;
  _y = rect.top;

  _root = renderPopover(html`${nothing}`, {
    dismissOnOutsideClick: false,
    region: "settings",
  });
  renderRoot();

  document.addEventListener("keydown", onMenuKeydown, true);
  _outside = onOutsideMousedown;
  requestAnimationFrame(() => {
    if (_outside) {
      document.addEventListener("mousedown", _outside, true);
    }
  });
  /* A frame later: lit has committed the items, and focusing the first row is what makes the whole
     keyboard contract reachable at all. Guarded, because it is a DEFERRED write of an INITIAL
     value — an arrow pressed inside that frame has already moved the caret, and re-applying row 0
     on top of it would undo the first keystroke after opening. */
  requestAnimationFrame(() => {
    if (_root && _focus === "root" && _subIdx === -1 && _activeIdx === 0) {
      focusRoot(0);
    }
  });
  _rerender?.();
}
