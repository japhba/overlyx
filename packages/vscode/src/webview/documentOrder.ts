import type { Node } from 'prosemirror-model';
import { includeTarget } from '@client/editor/commands';
import { projectOfDoc, docDirOf } from '@overlyx/core';

/** Traverse includes in document order; repeated includes and cycles get one editor per file. */
export function documentOrder(root: string, documents: Map<string, Node>): string[] {
  const ids: string[] = [];
  const visit = (id: string) => {
    if (ids.includes(id)) return;
    ids.push(id);
    const project = projectOfDoc(id), dir = docDirOf(id);
    documents.get(id)?.descendants(node => {
      let child = includeTarget(node, project, dir);
      if (child && !/\.[A-Za-z0-9]+$/.test(child)) child += '.tex';
      if (child?.endsWith('.tex')) visit(child);
    });
  };
  visit(root);
  return ids;
}
