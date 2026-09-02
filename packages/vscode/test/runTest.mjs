/**
 * Integration test: downloads VS Code (cached in .vscode-test/), starts it headless with this
 * extension and a scratch LaTeX workspace, and runs test/suite/index.cjs inside the extension
 * host. Run under xvfb: `xvfb-run -a node test/runTest.mjs`.
 */
import { runTests } from '@vscode/test-electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MAIN = `\\documentclass{article}
\\usepackage{amsmath,amssymb}
\\newcommand{\\RR}{\\mathbb{R}}
\\begin{document}

\\section{Introduction}

Functions on $\\RR$ are studied, see \\eqref{eq:main}.

\\begin{equation}
f(x)=x^{2}\\label{eq:main}
\\end{equation}

\\input{chapter.tex}

\\end{document}
`;
const CHILD = `\\section{Details}

More text with a formula $a+b$.
`;

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-vscode-ws-'));
fs.writeFileSync(path.join(ws, 'main.tex'), MAIN);
fs.writeFileSync(path.join(ws, 'chapter.tex'), CHILD);
fs.writeFileSync(path.join(ws, 'refs.bib'), '@article{knuth84, author={Donald E. Knuth}, title={Literate Programming}, year={1984}, journal={The Computer Journal}}\n');

try {
  await runTests({
    extensionDevelopmentPath: pkg,
    extensionTestsPath: path.join(pkg, 'test/suite/index.cjs'),
    launchArgs: [ws, '--disable-workspace-trust', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-extensions'],
    cachePath: path.join(pkg, '.vscode-test'),
    extensionTestsEnv: { OVERLYX_TEST_WS: ws },
  });
  console.log('integration test PASSED');
} catch (e) {
  console.error('integration test FAILED', e);
  process.exit(1);
} finally {
  fs.rmSync(ws, { recursive: true, force: true });
}
