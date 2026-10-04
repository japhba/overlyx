/**
 * Narrowing a new credential on its authorization page, for accounts that switched on
 * Settings ▸ Account ▸ Fine-grained access (userSettings.ts): the CLI sign-in (cliLogin.ts) and
 * OAuth connections (mcpOauth.ts) then show these fields, and the credential reaches only the chosen
 * projects and/or only reads (tokenAuth.ts AccessScope, enforced in access.ts). Plain form fields —
 * the pages run no script. Without the setting nothing is shown and a credential reaches the account.
 */
import { accessibleProjects } from './access.ts';
import type { SessionUser } from './auth.ts';
import type { AccessScope } from './tokenAuth.ts';
import { userSettings } from './userSettings.ts';

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export const SCOPE_CSS = 'fieldset.scope{border:1px solid #ddd;border-radius:8px;margin:12px 0 16px;padding:6px 12px 8px}fieldset.scope legend{padding:0 4px;color:#555}fieldset.scope label{display:block;margin:4px 0}fieldset.scope .projects{max-height:14em;overflow:auto;margin:0 0 6px 1.7em}.err{color:#b00020}';

const picked = (v: unknown): string[] => (Array.isArray(v) ? v : v == null ? [] : [v]).map(String);

/**
 * The fields for the form ('' without fine-grained access). `suggest`: a project to choose first —
 * the clone the CLI runs in; `previous`: the form as sent, when it comes back with an error.
 */
export function scopeFields(user: SessionUser, opts: { suggest?: string | null; previous?: Record<string, unknown> } = {}): string {
  if (!userSettings(user.id).fineGrainedAccess) return '';
  const projects = accessibleProjects(user, { files: false });
  const prev = opts.previous;
  const suggest = opts.suggest && projects.some(p => p.name === opts.suggest) ? opts.suggest : null;
  const some = prev ? prev.reach === 'some' : !!suggest;
  const chosen = new Set(prev ? picked(prev.projects) : suggest ? [suggest] : []);
  const readonly = prev ? prev.readonly === '1' : false;
  // the chosen ones first: the list scrolls, and the suggestion must not hide below its fold
  const list = [...projects.filter(p => chosen.has(p.name)), ...projects.filter(p => !chosen.has(p.name))].map(p => `<label><input type="checkbox" name="projects" value="${esc(p.name)}"${chosen.has(p.name) ? ' checked' : ''}> ${esc(p.name)}${p.title ? ` <span class="muted">— ${esc(p.title)}</span>` : ''}${p.role !== 'owner' ? ` <span class="muted">(${p.role === 'edit' ? 'editor' : 'viewer'})</span>` : ''}</label>`).join('');
  return `<fieldset class="scope"><legend>Access</legend>
<label><input type="radio" name="reach" value="all"${some ? '' : ' checked'}> All your projects, and new ones</label>
<label><input type="radio" name="reach" value="some"${some ? ' checked' : ''}> Only these projects:</label>
<div class="projects">${list || '<span class="muted">You have no projects yet.</span>'}</div>
<label><input type="checkbox" name="readonly" value="1"${readonly ? ' checked' : ''}> Read only — clone, pull, read and build; no push, edits or comments</label>
</fieldset>`;
}

/** What the form asks for: a scope (null = the whole account), or why it cannot be granted. */
export function scopeFromForm(user: SessionUser, body: Record<string, unknown>): { scope: AccessScope | null } | { error: string } {
  if (!userSettings(user.id).fineGrainedAccess) return { scope: null };
  const readonly = body.readonly === '1';
  let projects: string[] | null = null;
  if (body.reach === 'some') {
    const want = new Set(picked(body.projects));
    projects = accessibleProjects(user, { files: false }).map(p => p.name).filter(n => want.has(n));
    if (!projects.length) return { error: 'Choose at least one project — or All your projects.' };
  }
  return { scope: projects || readonly ? { projects, readonly } : null };
}

/** In words, for the CLI and the authorization pages: "all your projects", "jan/CV, jan/thesis (read only)". */
export function describeScope(scope: AccessScope | null): string {
  if (!scope) return 'all your projects';
  return (scope.projects ? scope.projects.join(', ') || 'no projects' : 'all your projects') + (scope.readonly ? ' (read only)' : '');
}
