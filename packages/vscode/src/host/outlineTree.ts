/**
 * The OverLyX sidebar's Structure tree (LaTeX-Workshop style): the active editor's outline —
 * sections nested by level, floats as leaves — a click moves the cursor there.
 */
import * as vscode from 'vscode';
import type { Registry } from './registry.ts';
import type { OutlineEntry } from '../shared/protocol.ts';

interface Node { entry: OutlineEntry; children: Node[] }

function buildTree(items: OutlineEntry[]): Node[] {
  const roots: Node[] = [];
  const stack: Node[] = [];
  for (const entry of items) {
    const node: Node = { entry, children: [] };
    if (entry.level >= 99) {
      // a float: attach to the innermost open section
      (stack.length ? stack[stack.length - 1].children : roots).push(node);
      continue;
    }
    while (stack.length && stack[stack.length - 1].entry.level >= entry.level) stack.pop();
    (stack.length ? stack[stack.length - 1].children : roots).push(node);
    stack.push(node);
  }
  return roots;
}

export class OutlineTree implements vscode.TreeDataProvider<Node> {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event as vscode.Event<void | Node | Node[] | null | undefined>;
  private roots: Node[] = [];

  constructor(private registry: Registry) {
    registry.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this.roots = buildTree(this.registry.active?.outline ?? []);
    this.emitter.fire();
  }

  getChildren(el?: Node): Node[] { return el ? el.children : this.roots; }

  getTreeItem(n: Node): vscode.TreeItem {
    const e = n.entry;
    const label = e.num ? `${e.num}  ${e.text}` : e.text;
    const item = new vscode.TreeItem(label, n.children.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    item.tooltip = e.layout + (e.text ? ': ' + e.text : '');
    if (e.level >= 99) item.iconPath = new vscode.ThemeIcon(/^Table/i.test(e.text) ? 'table' : 'file-media');
    else if (e.level === 0) item.iconPath = new vscode.ThemeIcon('book');
    else item.iconPath = new vscode.ThemeIcon('symbol-number');
    item.command = { command: 'overlyx.gotoOutline', title: 'Go to', arguments: [e.pos] };
    return item;
  }
}
