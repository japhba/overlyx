/** Actual comparison callback: HTTP/transport failures resolve with a visible retry alert, then comparison works. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { it, expect } from 'vitest';

it('handles both comparison fetch failures without escaping the event handler, clears stale output and can retry', async () => {
  const source = readFileSync('packages/client/src/app/Versions.tsx', 'utf8');
  const ast = ts.createSourceFile('actual.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const diff = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'diffLines');
  let callback: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'showDiff') callback = node;
    ts.forEachChild(node, visit);
  };
  visit(ast); assert.ok(diff && callback);
  const code = ts.transpileModule(diff.getText(ast) + '\nconst ' + callback.getText(ast) + ';\nglobalThis.showDiff = showDiff;', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  for (const failAt of ['old', 'current']) {
    const error = Object.assign(new Error('CONTROL_PRIVATE_RESPONSE_DETAIL'), { status: 503 });
    const alerts: { title: string; message: string }[] = [];
    let result: unknown = { name: 'prior comparison' }, failed = true;
    const scope = createContext({ docId: 'fictional/study/source.tex',
      api: {
        getVersion: async () => { if (failed && failAt === 'old') throw error; return { lyx: 'before\nsame' }; },
        texText: async () => { if (failed && failAt === 'current') throw error; return 'after\nsame'; },
      },
      setDiff: (value: unknown) => { result = value; },
      uiAlert: async (title: string, message: string) => { alerts.push({ title, message }); },
    });
    runInContext(code, scope);
    await expect(scope.showDiff({ id: 1, name: 'Your Name' })).resolves.toBeUndefined();
    expect(result).toBeNull(); expect(alerts).toEqual([{ title: 'Could Not Compare Versions',
      message: 'The comparison could not be loaded. Try again when the server is available.' }]);
    failed = false;
    await expect(scope.showDiff({ id: 1, name: 'Your Name' })).resolves.toBeUndefined();
    expect(JSON.parse(JSON.stringify(result))).toEqual({ name: 'Your Name', lines: [
      { type: 'del', text: 'before' }, { type: 'add', text: 'after' }, { type: 'same', text: 'same' },
    ] });
    expect(alerts).toHaveLength(1);
  }
});
