# OverLyX CLI

A small `gh`-style client for creating OverLyX projects and pushing existing local work.

```sh
curl -fsSL https://overlyx.app/install-cli.sh | sh

# Paste your account access token from File > Git repository in OverLyX.
overlyx auth login --host https://overlyx.app --username ada --with-token

# An existing Git repository (it must be clean):
overlyx repo create my-paper --source ./paper --push

# Or an ordinary folder. The CLI initialises it and makes its first commit:
olx repo push ./paper --name my-paper
```

`repo push` is retry-friendly: if the named project already exists and your account is its owner or
an editor, it pushes to that project. Git still enforces fast-forward history, so it will reject a
divergent remote instead of overwriting it.

The login is saved in `$XDG_CONFIG_HOME/overlyx/hosts.json` (normally
`~/.config/overlyx/hosts.json`) with mode `0600`. `OVERLYX_HOST`, `OVERLYX_USERNAME` and
`OVERLYX_TOKEN` may be used instead, which is useful in CI. The token is never included in the Git
remote URL.

The installer requires Node.js 20+, verifies the CLI's SHA-256 checksum, and installs `overlyx`
plus its `olx` alias in `~/.local/bin`. Set `OVERLYX_INSTALL_DIR=/usr/local/bin` (with suitable
permissions) to choose another location. The installer is ordinary shell text, so it can be
downloaded and inspected before running instead of piped directly to `sh`.

## Commands

```text
overlyx auth login [--host URL] --username NAME [--with-token | --token TOKEN]
overlyx auth status [--host URL]
overlyx auth logout [--host URL]
overlyx repo list [--host URL]
overlyx repo create [NAME] [--source PATH] [--push] [--remote NAME]
overlyx repo push [PATH] [--name NAME] [--remote NAME]
```

Passing `--token` is convenient for automation but can expose it in shell history; prefer
`--with-token` or `OVERLYX_TOKEN`.

Each account has one manually-managed token (`olx_…`) for Git, the CLI and manual MCP setup. MCP
sends it as `Authorization: Bearer <token>`; Git and the CLI pair it with your username using HTTP
Basic authentication. Rotating or revoking it immediately stops all three uses. OAuth clients keep
their own short-lived credentials so one OAuth connection can be disconnected independently.
