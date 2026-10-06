# OverLyX CLI

A small `gh`-style client for creating OverLyX projects, pushing existing local work, building
documents on the server and restoring a project to an earlier commit.

```sh
curl -fsSL https://overlyx.app/install-cli.sh | sh

# Opens the browser: click Authorize (signed in to OverLyX), and the CLI is signed in.
overlyx auth login

# An existing Git repository (it must be clean):
overlyx repo create my-paper --source ./paper --push

# Or an ordinary folder. The CLI initialises it and makes its first commit:
olx repo push ./paper --name my-paper
```

`repo push` is retry-friendly: if the named project already exists and your account is its owner or
an editor, it pushes to that project. Git still enforces fast-forward history, so it will reject a
divergent remote instead of overwriting it.

`auth login` works like Claude Code's sign-in: it opens OverLyX in the browser, you authorize the CLI
there, and the browser hands a one-time code back to the CLI (a redirect to a listener on
127.0.0.1, PKCE-protected). On a computer without a browser of its own (an SSH session, a server)
the page shows the code to paste into the terminal instead (`--no-browser` asks for that). The CLI
gets a credential of its own, "OverLyX CLI on <computer>", which you can revoke on its own in
File > Git repository; your account token is not touched. Plain git uses it too: the sign-in sets
the CLI up as git's credential helper for that server (`credential.<server>.helper`, in your global
git config, ahead of any helper that kept an older token), so `git clone`, `pull` and `push` of your
OverLyX projects — in any folder — need nothing pasted. `--no-git` skips that, `overlyx auth
setup-git` does it later, `auth logout` undoes it. The sign-in reaches all your projects, with
your role in each. To give a computer less, switch on Settings > Account > Fine-grained access in
OverLyX: the authorization page then lets you pick the projects (signing in from a clone ticks its
project) and make it read only. Git, builds and agents on that computer then reach only those, and
`overlyx auth status` shows the limit. For scripts and CI, pass the account
token instead: `--username NAME --with-token` (stdin), `--token`, or `OVERLYX_HOST` /
`OVERLYX_USERNAME` / `OVERLYX_TOKEN`.

The login is saved in `$XDG_CONFIG_HOME/overlyx/hosts.json` (normally
`~/.config/overlyx/hosts.json`) with mode `0600`. No token is ever included in a Git remote URL.

The installer requires Node.js 20+, verifies the CLI's SHA-256 checksum, and installs `overlyx`
plus its `olx` alias in `~/.local/bin`. Set `OVERLYX_INSTALL_DIR=/usr/local/bin` (with suitable
permissions) to choose another location. The installer is ordinary shell text, so it can be
downloaded and inspected before running instead of piped directly to `sh`.

## Building and stepping back

```sh
overlyx build ada/paper/main.tex                 # compile on the server; errors and exit code 1 if it fails
overlyx build ada/paper/main.tex --pdf paper.pdf
overlyx restore ada/paper 3f2a91c                # the whole project back to that commit (a new commit on top)
```

## Local AI agents (Claude Code, Codex, …)

```sh
overlyx mcp install      # registers OverLyX with the Claude Code / Codex found on this computer
overlyx mcp status       # what is registered, and a round trip to the server
overlyx mcp uninstall
```

The installer offers to sign in (in the browser) right after installing, and `auth login` then
offers this when nothing is registered yet (`OVERLYX_MCP=yes` / `no` answers without asking). What gets registered is a command, not an
address and a token: `overlyx mcp serve`, a bridge between the agent (stdio) and the server's MCP
connector. Every agent session starts it anew, so it uses the login as it is then (a new token after
`overlyx auth login` counts at once), asks the server where and how to connect (`/cli/mcp.json`),
and the tools are the server's — changes on the server reach the agents without registering again.
An installed CLI also keeps itself up to date (`overlyx update`; the bridge checks once an hour, for
the next session). The agent edits your projects on the server, with your role in each. Started
inside a git clone of an OverLyX project, it is told which project that is — and to edit the files of
the clone, as tracked changes through the VS Code extension's local tools (`overlyx-local`, see the
extension's README) when it has them, and to push with git.

So you can start `claude` in any directory and tell it to do something in OverLyX ("tighten the
abstract of my thesis", "fix this paragraph": it sees your cursor and selection in the document you
have open). Claude Code normally asks before it uses each tool of a server the first time, and "don't
ask again" holds only for the directory it runs in. `mcp install` therefore allows OverLyX's tools
once, for every directory: it adds `mcp__overlyx` to `permissions.allow` in Claude Code's user
settings (`~/.claude/settings.json`) and leaves the rest of that file alone. Its edits are tracked
changes and every state stays in the project's history. `--ask-each-time` skips this, and
`mcp uninstall` takes the rule out again.

A clone of the OverLyX repository needs no registration at all: its `.mcp.json` (Claude Code) and
`.codex/config.toml` (Codex, once the project is trusted) run the checkout's own CLI as the bridge —
sign in once per computer with `node packages/cli/bin/overlyx.js auth login`.

## Commands

```text
overlyx auth login [--host URL] [--no-browser] [--no-git]
overlyx auth login [--host URL] --username NAME --with-token | --token TOKEN
overlyx auth setup-git [--host URL]
overlyx auth status [--host URL]
overlyx auth logout [--host URL]
overlyx repo list [--host URL]
overlyx repo create [NAME] [--source PATH] [--push] [--remote NAME]
overlyx repo push [PATH] [--name NAME] [--remote NAME]
overlyx build OWNER/PROJECT/FILE.tex [--pdf FILE] [--log] [--wait SECONDS]
overlyx restore OWNER/PROJECT COMMIT
overlyx mcp install [--client claude,codex] [--yes] [--ask-each-time] | status | uninstall | serve
overlyx update
```

Passing `--token` is convenient for automation but can expose it in shell history; prefer
`--with-token` or `OVERLYX_TOKEN`.

Each account has one manually-managed token (`olx_…`) for Git, the CLI and manual MCP setup. MCP
sends it as `Authorization: Bearer <token>`; Git and the CLI pair it with your username using HTTP
Basic authentication. Rotating or revoking it immediately stops all three uses. OAuth clients keep
their own short-lived credentials so one OAuth connection can be disconnected independently.
