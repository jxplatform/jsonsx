# `@jxsuite/runtime`

> JSON-native reactive web component runtime for Jx.

## Overview

The runtime mounts Jx documents into the browser DOM. It walks the JSON tree, constructs DOM nodes, and wires reactive effects using [`@vue/reactivity`](https://github.com/vuejs/core/tree/main/packages/reactivity). State is tracked automatically: no virtual DOM, no diffing.

## Installation

```bash
bun add @jxsuite/runtime
```

## Usage

```js
import { Jx } from "@jxsuite/runtime";

// Mount from a URL
const state = await Jx("./counter.json", document.getElementById("app"));

// Or pass a raw document object
const state = await Jx({ tagName: "div", textContent: "Hello" });
```

`Jx()` returns a promise that resolves with the live component scope (the reactive state proxy).

## Pipeline

Each document goes through four steps:

| Step | Function                        | Description                               |
| ---- | ------------------------------- | ----------------------------------------- |
| 1    | `resolve(source)`               | Fetch JSON or accept a raw object         |
| 2    | `buildScope(doc, parent, base)` | Detect state shapes, build reactive proxy |
| 3    | `renderNode(doc, state, opts)`  | Walk tree, create DOM nodes, wire effects |
| 4    | append to target                | Mount result into the container           |

## State shapes

| Shape       | Detected by                    | Reactive primitive |
| ----------- | ------------------------------ | ------------------ |
| Naked value | Scalar, array, or plain object | `reactive()`       |
| Typed value | Object with `default` key      | `ref()`            |
| Computed    | String containing `${}`        | `computed()`       |
| Function    | `$prototype: "Function"`       | Plain function     |
| Data source | `$prototype: <ClassName>`      | `ref()` (async)    |

## `$ref` bindings

| Pattern  | Example                        | Meaning                                                     |
| -------- | ------------------------------ | ----------------------------------------------------------- |
| State    | `{ "$ref": "#/state/count" }`  | Reactive state binding                                      |
| Map item | `{ "$ref": "$map/item" }`      | Current item in `Array` iteration                           |
| Parent   | `{ "$ref": "parent#/color" }`  | Prop passed via `$props`                                    |
| Window   | `{ "$ref": "window#/config" }` | Window global                                               |
| External | `{ "$ref": "./card.json" }`    | Component doc (via `$switch`/`$elements`, not a bare child) |

## Custom element support

Components with a hyphenated `tagName` are registered as [custom elements](https://developer.mozilla.org/en-US/docs/Web/API/Web_components/Using_custom_elements). Dependencies listed in `$elements` are registered depth-first before the parent.

## Bundle size

`@vue/reactivity` (~7 kB gzip) is always included. `lit-html` (~3 kB gzip) is only included when the document renders custom elements (hyphenated `tagName`).

## License

MIT
