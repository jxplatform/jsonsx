export interface BuildEntry {
  entrypoints: string[];
  outdir: string;
  match?: Function | RegExp;
  label?: string;
}

export interface ClassJsonParam {
  $ref?: string;
  identifier?: string;
  name?: string;
}

export interface ClassJsonField {
  role?: string;
  access?: string;
  scope?: string;
  identifier?: string;
  initializer?: unknown;
  default?: unknown;
  type?: Record<string, unknown>;
  description?: string;
  examples?: unknown[];
}

export interface ClassJsonMethod {
  identifier?: string;
  role?: string;
  scope?: string;
  body?: string | string[];
  getter?: { body: string };
  setter?: { parameters?: ClassJsonParam[]; body: string };
  parameters?: ClassJsonParam[];
}

export interface ClassJsonParameterDef {
  identifier?: string;
  type?: Record<string, unknown>;
  format?: string;
  description?: string;
  examples?: unknown[];
}

export interface ClassJsonDef {
  title?: string;
  description?: string;
  $implementation?: string;
  extends?: { $ref?: string };
  $defs?: {
    fields?: Record<string, ClassJsonField>;
    constructor?: {
      role?: string;
      $prototype?: string;
      body?: string | string[];
      parameters?: ClassJsonParam[];
    };
    methods?: Record<string, ClassJsonMethod>;
    parameters?: Record<string, ClassJsonParameterDef>;
  };
}
