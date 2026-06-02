import type { ProjectConfig } from "@jxsuite/schema/types";

export interface CanvasPanel {
  mediaName: string;
  element: HTMLElement;
  canvas: HTMLElement;
  overlay: HTMLElement;
  overlayClk: HTMLElement;
  viewport: HTMLElement;
  scrollContainer: HTMLElement;
  dropLine: HTMLElement;
  _width: number | null;
}

export interface DocumentStackEntry {
  document: JxMutableNode;
  documentPath: string | null;
  selection: JxPath | null;
  dirty?: boolean;
  mode?: string;
  sourceFormat?: string | null;
}

export interface FunctionEditDef {
  type: string;
  defName?: string;
  path?: JxPath;
  eventKey?: string;
  key?: string;
  body?: string;
  parameters?: string[];
}

export interface GitDiffState {
  filePath: string;
  originalContent: string;
  currentContent: string;
  isMarkdown: boolean;
  fileStatus: string;
  originalDoc?: unknown;
  currentDoc?: unknown;
  original?: unknown;
}

export interface InlineEditDef {
  path: JxPath;
  mediaName?: string;
}

export interface ProjectState {
  root?: string;
  name: string;
  projectRoot: string;
  isSiteProject: boolean;
  projectConfig: ProjectConfig | null;
  dirs: Map<string, DirEntry[]>;
  expanded: Set<string>;
  selectedPath: string | null;
  searchQuery: string;
  projectDirs?: string[];
  [key: string]: unknown;
}

export type JsonValue = string | number | boolean | object | null | undefined;
