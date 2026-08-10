/**
 * A tag name chosen at element creation, from a set the schema can enumerate.
 *
 * The motivating case is one element that must be an `<a>` when a prop is set and a `<div>` when it
 * is not, wrapping an identical subtree either way. Before this def there were two answers and both
 * were bad: write `"${state.href ? 'a' : 'div'}"`, which nothing in the pipeline evaluates and each
 * consumer then broke differently and silently (see {@link tagNameSchema}); or reach for a
 * `$switch` CHILD, whose cases render in place of the container's content — so varying the wrapper
 * means duplicating the whole subtree once per case, and still leaves the container `<div>` wrapped
 * around the result.
 *
 * **The results are `TagName`s, not operands.** That is the property everything else here depends
 * on. The discriminant in `target` may be any expression, but every branch's RESULT is a literal
 * tag held to the same pattern a written-out tag is held to — so the candidate set is readable
 * straight out of the JSON without evaluating anything. The compiler can emit one template per
 * candidate, `jx validate` can refuse `"A LINK"` at authoring time, and the void-element,
 * preformatted, `img` and slot analyses that read a tag structurally keep a finite set to reason
 * about. A `${…}` template in this position would have surrendered all of that.
 *
 * **Vocabulary, not new keywords.** `$expression`, `?:` (test in `target`, consequent in `value`,
 * alternate in `initial`) and `switch` (discriminant in `target`, results in `cases`/`default`) all
 * already mean exactly this — see `expression-node.schema.ts` and spec §19.4b. The alternative
 * considered was `$switch`/`cases` inside the tagName block, which would have been a THIRD switch
 * syntax in a language that has two, and would have made `cases` a homograph inside one element
 * object: tag strings in `tagName`, child subtrees three lines below.
 *
 * **`default`/`initial` are REQUIRED here.** The expression-level `switch` leaves `default`
 * optional and yields `undefined` when nothing matches; an element with no tag is not a thing that
 * can exist, so the fallback is mandatory rather than a shape the runtime has to invent a rule
 * for.
 *
 * **Evaluated ONCE, when the element is created, and never re-read.** This is the one place a
 * `$expression` is not live, and it is deliberate: a tag that changed after mount would mean
 * replacing the node, which costs the subtree's listeners, its focus, its typed input values and
 * its component instances — and the runtime has no dispose walk to pay that bill with. `jx
 * validate` warns when a tag discriminant is also an assignment target anywhere in the document, so
 * the one case where the rule bites is caught at authoring time rather than discovered as a `<div>`
 * that never became an `<a>`.
 */
export const tagExpressionSchema = {
  anyOf: [
    {
      additionalProperties: false,
      description:
        "Two-way: `target` is the test, `value` the tag when it is truthy, `initial` the tag when it is not.",
      properties: {
        initial: { $ref: "#/$defs/TagName" },
        operator: { const: "?:", type: "string" },
        target: { $ref: "#/$defs/ExpressionOperand" },
        value: { $ref: "#/$defs/TagName" },
      },
      required: ["operator", "target", "value", "initial"],
      title: "?: — the tag when the test holds, and the tag when it does not",
    },
    {
      additionalProperties: false,
      description:
        "Multiway: `target` is the discriminant, matched against case keys by its string form. " +
        "`default` is required — an element with no tag cannot exist.",
      properties: {
        cases: {
          additionalProperties: { $ref: "#/$defs/TagName" },
          type: "object",
        },
        default: { $ref: "#/$defs/TagName" },
        operator: { const: "switch", type: "string" },
        target: { $ref: "#/$defs/ExpressionOperand" },
      },
      required: ["operator", "target", "cases", "default"],
      title: "switch — one tag per discriminant value, with a required fallback",
    },
  ],
  description:
    "A tag name chosen at element creation. Every branch resolves to a `TagName`, so the candidate " +
    "set is enumerable without evaluating anything.",
} as const;

/**
 * What an ELEMENT's `tagName` may be: a name, or a {@link tagExpressionSchema} choosing between
 * names.
 *
 * Wired into `ElementDef.tagName` alone. The document ROOT and `SwitchNode`'s container keep the
 * bare `TagName`, so `customElements.define`, the compiler's module emit and the output filenames
 * derived from the root tag all keep receiving a string — a guarantee that lives in the type rather
 * than in a positional branch someone can forget. `HeadEntry` declares its own `tagName` and never
 * referenced the shared def, so a head tag is static for free.
 */
export const elementTagNameSchema = {
  anyOf: [
    { $ref: "#/$defs/TagName" },
    {
      additionalProperties: false,
      properties: { $expression: { $ref: "#/$defs/TagExpression" } },
      required: ["$expression"],
      type: "object",
    },
  ],
} as const;
