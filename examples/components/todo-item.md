---
$schema: https://jxsuite.com/schema/v1
$id: TodoItem
tagName: todo-item
state:
  item: {}
  onToggle:
    $prototype: Function
    $src: "$props/onToggle"
  onDelete:
    $prototype: Function
    $src: "$props/onDelete"
style:
  display: flex
  alignItems: center
  gap: 0.75rem
  padding: 0.625rem 0.75rem
  borderRadius: 8px
  backgroundColor: "var(--color-surface)"
  border: "1px solid var(--color-border)"
  transition: "opacity 0.15s"
---

::input{type="checkbox" checked="${state.item.done}" onchange="state.onToggle(state.item.id)" style.width="1.1rem" style.height="1.1rem" style.cursor="pointer" style.accentColor="var(--color-primary)"}

:::span{onclick="state.onToggle(state.item.id)" style.flex="1" style.cursor="pointer" style.textDecoration="${state.item.done ? 'line-through' : 'none'}" style.opacity="${state.item.done ? '0.45' : '1'}" style.transition="opacity 0.15s"}
${state.item.text}
:::

:::button{onclick="state.onDelete(state.item.id)" aria-label="Delete item" style.background="none" style.border="none" style.cursor="pointer" style.color="var(--color-muted)" style.padding="0.25rem" style.borderRadius="4px" style.lineHeight="1" style.hover.color="var(--color-danger)" style.hover.backgroundColor="var(--color-danger-subtle)"}
×
:::
