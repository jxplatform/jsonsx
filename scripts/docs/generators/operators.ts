// Generates docs/framework/reference/operators.md from packages/schema/schema.json.
// The operator ENUMERATIONS are read live from the schema $defs (the blessed sets
// Cannot drift); the per-group prose is curated here so the page reads as
// Documentation rather than a raw dump.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BANNER, frontmatter } from "./shared.ts";

const ROOT = resolve(import.meta.dir, "../../..");

interface OperatorDef {
  enum?: string[];
  const?: string;
  description?: string;
}

interface OperatorGroup {
  heading: string;
  defs: string[];
  prose: string;
}

/** Curated group prose; the operator lists themselves come from schema.json. */
const GROUPS: OperatorGroup[] = [
  {
    defs: ["UnaryOperator"],
    heading: "Unary operators",
    prose: "Applied to a single `target` operand.",
  },
  {
    defs: ["BinaryOperator"],
    heading: "Binary operators",
    prose:
      "Applied to a `target` and a `value` operand. Arithmetic, comparison, logical, and nullish-coalescing forms — the blessed subset of JavaScript's operator set (spec §19.4).",
  },
  {
    defs: ["AssignmentOperator"],
    heading: "Assignment operators",
    prose:
      "Statement-position only: assign (or read-modify-write) a state path. Not valid inside pure expressions.",
  },
  {
    defs: ["ConditionalOperator", "SwitchOperator", "CallOperator"],
    heading: "Conditional, switch, and call",
    prose:
      "`?:` selects between `value` and `else` on a `target` condition; `switch` matches a `target` against `cases`; `call` invokes a named formula (spec §19.4c) with `args`.",
  },
  {
    defs: ["PureMethod"],
    heading: "Pure standard-library methods",
    prose:
      "Genuine pure `String`/`Array`/`Number` prototype methods, usable inside pure expressions (spec §19.4d). The change-by-copy family (`toSorted`, `toReversed`, `toSpliced`, `with`) replaces their mutating counterparts.",
  },
  {
    defs: ["NoArgMethod", "OneArgMethod", "SpliceMethod"],
    heading: "Mutation methods",
    prose:
      "Statement-position array mutations. `pop`/`shift` take no argument; `push`/`unshift` take one; `splice` takes `start`, `deleteCount`, and `items`.",
  },
  {
    defs: ["ReduceMethod", "MapFilterMethod"],
    heading: "Iteration methods",
    prose:
      "`map`/`filter` evaluate their `value` expression per item with `$map/item` and `$map/index` in scope; `reduce` additionally exposes `$reduce/acc` and takes an `initial` value.",
  },
];

/** Read the operator tokens a $def admits (enum members or a single const). */
function tokensOf(def: OperatorDef): string[] {
  if (def.enum) {
    return def.enum;
  }
  if (def.const) {
    return [def.const];
  }
  return [];
}

/** Render the operator reference page. */
export function generateOperators(): string {
  const schema = JSON.parse(readFileSync(join(ROOT, "packages/schema/schema.json"), "utf8")) as {
    $defs: Record<string, OperatorDef>;
  };

  const lines: string[] = [
    frontmatter({
      description:
        "The blessed operator set for declarative $expression trees — every operator and method token the schema admits.",
      title: "Operator reference",
    }),
    BANNER,
    "",
    "# Operator reference",
    "",
    "Declarative expressions (`$expression`) admit a closed set of operators, enforced by the Jx schema. This page enumerates that set straight from `packages/schema/schema.json`. The expression model itself is documented in the [Framework concepts](/docs/framework/) section; named-formula composition is cataloged in the [formula catalog](/docs/framework/reference/formulas/).",
    "",
  ];

  for (const group of GROUPS) {
    const tokens = group.defs.flatMap((name) => {
      const def = schema.$defs[name];
      if (!def) {
        throw new Error(`schema.json $defs is missing "${name}" — update the operators generator`);
      }
      return tokensOf(def);
    });
    lines.push(
      `## ${group.heading}`,
      "",
      group.prose,
      "",
      tokens.map((t) => `\`${t}\``).join(" · "),
      "",
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
