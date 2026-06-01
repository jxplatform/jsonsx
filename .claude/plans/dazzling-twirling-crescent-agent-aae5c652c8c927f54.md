# Implementation Plan: `$expression` (Declarative Expressions) for Jx

## Summary

Add Shape 5 (`$expression`) support across the entire Jx stack: runtime interpreter, all compiler targets, JSON Schema, spec updates, examples, and tests. The feature allows declarative state mutations and computations via an operator/target/value tree structure that compiles to the same output as equivalent `body` strings.

---

## Phase 1: Core Expression Evaluator (Shared Module)

### 1.1 Create `packages/runtime/src/expression.js`

A new module exporting two functions used by both the runtime and (potentially) the compiler:

```
evaluateExpression(node, state, event)  → void (mutating) or value (pure)
compileExpressionToJS(node)             → string (JS source code)
```

**Key design decisions:**

- A single recursive function that pattern-matches on `node.operator`
- Operand resolution: `resolveOperand(operand, state, event, acc)` handles `$ref` Pointers, Literals, and nested ExpressionNodes
- Operator classification via two Sets: `MUTATING_OPS` and `PURE_OPS`

**Function: `resolveOperand(operand, state, event, acc)`**

- If operand is a plain scalar (string/number/boolean/null) → return as-is
- If operand is an array → map each element through resolveOperand
- If operand has `$ref` → resolve via extended `resolveRef` (see 1.2)
- If operand has `operator` → recurse into `evaluateExpression`

**Function: `evaluateExpression(node, state, event, acc)`**

- Switch on `node.operator`:
  - Unary (`!`, `-`): return `!resolveOperand(node.target, ...)` or negation
  - Binary (`+`, `-`, `*`, `/`, `%`, comparisons, logical): resolve both target and value, apply operator
  - Assignment (`=`, `+=`, `-=`, `*=`, `/=`): resolve target pointer to writable path, resolve value, perform assignment on state proxy
  - Array methods (`push`, `pop`, `shift`, `unshift`, `splice`): resolve target to array, call method
  - Aggregates (`reduce`, `map`, `filter`): resolve target to array, iterate with per-item context

**Function: `compileExpressionToJS(node, opts)` → string**

- Produces JS source string (used by compiler targets)
- Same recursive structure but emits source code instead of executing
- `opts.stateVar` controls variable name (`state` vs `s` vs `this.state`)
- Operand compilation: `$ref` → `state.path` or `event.path` or `acc`, literal → JSON.stringify, nested → recursive compile

### 1.2 Extend `resolveRef` in runtime for new schemes

**File:** `/home/batonac/Development/jx/packages/runtime/src/runtime.js` line 1473

Insert two new branches. `$reduce/acc` must be passed as a parameter through the evaluator; `event#/` resolves from the event parameter:

```
if (ref.startsWith("$reduce/")) → return acc (passed via context)
if (ref.startsWith("event#/"))  → return getPath(event, ref.slice("event#/".length))
```

For the runtime, these are handled within `expression.js`'s operand resolver rather than modifying the existing `resolveRef` signature (which would break all callers). The expression evaluator has its own `resolveExpressionRef(ref, state, event, acc)` that delegates to `resolveRef` for standard schemes and handles the new ones directly.

---

## Phase 2: Runtime Integration

### 2.1 Shape 5 Detection in `buildScope`

**File:** `/home/batonac/Development/jx/packages/runtime/src/runtime.js` lines 142-172

Insert a new check in the first pass (object branch, line 162-171), **before** the `$prototype` check:

```js
// Shape 5: $expression — defer to expression pass
if ("$expression" in def) continue;
```

### 2.2 New Pass: Expression Resolution (Pass 2.5)

Insert after line 182 (after the template-string computed pass) and before line 185 (the Function pass):

```js
// Pass 2.5: $expression entries → handler or computed
for (const [key, def] of Object.entries(defs)) {
  if (typeof def === "object" && def !== null && !Array.isArray(def) && "$expression" in def) {
    const node = def.$expression;
    if (isMutatingOperator(node.operator)) {
      // Mutating → handler function (state, event) => { ... }
      state[key] = (s, event) => evaluateExpression(node, s, event);
    } else {
      // Pure → computed
      state[key] = computed(() => evaluateExpression(node, state, null));
    }
  }
}
```

### 2.3 Inline `$expression` in Event Handlers

**File:** `/home/batonac/Development/jx/packages/runtime/src/runtime.js` lines 480-497 (`applyProperties`)

After the existing `$ref` handler check (line 482-488) and the inline `$prototype: "Function"` check (line 491-497), add a third branch:

```js
// Event handler: inline $expression
if (val && typeof val === "object" && "$expression" in val) {
  const node = val.$expression;
  const scope = state;
  el.addEventListener(key.slice(2), (e) => evaluateExpression(node, scope, e));
  continue;
}
```

### 2.4 Operator Classification Helper

In `expression.js`:

```js
const MUTATING_OPS = new Set([
  "=",
  "+=",
  "-=",
  "*=",
  "/=",
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
]);
const PURE_OPS = new Set([
  "!",
  "-",
  "+",
  "*",
  "/",
  "%",
  "===",
  "!==",
  "<",
  "<=",
  ">",
  ">=",
  "&&",
  "||",
  "reduce",
  "map",
  "filter",
]);

export function isMutatingOperator(op) {
  return MUTATING_OPS.has(op);
}
export function isPureOperator(op) {
  return PURE_OPS.has(op);
}
```

### 2.5 Assignment Target Resolution

For mutating operators, `target` is always a `$ref` Pointer. The assignment must resolve the pointer path to a writable location on the state proxy:

```js
function resolveWritableRef(ref, state) {
  // "#/state/count" → { obj: state, key: "count" }
  // "#/state/items/0/name" → { obj: state.items[0], key: "name" }
  // "$map/item/qty" → { obj: state.$map.item, key: "qty" }
  if (ref.startsWith("#/state/")) {
    const path = ref.slice("#/state/".length);
    const parts = path.split("/");
    let obj = state;
    for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
    return { obj, key: parts[parts.length - 1] };
  }
  if (ref.startsWith("$map/")) {
    const parts = ref.split("/"); // ["$map", "item", "qty"]
    let obj = state.$map?.[parts[1]] ?? state["$map/" + parts[1]];
    for (let i = 2; i < parts.length - 1; i++) obj = obj[parts[i]];
    return { obj, key: parts[parts.length - 1] };
  }
  // Bare key fallback
  return { obj: state, key: ref };
}
```

---

## Phase 3: Compiler Integration

### 3.1 Expression-to-JS Compiler in shared.js

**File:** `/home/batonac/Development/jx/packages/compiler/src/shared.js`

Add new exported functions. The compiler produces JS source strings rather than executing:

```js
export function compileExpressionToJS(node, opts = {}) { ... }
export function isMutatingOperator(op) { ... }
```

**Operand → JS source mapping:**
| Operand | Output |
|---------|--------|
| `{ "$ref": "#/state/x" }` | `state.x` |
| `{ "$ref": "#/state/items/0/name" }` | `state.items[0].name` |
| `{ "$ref": "event#/target/value" }` | `e.target.value` |
| `{ "$ref": "$map/item/qty" }` | `item.qty` |
| `{ "$ref": "$map/index" }` | `index` |
| `{ "$ref": "$reduce/acc" }` | `acc` |
| `{ "$ref": "parent#/label" }` | `state.label` (already merged into scope) |
| Literal number `42` | `42` |
| Literal string `"hello"` | `"hello"` |
| Literal boolean `true` | `true` |
| Literal null | `null` |
| Nested ExpressionNode | `(` + recursive compile + `)` |

**Node → JS source mapping:**
| Operator type | Output |
|---------------|--------|
| Unary `!` | `(!compiledTarget)` |
| Unary `-` | `(-compiledTarget)` |
| Binary `+` | `(compiledTarget + compiledValue)` |
| Assignment `=` | `compiledTarget = compiledValue` |
| Assignment `+=` | `compiledTarget += compiledValue` |
| `push` | `compiledTarget.push(compiledValue)` |
| `pop` | `compiledTarget.pop()` |
| `splice` | `compiledTarget.splice(compiledValues...)` |
| `reduce` | `compiledTarget.reduce((acc, item, index) => compiledValue, compiledInitial)` |
| `map` | `compiledTarget.map((item, index) => compiledValue)` |
| `filter` | `compiledTarget.filter((item, index) => compiledValue)` |

### 3.2 Expression Detection in `buildInitialScope`

**File:** `/home/batonac/Development/jx/packages/compiler/src/shared.js` line 221-265

Add a check for `$expression` entries inside the object-handling logic (after line 233, before the `$prototype` check at line 234):

```js
if ("$expression" in d) {
  const node = d.$expression;
  if (isMutatingOperator(node.operator)) {
    setOwnScopeValue(scope, key, () => {}); // placeholder handler
  } else {
    // For static analysis: try to evaluate if all operands are static
    defineLazyScopeValue(scope, key, () => null); // placeholder computed
  }
  continue;
}
```

### 3.3 compile-element.js Updates

**File:** `/home/batonac/Development/jx/packages/compiler/src/targets/compile-element.js`

**Classification loop (around line 231-246):** Add detection for `$expression` BEFORE the `$prototype` check:

```js
if (d && typeof d === "object" && !Array.isArray(d) && "$expression" in d) {
  const node = d.$expression;
  if (isMutatingOperator(node.operator)) {
    functionEntries.push([key, { $expression: node }]);
  } else {
    computedEntries.push([key, { $expression: node }]);
  }
  continue;
}
```

**Function emission (line 256-269):** Handle `$expression` function entries:

```js
if (def.$expression) {
  const jsBody = compileExpressionToJS(def.$expression, { stateVar: "this.state", eventVar: "e" });
  lines.push(`    this.state.${key} = (state, e) => { ${jsBody} };`);
}
```

**Computed emission (line 273-283):** Handle pure `$expression`:

```js
if (def.$expression) {
  const jsExpr = compileExpressionToJS(def.$expression, { stateVar: "this.state" });
  lines.push(`    this.state.${key} = computed(() => ${jsExpr});`);
}
```

**Inline event handlers in emitLitNode (line 488-502):** Add `$expression` branch:

```js
} else if (val && typeof val === "object" && "$expression" in val) {
  const jsBody = compileExpressionToJS(val.$expression, { stateVar: 's', eventVar: 'e' });
  parts.push(`@${eventName}="\${(e) => { ${jsBody} }}"`);
}
```

**Mapped array event handlers (line 558-564):** Add same pattern.

### 3.4 compile-client.js Updates

**File:** `/home/batonac/Development/jx/packages/compiler/src/targets/compile-client.js`

**Classification (lines 74-142):** Add `$expression` detection before the `$prototype` check (around line 86):

```js
if ("$expression" in d) {
  const node = d.$expression;
  if (isMutatingOperator(node.operator)) {
    onEntries.push([key, { $expression: node }]);
  } else {
    computedEntries.push([key, "() => " + compileExpressionToJS(node, { stateVar: 'state' })]);
  }
  continue;
}
```

**Inline event handlers (line 261-275):** Add `$expression` branch after the `$prototype: "Function"` check:

```js
} else if (val && typeof val === "object" && "$expression" in val) {
  const key = `_h${counter.h++}`;
  bindAttrs.push(`@${eventName}="${key}"`);
  handlers.set(key, { $expression: val.$expression });
  needsBind = true;
}
```

**`emitClientModule` handler emission:** When emitting `on = { ... }`, check if entry has `$expression`:

```js
if (def.$expression) {
  const jsBody = compileExpressionToJS(def.$expression, { stateVar: "state", eventVar: "e" });
  lines.push(`  ${key}: (e) => { ${jsBody} },`);
} else {
  // existing body-based emission
}
```

**Mapped array inline handlers (line 491-503):** Add `$expression` branch:

```js
} else if (val && typeof val === "object" && "$expression" in val) {
  const jsBody = compileExpressionToJS(val.$expression, { stateVar: 'state', eventVar: 'e' });
  attrs += " @" + eventName + "=${(e) => { state.$map = { item, index }; " + jsBody + " }}";
}
```

### 3.5 compile-static.js / compile-server.js

Minimal changes — `$expression` entries that are mutating are simply skipped (they are handlers, produce no rendered output). Pure expressions could be statically evaluated if operands are known, but this is an optimization for later. For now, just ensure they don't crash:

```js
if ("$expression" in d) continue; // Skip in static render
```

---

## Phase 4: Schema Integration

### 4.1 Merge Expression Schema into Main Schema

**File:** `/home/batonac/Development/jx/packages/schema/schema.json`

1. Copy all `$defs` from `/home/batonac/Development/jx/specs/expression.schema.json` into the main schema's `$defs` section (the main schema already uses `$defs` for TypedStateDef, FunctionDef, etc.):
   - `ExpressionPointer` (renamed from `Pointer` to avoid conflicts)
   - `ExpressionLiteral` (renamed from `Literal`)
   - `ExpressionOperand` (renamed from `Operand`)
   - `UnaryOperator`, `BinaryOperator`, `AssignmentOperator`
   - `NoArgMethod`, `OneArgMethod`, `SpliceMethod`, `ReduceMethod`, `MapFilterMethod`
   - `ExpressionNode`
   - `ExpressionEntry`

2. Add `ExpressionEntry` to the `StateEntry` oneOf array (line 170-219). Insert after `ExternalClassDef` (line 195) and before the plain-object catch-all (line 198):

   ```json
   { "$ref": "#/$defs/ExpressionEntry" }
   ```

3. Add `ExpressionEntry` as a valid event handler value. Find wherever `onclick`, `oninput`, etc. properties are defined (likely via a pattern property or explicit property defs) and add `ExpressionEntry` as an alternative alongside `{ "$ref": ... }` and `FunctionDef`.

---

## Phase 5: Spec Updates

### 5.1 Amend spec.md

**File:** `/home/batonac/Development/jx/specs/spec.md`

- **Section 5.7 (Shape detection):** Insert Shape 5 between existing Shape 4 and the catch-all, as described in addendum section 19.7
- **Section 7.4 (Reference resolution):** Add `$reduce/acc` and `event#/` to the resolution order table
- **Section 17 (Reserved keywords):** Add `$expression`, `operator`, `target`, `value`, `initial`
- Add a forward reference to section 19 (addendum)

---

## Phase 6: Example Updates

### 6.1 Update `counter.json`

**File:** `/home/batonac/Development/jx/examples/components/counter.json`

Replace `increment`, `decrement`, `reset`:

```json
"increment": {
  "$expression": { "operator": "+=", "target": { "$ref": "#/state/count" }, "value": 1 },
  "$description": "Increase count by 1"
},
"decrement": {
  "$expression": { "operator": "-=", "target": { "$ref": "#/state/count" }, "value": 1 },
  "$description": "Decrease count by 1"
},
"reset": {
  "$expression": { "operator": "=", "target": { "$ref": "#/state/count" }, "value": 0 },
  "$description": "Reset count to 0"
}
```

Note: The original `decrement` uses `Math.max(0, state.count - 1)` which cannot be expressed purely with `$expression`. Accept simpler behavior (allow negatives) or keep `body` for that one handler. For the example, `-=` is cleaner and demonstrates the feature.

### 6.2 Update `contact-form.json`

**File:** `/home/batonac/Development/jx/examples/components/contact-form.json`

Replace `setName`, `setEmail`, `setMessage` with `$expression`:

```json
"setName": {
  "$expression": {
    "operator": "=",
    "target": { "$ref": "#/state/name" },
    "value": { "$ref": "event#/target/value" }
  }
},
"setEmail": {
  "$expression": {
    "operator": "=",
    "target": { "$ref": "#/state/email" },
    "value": { "$ref": "event#/target/value" }
  }
},
"setMessage": {
  "$expression": {
    "operator": "=",
    "target": { "$ref": "#/state/message" },
    "value": { "$ref": "event#/target/value" }
  }
}
```

Alternatively, these could become inline expressions on the `oninput` properties directly (removing the named state entries entirely).

---

## Phase 7: Tests

### 7.1 Unit Tests for Expression Evaluator

**New file:** `/home/batonac/Development/jx/packages/runtime/tests/expression.test.js`

Test cases:

- Each unary operator: `!true → false`, `-5 → -5`
- Each binary operator: `3 + 4 → 7`, `"a" === "a" → true`, etc.
- Each assignment operator on a reactive proxy
- Array methods: push adds element, pop removes last, splice removes at index
- Nested expressions: `count = count + 1`
- `event#/` resolution: `{ "$ref": "event#/target/value" }` with mock event
- `$reduce/acc` inside reduce: cart total calculation
- `$map/item` inside map/filter
- Error: mutating operator as nested operand (validation)
- Error: `event#/` outside handler (event is null)
- Aggregate composition: filter nested inside reduce target

### 7.2 Integration Tests for Runtime

**Extend:** `/home/batonac/Development/jx/packages/runtime/tests/runtime.test.js`

New `describe("$expression")` block:

- `buildScope` correctly identifies Shape 5
- Mutating expression → function on state, callable as `(state, event)`
- Pure expression → computed signal (reactive, updates when deps change)
- Inline `$expression` on element `onclick` → triggers correctly
- Named expression referenced via `$ref` from event handler
- Array mutation expression with `$map/` context in mapped array children

### 7.3 Compiler Tests

**Extend or create new file** for compiler output verification:

- `compileExpressionToJS` produces correct output for each operator category
- compile-element output includes expression handlers and computed correctly
- compile-client output includes expression handlers in `on = { ... }` block
- compile-client computed entries include expression-derived computeds

---

## Implementation Order (Dependency Chain)

| Step | File(s)                                            | Depends on                                |
| ---- | -------------------------------------------------- | ----------------------------------------- |
| 1    | `packages/runtime/src/expression.js` (new)         | Nothing — pure logic                      |
| 2    | `packages/compiler/src/shared.js`                  | Step 1 (imports `isMutatingOperator`)     |
| 3    | `packages/runtime/src/runtime.js`                  | Step 1 (imports evaluateExpression)       |
| 4    | `packages/compiler/src/targets/compile-element.js` | Step 2                                    |
| 5    | `packages/compiler/src/targets/compile-client.js`  | Step 2                                    |
| 6    | `packages/compiler/src/targets/compile-static.js`  | Step 2 (trivial skip)                     |
| 7    | `packages/schema/schema.json`                      | Independent                               |
| 8    | `specs/spec.md`                                    | Independent                               |
| 9    | Examples                                           | Steps 3-5 (need working runtime/compiler) |
| 10   | Tests                                              | Steps 1-5                                 |

---

## Key Risks and Mitigations

| Risk                                                                                                | Mitigation                                                                                   |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Assignment to nested paths (e.g., `$map/item/qty`) requires path-walking write                      | Implement `resolveWritableRef` that returns `{ obj, key }` for the final segment             |
| `event#/` used in a pure computed (invalid)                                                         | Validate at compile time; at runtime, `event` is `null` producing clear error                |
| Aggregate operators shadow outer `$map/` context                                                    | Document behavior; push/pop `$map` context within reduce/map/filter callbacks                |
| Compiler variable name differences (`s` in element, `state` in client, `this.state` in constructor) | `compileExpressionToJS` accepts `opts.stateVar` parameter                                    |
| `-` operator ambiguity (unary negation vs binary subtraction)                                       | Schema handles this via oneOf: if `value` is present → binary, else → unary                  |
| Performance of recursive evaluation in tight loops                                                  | Expression trees are shallow in practice (2-3 levels); negligible overhead vs `new Function` |
