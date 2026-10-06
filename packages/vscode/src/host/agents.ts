/**
 * AI agents on this computer (Claude Code, Codex) and the documents open here: the extension
 * offers once to connect them to its local tool server (agents/server.ts) — their edits of
 * OverLyX documents then arrive as tracked changes, and they can comment. Connected, every start
 * of the extension refreshes the launcher and re-registers if VS Code's runtime moved (an update);
 * "OverLyX: Connect AI Agents" / "Disconnect AI Agents" do it on demand.
 */
import * as vscode from 'vscode';
import path from 'node:path';
import {
  installLauncher, launcherCommand, detectAgents, registerClaude, unregisterClaude, claudeRegistered, allowClaudeTools,
  registerCodex, unregisterCodex, codexRegistered, instructCodex, claudeSettingsFile, codexConfigFile, codexInstructionsFile, CLAUDE_ALLOW, type StdioCommand,
} from '../agents/register.ts';
import { publishOpenDocuments } from '../agents/openDocuments.ts';

/** globalState: 'connected' | 'declined' | a time (ms) before which not to ask again */
const STATE = 'agents.connect';
const ASK_AGAIN_MS = 7 * 24 * 3600_000;

export function setupAgents(context: vscode.ExtensionContext, layoutDir: () => string, report: (e: unknown, area: string) => void,
  open: { files(): string[]; onDidChange: vscode.Event<void>; endpoint(): string }): void {
  const agentsDir = path.join(context.globalStorageUri.fsPath, 'agents');
  const command = (): StdioCommand => {
    const launcher = installLauncher(agentsDir, {
      main: path.join(context.extensionPath, 'dist', 'agents.cjs'),
      layoutDir: layoutDir(),
      extensionsDir: path.dirname(context.extensionPath),
      extensionId: context.extension.id,
    });
    return launcherCommand(process.execPath, launcher, vscode.env.appRoot);
  };

  /** Register with the agents found (or refresh a registration that went stale); returns what was done, for a message. */
  const connect = async (): Promise<string[]> => {
    const cmd = command();
    const agents = await detectAgents();
    const done: string[] = [];
    if (agents.claude) {
      try {
        if (!claudeRegistered(cmd)) await registerClaude(cmd);
        try { allowClaudeTools(true); done.push('Claude Code (in every folder, without asking each time)'); }
        catch (e) { done.push(`Claude Code (it asks before each tool: ${(e as Error).message})`); }
      } catch (e) { done.push(`not Claude Code: ${String((e as { stderr?: string }).stderr || (e as Error).message).trim()}`); }
    }
    if (agents.codex) {
      try { registerCodex(cmd); await context.globalState.update('agents.codexNote', true); done.push(`Codex (${codexConfigFile()}, and a note in ${codexInstructionsFile()})`); }
      catch (e) { done.push(`not Codex: ${(e as Error).message}`); }
    }
    return done;
  };

  const connectNow = async (interactive: boolean): Promise<void> => {
    try {
      const done = await connect();
      await context.globalState.update(STATE, 'connected');
      if (!interactive) return;
      if (!done.length) void vscode.window.showWarningMessage('OverLyX: neither Claude Code nor Codex was found on this computer. Install one, then run "OverLyX: Connect AI Agents" again.');
      else void vscode.window.showInformationMessage(`OverLyX: connected ${done.join('; ')}. Agents started from now on edit OverLyX documents as tracked changes (tools of "overlyx-local").`);
    } catch (e) {
      report(e, 'agents.connect');
      if (interactive) void vscode.window.showErrorMessage(`OverLyX: could not connect the agents — ${(e as Error).message}`);
    }
  };

  // the files open in this window's OverLyX editors: agents' edits of them come here (bridge.ts /api/agent/tool), to apply to the editor's text
  let published = '';
  const publish = (files: string[]) => {
    const key = JSON.stringify(files);
    if (key === published) return;
    published = key;
    try { publishOpenDocuments(agentsDir, files, open.endpoint()); } catch (e) { report(e, 'agents.open'); }
  };
  context.subscriptions.push(open.onDidChange(() => publish([...new Set(open.files())].sort())), { dispose: () => publish([]) });

  context.subscriptions.push(
    vscode.commands.registerCommand('overlyx.connectAgents', () => connectNow(true)),
    vscode.commands.registerCommand('overlyx.disconnectAgents', async () => {
      const claude = await unregisterClaude().catch(() => false);
      const codex = unregisterCodex();
      await context.globalState.update(STATE, 'declined');
      void vscode.window.showInformationMessage(claude || codex
        ? `OverLyX: disconnected ${[claude && 'Claude Code', codex && 'Codex'].filter(Boolean).join(' and ')}${claude ? ` (and took ${CLAUDE_ALLOW} out of ${claudeSettingsFile()})` : ''}.`
        : 'OverLyX: no agent was connected.');
    }),
  );

  /** Connected before: registrations whose command went stale (VS Code's runtime moved) are renewed. */
  const refresh = async (): Promise<void> => {
    const cmd = command();
    if (claudeRegistered() && !claudeRegistered(cmd)) await registerClaude(cmd);
    if (codexRegistered() && !codexRegistered(cmd)) registerCodex(cmd);
    // connected with a version before the AGENTS.md note: added once (taken out by the user later, it stays out)
    if (codexRegistered() && !context.globalState.get('agents.codexNote')) { instructCodex(true); await context.globalState.update('agents.codexNote', true); }
  };

  // in the background: never in the way of opening the editor. Only for the installed extension —
  // development hosts and the extension's tests (GUI probes included) prompt nobody and touch no agent config
  if (context.extensionMode !== vscode.ExtensionMode.Production) return;
  void (async () => {
    const state = context.globalState.get<string | number>(STATE);
    if (state === 'connected') { await refresh(); return; }
    if (state === 'declined' || (typeof state === 'number' && Date.now() < state)) return;
    const agents = await detectAgents();
    if (!agents.claude && !agents.codex) return;
    const cmd = command();
    if ((!agents.claude || claudeRegistered(cmd)) && (!agents.codex || codexRegistered(cmd))) { await context.globalState.update(STATE, 'connected'); return; }
    const names = [agents.claude && 'Claude Code', agents.codex && 'Codex'].filter(Boolean).join(' and ');
    const pick = await vscode.window.showInformationMessage(
      `OverLyX: let ${names} edit your documents as tracked changes? You review their edits in the editor and accept or reject them; they can also comment. (Registers OverLyX's local tools with ${agents.claude && agents.codex ? 'them' : 'it'} — nothing leaves this computer.)`,
      'Connect', 'Not now', 'Never',
    );
    if (pick === 'Connect') await connectNow(true);
    else if (pick === 'Never') await context.globalState.update(STATE, 'declined');
    else await context.globalState.update(STATE, Date.now() + ASK_AGAIN_MS);
  })().catch(e => report(e, 'agents.setup'));
}
