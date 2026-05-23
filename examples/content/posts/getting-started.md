---
title: Getting Started with Jx
date: 2025-03-15
tags: [jx, tutorial, web]
published: true
author: Jane Smith
---

Jx is a JSON schema for building reactive web applications. It keeps **structure and state as data** while keeping **behavior as code**.

## Installation

Install the runtime from npm:

```bash
npm install @jxsuite/runtime
```

## Your First Component

Every Jx component is a pair of files:

- A `.json` file for structure and declarations
- A `.js` file for event handlers and logic

```json
{
  "$schema": "https://jxsuite.com/schema/v1",
  "$id": "Counter",
  "tagName": "my-counter",
  "$defs": {
    "$count": { "default": 0 }
  }
}
```

## The Philosophy

Jx follows the [Rule of Least Power](https://www.w3.org/DesignIssues/Principles.html#PLP):

1. **Declarative JSON** over imperative JavaScript
2. **`$ref` bindings** over template expressions
3. **Template expressions** over handler functions
4. **Handler functions** only when nothing else works

This hierarchy keeps your application maximally analyzable and visual-builder-friendly.

## Next Steps

Check out the [full specification](/spec) for details on all features including:

- Signal declarations and computed signals
- Dynamic mapped arrays
- Component encapsulation with explicit props
- Server-side compilation to zero-JS static HTML
