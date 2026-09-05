export interface ModuleInfo { id: string; title: string; description: string; requires: string[]; excludes: string[] }

export function moduleWarnings(selected: string[], available: ModuleInfo[]): string[] {
  const messages = new Set<string>();
  for (const id of selected) {
    const module = available.find(m => m.id === id);
    if (!module) { messages.add(`Module “${id}” was not found.`); continue; }
    if (module.requires.length && !module.requires.some(r => selected.includes(r))) messages.add(`${module.title} requires ${module.requires.join(' or ')}.`);
    for (const other of module.excludes) if (selected.includes(other)) messages.add(`${module.title} cannot be combined with ${available.find(m => m.id === other)?.title ?? other}.`);
  }
  return [...messages];
}
