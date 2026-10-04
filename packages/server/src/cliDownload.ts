/** Public, checksummed distribution for the dependency-free OverLyX CLI. */
import express, { type Request } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliFile = path.resolve(here, '../../cli/bin/overlyx.js');
const packageFile = path.resolve(here, '../../cli/package.json');

function release(): { version: string; body: Buffer; hash: string } {
  const version = String(JSON.parse(fs.readFileSync(packageFile, 'utf8')).version);
  const body = fs.readFileSync(cliFile);
  const hash = crypto.createHash('sha256').update(body).digest('hex');
  return { version, body, hash };
}

function publicOrigin(req: Request): string {
  return (config.publicUrl || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function installer(req: Request): string {
  const { version, hash } = release();
  const origin = publicOrigin(req);
  return `#!/bin/sh
set -eu

version=${shellQuote(version)}
expected=${shellQuote(hash)}
origin=\${OVERLYX_ORIGIN:-${shellQuote(origin)}}
install_dir=\${OVERLYX_INSTALL_DIR:-"\${HOME}/.local/bin"}
url="\${origin%/}/cli/v\${version}/overlyx"

command -v node >/dev/null 2>&1 || { echo "overlyx: Node.js 20 or newer is required" >&2; exit 1; }
node_major=$(node -p "Number(process.versions.node.split('.')[0])")
[ "$node_major" -ge 20 ] || { echo "overlyx: Node.js 20 or newer is required" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "overlyx: curl is required" >&2; exit 1; }

mkdir -p "$install_dir"
tmp=$(mktemp "$install_dir/.overlyx.XXXXXX")
cleanup() { rm -f "$tmp"; }
trap cleanup EXIT HUP INT TERM
curl -fsSL "$url" -o "$tmp"

if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$tmp" | awk '{print $1}')
else
  echo "overlyx: sha256sum or shasum is required to verify the download" >&2
  exit 1
fi
[ "$actual" = "$expected" ] || { echo "overlyx: checksum verification failed" >&2; exit 1; }

chmod 755 "$tmp"
mv -f "$tmp" "$install_dir/overlyx"
ln -sf overlyx "$install_dir/olx"
trap - EXIT HUP INT TERM

echo "Installed OverLyX CLI $version in $install_dir"
case ":$PATH:" in
  *:"$install_dir":*) ;;
  *) echo "Add $install_dir to PATH to run overlyx or olx." ;;
esac

# local AI agents (Claude Code, Codex): registered with the CLI's MCP bridge, which follows the
# server and the login by itself (OVERLYX_MCP=yes / no answers without asking)
case "\${OVERLYX_MCP:-ask}" in
  yes) "$install_dir/overlyx" mcp install --yes || true ;;
  no) ;;
  *)
    if (command -v claude >/dev/null 2>&1 || command -v codex >/dev/null 2>&1) && [ -t 2 ] && { : </dev/tty; } 2>/dev/null; then
      printf 'Let Claude Code / Codex on this computer use OverLyX (registers the MCP server)? [Y/n] ' >/dev/tty
      read -r answer </dev/tty || answer=n
      case "$answer" in
        [Nn]*) echo "Later: overlyx mcp install" ;;
        *) "$install_dir/overlyx" mcp install --yes || true ;;
      esac
    fi ;;
esac
`;
}

export function cliDownloadRoutes(): express.Router {
  const router = express.Router();
  router.get('/install-cli.sh', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('text/x-shellscript').send(installer(req));
  });
  // how the CLI's MCP bridge (`overlyx mcp serve`) reaches the connector — read at every agent
  // session, so a change here reaches every registered agent without registering it again
  router.get('/cli/mcp.json', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ url: '/mcp', headers: { Authorization: 'Bearer {token}' } });
  });
  router.get('/cli/version', (_req, res) => {
    const { version, hash } = release();
    res.setHeader('Cache-Control', 'no-store');
    res.json({ version, sha256: hash });
  });
  const sendCli = (immutable: boolean) => (_req: express.Request, res: express.Response) => {
    const { body, hash } = release();
    res.setHeader('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    res.setHeader('ETag', `"${hash}"`);
    res.type('application/javascript').send(body);
  };
  router.get('/cli/overlyx', sendCli(false));
  router.get(`/cli/v${release().version}/overlyx`, sendCli(true));
  return router;
}
