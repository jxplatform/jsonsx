/**
 * Spectrum.js — Explicit Spectrum Web Component registration
 *
 * Bun's bundler tree-shakes bare side-effect imports (`import "..."`) because the Spectrum
 * `sp-*.js` entry files export nothing — they only call `customElements.define()` as a side effect.
 * To prevent the bundler from dropping them, we import the class constructors and collect them into
 * an exported array that the main module references.
 */

import { Theme } from "@spectrum-web-components/theme/src/Theme.js";
import themeSpectrumCSS from "@spectrum-web-components/theme/src/theme.css.js";
import themeDarkCSS from "@spectrum-web-components/theme/src/theme-dark.css.js";
import scaleMediumCSS from "@spectrum-web-components/theme/src/scale-medium.css.js";
import { Tabs } from "@spectrum-web-components/tabs/src/Tabs.js";
import { Tab } from "@spectrum-web-components/tabs/src/Tab.js";
import { TabPanel } from "@spectrum-web-components/tabs/src/TabPanel.js";
import { ActionButton } from "@spectrum-web-components/action-button/src/ActionButton.js";
import { ActionGroup } from "@spectrum-web-components/action-group/src/ActionGroup.js";
import { Search } from "@spectrum-web-components/search/src/Search.js";
import { Popover } from "@spectrum-web-components/popover/src/Popover.js";
import { Menu } from "@spectrum-web-components/menu/src/Menu.js";
import { MenuItem } from "@spectrum-web-components/menu/src/MenuItem.js";
import { MenuDivider } from "@spectrum-web-components/menu/src/MenuDivider.js";
import { MenuGroup } from "@spectrum-web-components/menu/src/MenuGroup.js";
import { Textfield } from "@spectrum-web-components/textfield/src/Textfield.js";
import { Swatch } from "@spectrum-web-components/swatch/src/Swatch.js";
import { SwatchGroup } from "@spectrum-web-components/swatch/src/SwatchGroup.js";
import { ColorArea } from "@spectrum-web-components/color-area/src/ColorArea.js";
import { ColorSlider } from "@spectrum-web-components/color-slider/src/ColorSlider.js";
import { ColorHandle } from "@spectrum-web-components/color-handle/src/ColorHandle.js";
import { NumberField } from "@spectrum-web-components/number-field/src/NumberField.js";
import { Picker } from "@spectrum-web-components/picker/src/Picker.js";
import { Combobox } from "@spectrum-web-components/combobox/src/Combobox.js";
import { FieldLabel } from "@spectrum-web-components/field-label/src/FieldLabel.js";
import { Checkbox } from "@spectrum-web-components/checkbox/src/Checkbox.js";
import { Switch as SpSwitch } from "@spectrum-web-components/switch/src/Switch.js";
import { Divider } from "@spectrum-web-components/divider/src/Divider.js";
import { Tooltip } from "@spectrum-web-components/tooltip/src/Tooltip.js";
import { Overlay } from "@spectrum-web-components/overlay/src/Overlay.js";
import { OverlayTrigger } from "@spectrum-web-components/overlay/src/OverlayTrigger.js";
import { Dialog } from "@spectrum-web-components/dialog/src/Dialog.js";
import { DialogWrapper } from "@spectrum-web-components/dialog/src/DialogWrapper.js";
import { HelpText } from "@spectrum-web-components/help-text/src/HelpText.js";
import { Button } from "@spectrum-web-components/button/src/Button.js";
import { Underlay } from "@spectrum-web-components/underlay/src/Underlay.js";
import { PickerButton } from "@spectrum-web-components/picker-button/src/PickerButton.js";
import { Accordion } from "@spectrum-web-components/accordion/src/Accordion.js";
import { AccordionItem } from "@spectrum-web-components/accordion/src/AccordionItem.js";
import { ActionBar } from "@spectrum-web-components/action-bar/src/ActionBar.js";
import { Toast } from "@spectrum-web-components/toast/src/Toast.js";
import { Table } from "@spectrum-web-components/table/src/Table.js";
import { TableHead } from "@spectrum-web-components/table/src/TableHead.js";
import { TableHeadCell } from "@spectrum-web-components/table/src/TableHeadCell.js";
import { TableBody } from "@spectrum-web-components/table/src/TableBody.js";
import { TableRow } from "@spectrum-web-components/table/src/TableRow.js";
import { TableCell } from "@spectrum-web-components/table/src/TableCell.js";

// Icons
import { IconFolder } from "@spectrum-web-components/icons-workflow/src/elements/IconFolder.js";
import { IconFolderOpen } from "@spectrum-web-components/icons-workflow/src/elements/IconFolderOpen.js";
import { IconDocument } from "@spectrum-web-components/icons-workflow/src/elements/IconDocument.js";
import { IconFileCode } from "@spectrum-web-components/icons-workflow/src/elements/IconFileCode.js";
import { IconFileTxt } from "@spectrum-web-components/icons-workflow/src/elements/IconFileTxt.js";
import { IconImage } from "@spectrum-web-components/icons-workflow/src/elements/IconImage.js";
import { IconFileSingleWebPage } from "@spectrum-web-components/icons-workflow/src/elements/IconFileSingleWebPage.js";
import { IconViewAllTags } from "@spectrum-web-components/icons-workflow/src/elements/IconViewAllTags.js";
import { IconRefresh } from "@spectrum-web-components/icons-workflow/src/elements/IconRefresh.js";
import { IconAdd } from "@spectrum-web-components/icons-workflow/src/elements/IconAdd.js";
import { IconUpload } from "@spectrum-web-components/icons-workflow/src/elements/IconUpload.js";
import { IconLayers } from "@spectrum-web-components/icons-workflow/src/elements/IconLayers.js";
import { IconViewGrid } from "@spectrum-web-components/icons-workflow/src/elements/IconViewGrid.js";
import { IconBrackets } from "@spectrum-web-components/icons-workflow/src/elements/IconBrackets.js";
import { IconData } from "@spectrum-web-components/icons-workflow/src/elements/IconData.js";
import { IconChevronDown } from "@spectrum-web-components/icons-workflow/src/elements/IconChevronDown.js";
import { IconDelete } from "@spectrum-web-components/icons-workflow/src/elements/IconDelete.js";
import { IconClose } from "@spectrum-web-components/icons-workflow/src/elements/IconClose.js";
import { IconChevronRight } from "@spectrum-web-components/icons-workflow/src/elements/IconChevronRight.js";
import { IconEdit } from "@spectrum-web-components/icons-workflow/src/elements/IconEdit.js";
import { IconSaveFloppy } from "@spectrum-web-components/icons-workflow/src/elements/IconSaveFloppy.js";
import { IconUndo } from "@spectrum-web-components/icons-workflow/src/elements/IconUndo.js";
import { IconRedo } from "@spectrum-web-components/icons-workflow/src/elements/IconRedo.js";
import { IconDuplicate } from "@spectrum-web-components/icons-workflow/src/elements/IconDuplicate.js";
import { IconCopy } from "@spectrum-web-components/icons-workflow/src/elements/IconCopy.js";
import { IconExport } from "@spectrum-web-components/icons-workflow/src/elements/IconExport.js";
import { IconPreview } from "@spectrum-web-components/icons-workflow/src/elements/IconPreview.js";
import { IconCode } from "@spectrum-web-components/icons-workflow/src/elements/IconCode.js";
import { IconBrush } from "@spectrum-web-components/icons-workflow/src/elements/IconBrush.js";
import { IconGears } from "@spectrum-web-components/icons-workflow/src/elements/IconGears.js";
import { IconSettings } from "@spectrum-web-components/icons-workflow/src/elements/IconSettings.js";
import { IconBack } from "@spectrum-web-components/icons-workflow/src/elements/IconBack.js";
import { IconProperties } from "@spectrum-web-components/icons-workflow/src/elements/IconProperties.js";
import { IconEvent } from "@spectrum-web-components/icons-workflow/src/elements/IconEvent.js";
import { IconMore } from "@spectrum-web-components/icons-workflow/src/elements/IconMore.js";

// Layout / alignment icons
import { IconArrowRight } from "@spectrum-web-components/icons-workflow/src/elements/IconArrowRight.js";
import { IconArrowLeft } from "@spectrum-web-components/icons-workflow/src/elements/IconArrowLeft.js";
import { IconArrowDown } from "@spectrum-web-components/icons-workflow/src/elements/IconArrowDown.js";
import { IconArrowUp } from "@spectrum-web-components/icons-workflow/src/elements/IconArrowUp.js";
import { IconTextAlignLeft } from "@spectrum-web-components/icons-workflow/src/elements/IconTextAlignLeft.js";
import { IconTextAlignCenter } from "@spectrum-web-components/icons-workflow/src/elements/IconTextAlignCenter.js";
import { IconTextAlignRight } from "@spectrum-web-components/icons-workflow/src/elements/IconTextAlignRight.js";
import { IconTextAlignJustify } from "@spectrum-web-components/icons-workflow/src/elements/IconTextAlignJustify.js";
import { IconAlignTop } from "@spectrum-web-components/icons-workflow/src/elements/IconAlignTop.js";
import { IconAlignBottom } from "@spectrum-web-components/icons-workflow/src/elements/IconAlignBottom.js";
import { IconAlignMiddle } from "@spectrum-web-components/icons-workflow/src/elements/IconAlignMiddle.js";
import { IconAlignLeft } from "@spectrum-web-components/icons-workflow/src/elements/IconAlignLeft.js";
import { IconAlignRight } from "@spectrum-web-components/icons-workflow/src/elements/IconAlignRight.js";
import { IconAlignCenter } from "@spectrum-web-components/icons-workflow/src/elements/IconAlignCenter.js";
import { IconDistributeSpaceHoriz } from "@spectrum-web-components/icons-workflow/src/elements/IconDistributeSpaceHoriz.js";
import { IconDistributeSpaceVert } from "@spectrum-web-components/icons-workflow/src/elements/IconDistributeSpaceVert.js";
import { IconDistributeHorizontally } from "@spectrum-web-components/icons-workflow/src/elements/IconDistributeHorizontally.js";
import { IconDistributeVertically } from "@spectrum-web-components/icons-workflow/src/elements/IconDistributeVertically.js";
import { IconDistributeBottomEdge } from "@spectrum-web-components/icons-workflow/src/elements/IconDistributeBottomEdge.js";
import { IconDistributeTopEdge } from "@spectrum-web-components/icons-workflow/src/elements/IconDistributeTopEdge.js";
import { IconDistributeHorizontalCenter } from "@spectrum-web-components/icons-workflow/src/elements/IconDistributeHorizontalCenter.js";
import { IconTextBaselineShift } from "@spectrum-web-components/icons-workflow/src/elements/IconTextBaselineShift.js";
import { IconFlipVertical } from "@spectrum-web-components/icons-workflow/src/elements/IconFlipVertical.js";
import { IconRemove } from "@spectrum-web-components/icons-workflow/src/elements/IconRemove.js";
import { IconFullScreen } from "@spectrum-web-components/icons-workflow/src/elements/IconFullScreen.js";
import { IconViewColumn } from "@spectrum-web-components/icons-workflow/src/elements/IconViewColumn.js";
import { IconBox } from "@spectrum-web-components/icons-workflow/src/elements/IconBox.js";
import { IconVisibility } from "@spectrum-web-components/icons-workflow/src/elements/IconVisibility.js";
import { IconVisibilityOff } from "@spectrum-web-components/icons-workflow/src/elements/IconVisibilityOff.js";
import { IconArtboard } from "@spectrum-web-components/icons-workflow/src/elements/IconArtboard.js";
import { IconChat } from "@spectrum-web-components/icons-workflow/src/elements/IconChat.js";
import { IconViewList } from "@spectrum-web-components/icons-workflow/src/elements/IconViewList.js";
import { IconRailRightClose } from "@spectrum-web-components/icons-workflow/src/elements/IconRailRightClose.js";
import { IconRailRightOpen } from "@spectrum-web-components/icons-workflow/src/elements/IconRailRightOpen.js";
import { IconRectangle } from "@spectrum-web-components/icons-workflow/src/elements/IconRectangle.js";

// Inline formatting icons
import { IconTextBold } from "@spectrum-web-components/icons-workflow/src/elements/IconTextBold.js";
import { IconTextItalic } from "@spectrum-web-components/icons-workflow/src/elements/IconTextItalic.js";
import { IconTextUnderline } from "@spectrum-web-components/icons-workflow/src/elements/IconTextUnderline.js";
import { IconTextStrikethrough } from "@spectrum-web-components/icons-workflow/src/elements/IconTextStrikethrough.js";
import { IconTextSuperscript } from "@spectrum-web-components/icons-workflow/src/elements/IconTextSuperscript.js";
import { IconTextSubscript } from "@spectrum-web-components/icons-workflow/src/elements/IconTextSubscript.js";
import { IconLink } from "@spectrum-web-components/icons-workflow/src/elements/IconLink.js";
import { IconDownload } from "@spectrum-web-components/icons-workflow/src/elements/IconDownload.js";
import { IconCheckmark } from "@spectrum-web-components/icons-workflow/src/elements/IconCheckmark.js";

// Custom studio components
import { JxValueSelector } from "./value-selector";
import { JxColorPopover } from "./color-selector";

// UI icons (used internally by Spectrum components like accordion, picker, combobox)
import { IconChevron100 } from "@spectrum-web-components/icons-ui/src/elements/IconChevron100.js";

// Register all components. Using defineElement from Spectrum's base package
// ensures duplicate registration is handled gracefully.
import { defineElement } from "@spectrum-web-components/base/src/define-element.js";

const components = [
  ["sp-theme", Theme],
  ["sp-tabs", Tabs],
  ["sp-tab", Tab],
  ["sp-tab-panel", TabPanel],
  ["sp-action-button", ActionButton],
  ["sp-action-group", ActionGroup],
  ["sp-search", Search],
  ["sp-popover", Popover],
  ["sp-menu", Menu],
  ["sp-menu-item", MenuItem],
  ["sp-menu-divider", MenuDivider],
  ["sp-menu-group", MenuGroup],
  ["sp-textfield", Textfield],
  ["sp-swatch", Swatch],
  ["sp-swatch-group", SwatchGroup],
  ["sp-color-area", ColorArea],
  ["sp-color-slider", ColorSlider],
  ["sp-color-handle", ColorHandle],
  ["sp-number-field", NumberField],
  ["sp-picker", Picker],
  ["sp-combobox", Combobox],
  ["sp-field-label", FieldLabel],
  ["sp-checkbox", Checkbox],
  ["sp-switch", SpSwitch],
  ["sp-divider", Divider],
  ["sp-tooltip", Tooltip],
  ["sp-overlay", Overlay],
  ["overlay-trigger", OverlayTrigger],
  ["sp-dialog", Dialog],
  ["sp-dialog-wrapper", DialogWrapper],
  ["sp-help-text", HelpText],
  ["sp-button", Button],
  ["sp-underlay", Underlay],
  ["sp-picker-button", PickerButton],
  ["sp-accordion", Accordion],
  ["sp-accordion-item", AccordionItem],
  ["sp-action-bar", ActionBar],
  ["sp-toast", Toast],
  ["sp-table", Table],
  ["sp-table-head", TableHead],
  ["sp-table-head-cell", TableHeadCell],
  ["sp-table-body", TableBody],
  ["sp-table-row", TableRow],
  ["sp-table-cell", TableCell],
  ["sp-icon-folder", IconFolder],
  ["sp-icon-folder-open", IconFolderOpen],
  ["sp-icon-document", IconDocument],
  ["sp-icon-file-code", IconFileCode],
  ["sp-icon-file-txt", IconFileTxt],
  ["sp-icon-image", IconImage],
  ["sp-icon-file-single-web-page", IconFileSingleWebPage],
  ["sp-icon-view-all-tags", IconViewAllTags],
  ["sp-icon-refresh", IconRefresh],
  ["sp-icon-add", IconAdd],
  ["sp-icon-upload", IconUpload],
  ["sp-icon-layers", IconLayers],
  ["sp-icon-view-grid", IconViewGrid],
  ["sp-icon-brackets", IconBrackets],
  ["sp-icon-data", IconData],
  ["sp-icon-chevron-down", IconChevronDown],
  ["sp-icon-chevron-right", IconChevronRight],
  ["sp-icon-delete", IconDelete],
  ["sp-icon-close", IconClose],
  ["sp-icon-edit", IconEdit],
  ["sp-icon-save-floppy", IconSaveFloppy],
  ["sp-icon-undo", IconUndo],
  ["sp-icon-redo", IconRedo],
  ["sp-icon-duplicate", IconDuplicate],
  ["sp-icon-copy", IconCopy],
  ["sp-icon-export", IconExport],
  ["sp-icon-preview", IconPreview],
  ["sp-icon-code", IconCode],
  ["sp-icon-brush", IconBrush],
  ["sp-icon-gears", IconGears],
  ["sp-icon-settings", IconSettings],
  ["sp-icon-back", IconBack],
  ["sp-icon-properties", IconProperties],
  ["sp-icon-event", IconEvent],
  ["sp-icon-more", IconMore],
  ["sp-icon-arrow-right", IconArrowRight],
  ["sp-icon-arrow-left", IconArrowLeft],
  ["sp-icon-arrow-down", IconArrowDown],
  ["sp-icon-arrow-up", IconArrowUp],
  ["sp-icon-text-align-left", IconTextAlignLeft],
  ["sp-icon-text-align-center", IconTextAlignCenter],
  ["sp-icon-text-align-right", IconTextAlignRight],
  ["sp-icon-text-align-justify", IconTextAlignJustify],
  ["sp-icon-align-top", IconAlignTop],
  ["sp-icon-align-bottom", IconAlignBottom],
  ["sp-icon-align-middle", IconAlignMiddle],
  ["sp-icon-align-left", IconAlignLeft],
  ["sp-icon-align-right", IconAlignRight],
  ["sp-icon-align-center", IconAlignCenter],
  ["sp-icon-distribute-space-horiz", IconDistributeSpaceHoriz],
  ["sp-icon-distribute-space-vert", IconDistributeSpaceVert],
  ["sp-icon-distribute-horizontally", IconDistributeHorizontally],
  ["sp-icon-distribute-vertically", IconDistributeVertically],
  ["sp-icon-distribute-bottom-edge", IconDistributeBottomEdge],
  ["sp-icon-distribute-top-edge", IconDistributeTopEdge],
  ["sp-icon-distribute-horizontal-center", IconDistributeHorizontalCenter],
  ["sp-icon-text-baseline-shift", IconTextBaselineShift],
  ["sp-icon-flip-vertical", IconFlipVertical],
  ["sp-icon-remove", IconRemove],
  ["sp-icon-full-screen", IconFullScreen],
  ["sp-icon-download", IconDownload],
  ["sp-icon-checkmark", IconCheckmark],
  ["sp-icon-view-column", IconViewColumn],
  ["sp-icon-rail-right-close", IconRailRightClose],
  ["sp-icon-rail-right-open", IconRailRightOpen],
  ["sp-icon-rectangle", IconRectangle],
  ["sp-icon-box", IconBox],
  ["sp-icon-visibility", IconVisibility],
  ["sp-icon-visibility-off", IconVisibilityOff],
  ["sp-icon-artboard", IconArtboard],
  ["sp-icon-chat", IconChat],
  ["sp-icon-view-list", IconViewList],
  ["sp-icon-text-bold", IconTextBold],
  ["sp-icon-text-italic", IconTextItalic],
  ["sp-icon-text-underline", IconTextUnderline],
  ["sp-icon-text-strikethrough", IconTextStrikethrough],
  ["sp-icon-text-superscript", IconTextSuperscript],
  ["sp-icon-text-subscript", IconTextSubscript],
  ["sp-icon-link", IconLink],
  // UI icons (internal component chrome)
  ["sp-icon-chevron100", IconChevron100],
  // Custom studio components
  ["jx-value-selector", JxValueSelector],
  ["jx-color-popover", JxColorPopover],
];

for (const [tag, ctor] of components as [string, CustomElementConstructor][]) {
  if (!customElements.get(tag)) defineElement(tag, ctor);
}

// Register theme fragments (these are also side-effect-only in the original modules)
Theme.registerThemeFragment("spectrum", "system", themeSpectrumCSS);
Theme.registerThemeFragment("dark", "color", themeDarkCSS);
Theme.registerThemeFragment("medium", "scale", scaleMediumCSS);

export { components };
