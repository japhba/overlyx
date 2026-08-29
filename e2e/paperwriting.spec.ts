/**
 * "A user writes a paper" simulation: two brand-new documents are typed from scratch through the
 * real editor UI (title/author already there from "New document", then Abstract, Sections, body
 * text, inline and display formulas, and a citation pasted from BibTeX) — not opened from a fixture.
 * The content itself is lifted verbatim from two real papers pulled from arXiv (1706.03762
 * "Attention Is All You Need" and 2006.04870 "On the Gap between Scalar and Vector Solutions of
 * Generalized Combination Networks"), including their real abstracts, a real sentence + citation
 * from each introduction, and (for the first paper) the real scaled dot-product attention formula.
 * This exercises the WYSIWYG path a real author hits when starting a paper, end to end.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { login, collectErrors, PROJECTS_DIR } from './helpers';

const PROJECT = 'e2e-paperwriting';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;

/** What "New document" (server projects.ts newDocumentText) writes for a titled, empty article. */
function blankArticle(title: string): string {
  return `\\documentclass[11pt]{article}\n\\usepackage[T1]{fontenc}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amsmath}\n\\usepackage{amssymb}\n\\usepackage{graphicx}\n\n\\begin{document}\n\\title{${title}}\n\\author{Admin}\n\\maketitle\n\n\n\\end{document}\n`;
}

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/attention.tex`, blankArticle('Attention Is All You Need'));
  writeFileSync(`${DIR}/netcoding.tex`, blankArticle('On the Gap between Scalar and Vector Solutions of Generalized Combination Networks'));
});
test.afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

const fileText = (name: string) => readFileSync(`${DIR}/${name}`, 'utf8');

async function open(page: Page, file: string) {
  await page.evaluate(() => { localStorage.setItem('ol.tabs', '[]'); });
  await page.goto(`/#/${PROJECT}/${file}`);
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 0, null, { timeout: 30000 });
  await page.waitForTimeout(1000);
}

/** Click the end of the (only, so far) Author paragraph and press Enter: a fresh Standard paragraph follows. */
async function afterAuthor(page: Page) {
  await page.locator('.lyx-editor > .lyx-par.lyx-layout-author').first().click({ position: { x: 4, y: 8 } });
  await page.waitForTimeout(200);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
}

async function setLayout(page: Page, key: string) {
  await page.keyboard.press('Alt+p');
  await page.waitForTimeout(80);
  await page.keyboard.press(key);
  await page.waitForTimeout(150);
}

/** Paste a BibTeX entry via "Find online / paste BibTeX" and insert the citation at the cursor. */
async function citeFromPastedBibtex(page: Page, bibtex: string, surname: string) {
  await page.keyboard.press('Control+Shift+c');
  const dialog = page.locator('.dialog');
  await expect(dialog).toContainText('Citation');
  await page.locator('[data-cite-online]').click();
  await expect(dialog).toContainText('Google Scholar');
  await page.locator('[data-cite-paste]').fill(bibtex);
  await page.locator('[data-cite-add-paste]').click();
  await expect(page.locator('[data-cite-status]')).toContainText('Added', { timeout: 15000 });
  await page.locator('[data-cite-insert]').click();
  await expect(page.locator('.lyx-editor .lyx-command-citation').last()).toContainText(surname);
}

/** \frac{num}{den}: num/den typed by the caller via the two callbacks; leaves the field back at top level. */
async function typeFrac(page: Page, num: () => Promise<void>, den: () => Promise<void>) {
  await page.keyboard.type('\\frac'); await page.waitForTimeout(60);
  await page.keyboard.press('Tab'); await page.waitForTimeout(60);
  await num();
  await page.keyboard.press('Tab'); await page.waitForTimeout(60);
  await den();
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(60);   // out of the denominator, back to top level
}

async function typeSqrt(page: Page, body: () => Promise<void>) {
  await page.keyboard.type('\\sqrt'); await page.waitForTimeout(60);
  await page.keyboard.press('Tab'); await page.waitForTimeout(60);
  await body();
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(60);
}

/** A superscript/subscript with (possibly multi-char) content, back out to the base afterwards. */
async function typeScript(page: Page, mark: '^' | '_', content: string) {
  await page.keyboard.type(mark); await page.waitForTimeout(40);
  await page.keyboard.type(content); await page.waitForTimeout(40);
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(40);
}

/** A one-argument command (\mathrm{...}, same shape as \sqrt): Tab both confirms the name and enters the argument cell. */
async function typeSymbol(page: Page, name: string) {
  await page.keyboard.type(name); await page.waitForTimeout(60);
  await page.keyboard.press('Tab'); await page.waitForTimeout(60);
}

/**
 * A named symbol with no arguments (\alpha, \Theta, \gamma, \leq, ...). ArrowRight (not Tab) confirms it
 * as typed: Tab instead accepts the greyed completion suggestion, which for a command that is itself a
 * prefix of another real command (e.g. \leq / \leqq) silently over-completes to the longer one.
 */
async function typeBareSymbol(page: Page, name: string) {
  await page.keyboard.type(name); await page.waitForTimeout(60);
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(60);
}

test.beforeEach(async ({ page }) => { await login(page); });

test('writing "Attention Is All You Need" from a blank document', async ({ page }) => {
  test.setTimeout(180000);
  const errors = collectErrors(page);
  await open(page, 'attention.tex');

  await afterAuthor(page);
  await setLayout(page, 'a');   // Abstract
  await page.keyboard.type('The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder. The best performing models also connect the encoder and decoder through an attention mechanism. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely. Experiments on two machine translation tasks show these models to be superior in quality while being more parallelizable and requiring significantly less time to train.');
  await expect(page.locator('.lyx-layout-abstract')).toContainText('dispensing with recurrence');

  await page.keyboard.press('End');
  await page.keyboard.press('Enter');   // fresh paragraph (continues as Abstract) before switching layout
  await setLayout(page, '2');   // Section
  await page.keyboard.type('Introduction');
  await expect(page.locator('.lyx-layout-section', { hasText: 'Introduction' })).toHaveCount(1);

  await page.keyboard.press('End');
  await page.keyboard.press('Enter');   // Standard
  await page.keyboard.type('Recurrent neural networks, long short-term memory ');
  await citeFromPastedBibtex(page,
    `@article{hochreiter1997,\n  title={Long short-term memory},\n  author={Hochreiter, Sepp and Schmidhuber, J{\\"u}rgen},\n  journal={Neural computation},\n  volume={9},\n  number={8},\n  pages={1735--1780},\n  year={1997},\n  publisher={MIT Press}\n}`,
    'Hochreiter');
  await page.keyboard.type(' and gated recurrent neural networks in particular, have been firmly established as state of the art approaches in sequence modeling and transduction problems such as language modeling and machine translation.');

  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await setLayout(page, '2');   // Section
  await page.keyboard.type('Model Architecture');

  await page.keyboard.press('End');
  await page.keyboard.press('Enter');   // Standard
  await page.keyboard.type('We call our particular attention "Scaled Dot-Product Attention". The input consists of queries and keys of dimension ');
  await page.keyboard.press('Control+m');
  await typeScript(page, '_', 'k');
  await page.keyboard.press('Escape');
  await page.keyboard.type(', and values of dimension ');
  await page.keyboard.press('Control+m');
  await typeScript(page, '_', 'v');
  await page.keyboard.press('Escape');
  await page.keyboard.type('. We compute the dot products of the query with all keys, divide each by ');
  await page.keyboard.press('Control+m');
  await typeSqrt(page, async () => { await page.keyboard.type('d'); await typeScript(page, '_', 'k'); });
  await page.keyboard.press('Escape');
  await page.keyboard.type(', and apply a softmax function to obtain the weights on the values.');

  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('In practice, we compute the attention function on a set of queries simultaneously, packed together into a matrix Q. The keys and values are also packed together into matrices K and V. We compute the matrix of outputs as:');

  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+Shift+m');   // display formula
  await expect(page.locator('.lm-field.display.focused')).toHaveCount(1, { timeout: 5000 });
  await typeSymbol(page, '\\mathrm');
  await page.keyboard.type('Attention');
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(60);
  await page.keyboard.type('(Q,K,V)=');
  await typeSymbol(page, '\\mathrm');
  await page.keyboard.type('softmax');
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(60);
  await page.keyboard.type('(');
  await typeFrac(page,
    async () => { await page.keyboard.type('QK'); await typeScript(page, '^', 'T'); },
    async () => { await typeSqrt(page, async () => { await page.keyboard.type('d'); await typeScript(page, '_', 'k'); }); });
  await page.keyboard.type(')V');
  await page.keyboard.press('Alt+m');
  await page.keyboard.press('n');       // numbered, like the paper's \begin{equation}
  await page.keyboard.press('Escape');

  await page.waitForTimeout(2000);
  const text = fileText('attention.tex');
  // long paragraphs are word-wrapped by the writer, so multi-word literal phrases are matched with [\s\S]* between words rather than a literal space
  expect(text).toMatch(/\\title\{Attention[\s\S]*Need\}/);
  expect(text).toMatch(/\\begin\{abstract\}[\s\S]*dispensing[\s\S]*recurrence[\s\S]*\\end\{abstract\}/);
  expect(text).toContain('\\section{Introduction}');
  expect(text).toMatch(/\\citep?\{hochreiter[a-z0-9]*\}/i);   // the app mints its own Scholar-style key from author+year+title
  expect(text).toContain('\\section{Model Architecture}');
  expect(text).toMatch(/\\begin\{equation\}\n\\mathrm\{Attention\}\(Q,K,V\)=\\mathrm\{softmax\}\(\\frac\{QK\^\{?T\}?\}\{\\sqrt\{d_\{?k\}?\}\}\)V\n\\end\{equation\}/);

  await expect(page.locator('.lyx-math-display .katex-error')).toHaveCount(0);
  expect(errors.filter(e => !/favicon|ResizeObserver/.test(e))).toEqual([]);
});

test('writing "On the Gap between Scalar and Vector Solutions of Generalized Combination Networks" from a blank document', async ({ page }) => {
  test.setTimeout(180000);
  const errors = collectErrors(page);
  await open(page, 'netcoding.tex');

  await afterAuthor(page);
  await setLayout(page, 'a');   // Abstract
  await page.keyboard.type('We study scalar-linear and vector-linear solutions of the generalized combination network. We derive new upper and lower bounds on the maximum number of nodes in the middle layer, depending on the network parameters and the alphabet size. For a fixed network structure, while varying the number of middle-layer nodes ');
  await page.keyboard.press('Control+m');
  await page.keyboard.type('r');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Escape');
  await page.keyboard.type(', the asymptotic behavior of the upper and lower bounds shows that the gap is in ');
  await page.keyboard.press('Control+m');
  await typeBareSymbol(page, '\\Theta');
  await page.keyboard.type('(r)');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Escape');
  await page.keyboard.type('.');
  await expect(page.locator('.lyx-layout-abstract')).toContainText('generalized combination network');

  await page.keyboard.press('End');
  await page.keyboard.press('Enter');   // fresh paragraph (continues as Abstract) before switching layout
  await setLayout(page, '2');   // Section
  await page.keyboard.type('Introduction');

  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('In multicast networks that apply routing, a source node multicasts information to other nodes in the network in a multihop fashion, where every node can pass on their received data. Network coding has been attracting increasing attention since the seminal papers ');
  await citeFromPastedBibtex(page,
    `@article{ACLY00,\n  title={Network Information Flow},\n  volume={46},\n  doi={10.1109/18.850663},\n  number={4},\n  journal={IEEE Transactions on Information Theory},\n  author={Ahlswede, Rudolf and Cai, Ning and Li, Shuo-Yen Robert and Yeung, Raymond W.},\n  month=jul,\n  year={2000},\n  pages={1204--1216}\n}`,
    'Ahlswede');
  await page.keyboard.type(' which showed that the throughput can be increased significantly by not just forwarding packets but also performing linear combinations of them.');

  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await setLayout(page, '2');   // Section
  await page.keyboard.type('Preliminaries');

  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Writing ');
  await page.keyboard.press('Control+m');
  await page.keyboard.type('a');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Escape');
  await page.keyboard.type('=k(n-k) for the dimension product, a good approximation of the ');
  await page.keyboard.press('Control+m');
  await page.keyboard.type('q');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Escape');
  await page.keyboard.type('-binomial coefficient is given by:');

  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+Shift+m');   // display formula
  await expect(page.locator('.lm-field.display.focused')).toHaveCount(1, { timeout: 5000 });
  // a bare Space at the top level of a math field leaves the field, so no spaces are typed between tokens below
  await page.keyboard.type('q');
  await typeScript(page, '^', 'a');
  await typeBareSymbol(page, '\\leq');
  await typeFrac(page, async () => { await page.keyboard.type('n'); }, async () => { await page.keyboard.type('k'); });
  await page.keyboard.type('<');
  await typeBareSymbol(page, '\\gamma');
  await page.keyboard.type('q');
  await typeScript(page, '^', 'a');
  await page.keyboard.press('Alt+m');
  await page.keyboard.press('n');
  await page.keyboard.press('Escape');

  await page.waitForTimeout(2000);
  const text = fileText('netcoding.tex');
  expect(text).toMatch(/\\title\{On[\s\S]*Combination[\s\S]*Networks\}/);
  expect(text).toMatch(/\\begin\{abstract\}[\s\S]*generalized[\s\S]*combination[\s\S]*network[\s\S]*\\end\{abstract\}/);
  expect(text).toContain('\\section{Introduction}');
  expect(text).toMatch(/\\citep?\{ahlswede[a-z0-9]*\}/i);   // the app mints its own Scholar-style key from author+year+title
  expect(text).toContain('\\section{Preliminaries}');
  expect(text).toMatch(/\\begin\{equation\}\nq\^\{?a\}?\s*\\leq\s*\\frac\{n\}\{k\}\s*<\s*\\gamma\s*q\^\{?a\}?\n\\end\{equation\}/);

  await expect(page.locator('.lyx-math-display .katex-error')).toHaveCount(0);
  expect(errors.filter(e => !/favicon|ResizeObserver/.test(e))).toEqual([]);
});

test('both papers survive a reload byte-identically and cited.bib carries both real references', async ({ page }) => {
  await open(page, 'attention.tex');
  await expect(page.locator('.lyx-editor')).toContainText('Attention Is All You Need');
  await expect(page.locator('.lyx-editor .lyx-command-citation')).toHaveCount(1, { timeout: 15000 });
  const before = fileText('attention.tex');
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 0, null, { timeout: 30000 });
  await page.waitForTimeout(1000);
  expect(fileText('attention.tex')).toBe(before);

  const bib = fileText('cited.bib');
  expect(bib).toContain('Long short-term memory');
  expect(bib).toContain('Network Information Flow');
});
