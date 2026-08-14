export const tagNameSchema = {
  description:
    "HTML element tag name or custom element name (must contain a hyphen per Web Components spec). " +
    "A NAME, never an expression: no `${…}` position in the pipeline evaluates a tagName. Use " +
    "`$switch`/`cases` to vary the element.",
  minLength: 1,
  /* THE PATTERN IS THE WHOLE POINT. Without it `"\${state.href ? 'a' : 'div'}"` validates, and every
     consumer downstream then does something different and silent with it: the runtime hands it to
     `document.createElement` and throws `InvalidCharacterError`; the compiler splices it into a lit
     template as a binding in tag position, which lit cannot do; and the static renderer emits it into
     the prerendered HTML and re-resolves that string against the PAGE scope, where the component's
     own `state` is undefined — so a built site silently collapses to the fallback branch's tag with
     the other branch's attributes. Found by driving Studio against a real site whose component did
     exactly this. Every tagName in packages/, extensions/, sites/, examples/ and docs/ already
     conforms, so the pattern only rejects what was already broken. */
  pattern: "^[a-zA-Z][a-zA-Z0-9._-]*$",
  type: "string",
} as const;
