---
$schema: https://jxsuite.com/schema/v1
$id: TodoApp
tagName: todo-app
$media:
  --md: "(min-width: 768px)"
  --dark: "(prefers-color-scheme: dark)"
state:
  items:
    $prototype: LocalStorage
    key: jx-todo-items
    default: []
  newText: ""
  remaining: "${state.items.filter(i => !i.done).length}"
  total: "${state.items.length}"
  summary: "${state.remaining} of ${state.total} remaining"
  addItem:
    $prototype: Function
    body: >
      if (!state.newText.trim()) return;
      state.items.push({ id: Date.now(), text: state.newText.trim(), done: false });
      state.newText = ""
  toggleItem:
    $prototype: Function
    arguments: [id]
    body: >
      const item = state.items.find(i => i.id === id);
      if (item) item.done = !item.done
  deleteItem:
    $prototype: Function
    arguments: [id]
    body: >
      state.items.splice(0, state.items.length, ...state.items.filter(i => i.id !== id))
  clearDone:
    $prototype: Function
    body: >
      state.items.splice(0, state.items.length, ...state.items.filter(i => !i.done))
style:
  fontFamily: "system-ui, sans-serif"
  maxWidth: 560px
  margin: "2rem auto"
  padding: 1rem
  "@--dark":
    backgroundColor: "#1a1a1a"
    color: "#f0f0f0"
---

::::::header{style.marginBottom="1.5rem"}

:::::h1{style.fontSize="1.75rem" style.fontWeight="700" style.marginBottom="0.25rem"}
To-do
:::::

::p{textContent="${state.summary}" color="var(--color-muted)"}
::::::

::::::add-form{style.display="flex" style.gap="0.5rem" style.marginBottom="1.5rem" style.--md.gap="1rem"}

:::::input{type="text" value="${state.newText}" oninput="state.newText = event.target.value" onkeydown="if (event.key === 'Enter') state.addItem()" placeholder="What needs doing?" style.flex="1" style.padding="0.5rem 0.75rem" style.borderRadius="6px" style.border="1px solid var(--color-border)" style.fontSize="1rem" style.background="var(--color-surface)" style.color="inherit"}
:::::

:::::button{onclick="${state.addItem}" style.padding="0.5rem 1rem" style.borderRadius="6px" style.backgroundColor="var(--color-primary)" style.color="white" style.border="none" style.cursor="pointer" style.fontWeight="600" style.hover.backgroundColor="var(--color-primary-dark)" style.disabled.opacity="0.5" style.disabled.cursor="not-allowed"}
Add
:::::

::::::

::::::todo-list{style.listStyle="none" style.padding="0" style.margin="0" style.display="flex" style.flexDirection="column" style.gap="0.5rem" children.prototype="Array" children.items.ref="#/state/items" children.map.component="todo-item" children.map.props.item.ref="$map/item" children.map.props.onToggle.ref="#/state/toggleItem" children.map.props.onDelete.ref="#/state/deleteItem"}
::::::

::::::footer{hidden="${state.total === 0}" style.marginTop="1rem" style.display="flex" style.justifyContent="space-between" style.alignItems="center" style.fontSize="0.875rem" style.color="var(--color-muted)"}

::span{textContent="${state.remaining} item${state.remaining === 1 ? '' : 's'} left"}

:::::button{onclick="${state.clearDone}" hidden="${state.items.every(i => !i.done)}" style.background="none" style.border="none" style.cursor="pointer" style.color="var(--color-muted)" style.fontSize="0.875rem" style.hover.color="var(--color-danger)"}
Clear completed
:::::

::::::
