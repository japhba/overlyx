# Notes for agents working on OverLyX

How to run, test and deploy: [DOCS.md](DOCS.md). The file format: [README.md](README.md).

## Keyboard shortcuts are contextual (VS Code's model)

A key may do different things in different places, as VS Code's keybindings carry a `when`
clause: where the user is (typing in a text, objects selected on a slide, a formula open, the node
editor on) decides what a key does, and the most specific context wins. On a slide, for example,
Ctrl+K adds a link while typing in a text (as in documents) and combines paths when shapes are
selected (Inkscape's), and Ctrl+M opens a formula while typing but adds a slide otherwise.

- The same kind of context means the same keys in every editor. Typing in a document, a slide or a
  markdown file shares one set: Ctrl+K link, Ctrl+M formula, Ctrl+Shift+C citation, Ctrl+Shift+I
  cross-reference, Ctrl+B / I / U.
- Give a key a context-specific meaning only where its usual one means nothing there. With shapes
  selected and no text being typed, there is nothing to link, so Ctrl+K can combine them.
- Say the context where people see the shortcut, e.g. "Combine (Ctrl+K)" in the Path menu
  of selected shapes, "Link (Ctrl+K)" in the text toolbar.
- Users rebind shortcuts per command (`app/keybindings.ts`). When a context gets commands of its
  own, the context belongs to the binding, as VS Code's `when` does.

## Examples carry no one's name and don't address the reader by it

What users see — the welcome document, the starter projects, templates, demo recordings,
screenshots, the start page — never carries the maintainer's name or the signed-in user's, and
never addresses the reader by name: no "This is your document, Ada", "Enjoy writing, Ada!", "written
for you, Ada" or "Welcome, Ada". The welcome document's author is "OverLyX", the starters' is
"Your Name", greetings are plain ("Welcome"). Where an example needs people (co-authors, comment
threads), make them up. A document the user creates with + New may still have their name as
`\author`: that one is theirs, not an example.
