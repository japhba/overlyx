# Notes for agents working on OverLyX

How to run, test and deploy: [DOCS.md](DOCS.md). The file format: [README.md](README.md).

## Keep testing to a minimum

The user trusts the agents' changes: keep testing to a minimum unless they ask for more. Batch
related fixes, then run a focused check of what changed (a typecheck, the unit tests of the code you
touched, a look at the screen for visual changes). Don't add e2e/browser runs, full suites or new
deployment gates on your own; use extra targeted checks only to diagnose a failure or resolve real
uncertainty.

Deploys (`scripts/deploy.sh`, the autodeploy timer) run both typechecks, the unit suite and the
client build — nothing more. The browser release gate (`npm run test:beta`, ~35 min) and the strict
unit matrix (`npm run test:release`) run only when the user asks (`OVERLYX_DEPLOY_FULL=1`).
When you are reasonably confident of a change, bypass those checks: `scripts/deploy.sh --no-checks`,
or the trailer `Deploy: no-checks` on the last commit of a push that the autodeploy timer deploys.
The client is still built and the site still verified.

## Deploy by default

After completing application changes, commit and deploy them by default unless the user explicitly
says otherwise. The owner authorizes this as part of the requested work; do not ask for deployment
confirmation. Use `scripts/deploy.sh --no-checks` after appropriate focused verification, following
the deployment guidance above, and verify that the live site serves the deployed commit.

## Unattended maintenance

The owner authorizes the maintenance worker to screen GitHub issues and private reports/logs,
implement clear fixes, run minimal focused checks, and deploy without supervision (16 Oct 2026).
`scripts/maintenance.sh`, run by `overlyx-maintenance.timer` every ten minutes, uses its own
checkout and private persistent state. The runner commits and deploys with `--no-checks`; do not
add review stages or broader test gates. See DOCS.md for operation and pause/resume commands.

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
