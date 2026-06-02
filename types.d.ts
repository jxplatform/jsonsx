declare module "three";
declare module "@webref/elements" {
  interface WebrefElement {
    name: string;
    obsolete?: boolean;
    [key: string]: unknown;
  }
  interface WebrefElementsSpec {
    elements: WebrefElement[];
    [key: string]: unknown;
  }
  export function listAll(options?: {
    folder?: string;
  }): Promise<Record<string, WebrefElementsSpec>>;
}

declare module "@webref/css" {
  interface CssProperty {
    name: string;
    styleDeclaration?: string[];
    [key: string]: unknown;
  }
  interface CssData {
    properties: CssProperty[];
    [key: string]: unknown;
  }
  const css: {
    listAll(): Promise<CssData>;
  };
  export default css;
}

declare module "@webref/idl" {
  interface IdlType {
    idlType?: string | IdlType | IdlType[];
    [key: string]: unknown;
  }
  interface IdlMember {
    type: string;
    name?: string;
    idlType?: IdlType;
    [key: string]: unknown;
  }
  interface IdlDefinition {
    type: string;
    name?: string;
    members?: IdlMember[];
    [key: string]: unknown;
  }
  const idl: {
    parseAll(options?: { folder?: string }): Promise<Record<string, IdlDefinition[]>>;
    listAll(options?: { folder?: string }): Promise<Record<string, unknown>>;
  };
  export default idl;
}
declare module "glob";
declare module "unified";
declare module "remark-parse";
declare module "remark-frontmatter";
declare module "remark-parse-frontmatter";
declare module "remark-rehype";
declare module "rehype-stringify";
declare module "quikchat/md";
