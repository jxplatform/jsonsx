---
title: Interactive Post with Components
date: 2025-04-12
tags: [jx, directives, interactive]
published: true
author: John Doe
---

This post demonstrates embedding Jx custom elements inside markdown using directive syntax.

## A Simple Callout

:::info-box{type="warning"}
This is **important** content rendered inside a custom element.
The component receives `type` as a prop from the directive attribute.
:::

## Inline Components

You can also embed components inline: see :jx-tooltip[the documentation]{href="/docs"} for details.

## Leaf Directives

A self-contained component on its own line:

::user-card{firstName="Jane" lastName="Smith" role="Engineer"}
