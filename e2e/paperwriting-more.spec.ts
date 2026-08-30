/**
 * Another "a user writes a paper" simulation (see paperwriting.spec.ts): the first pages of
 * 1810.04805 "BERT" typed from a blank document through the real editor UI — a bulleted list of
 * contributions, emphasis, a footnote, subsections, inline math inside running text and table
 * cells, a small results table typed cell by cell, two pasted citations — then a reload check.
 * Whole papers, every section from the abstract to the bibliography (theorems, floats with
 * uploaded figures, algorithm floats, aligns, forward references, a PDF build):
 * paperwriting-gan.spec.ts and paperwriting-adam.spec.ts.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { login, collectErrors, PROJECTS_DIR } from './helpers';
import { blankArticle, openPaper, afterAuthor, setLayout, newParagraph, citeFromPastedBibtex, inlineMath, typeBareSymbol } from './papertyping';

const PROJECT = 'e2e-paperwriting-more';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;

/**
 * The paper starts from the blank document "New document" writes, created by its own test: Playwright
 * restarts the worker after a failed test, which would re-run a beforeAll and wipe what was typed so far
 * (the last test reloads the file). The test also starts a fresh cited.bib.
 */
function freshPaper(file: string, title: string, opts: { resetBib?: boolean } = {}) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/${file}`, blankArticle(title));
  if (opts.resetBib) rmSync(`${DIR}/cited.bib`, { force: true });
}
test.afterAll(() => { if (!process.env.OVERLYX_E2E_KEEP) rmSync(DIR, { recursive: true, force: true }); });   // OVERLYX_E2E_KEEP=1 leaves the typed papers on disk for inspection

const fileText = (name: string) => readFileSync(`${DIR}/${name}`, 'utf8');
const open = (page: Page, file: string) => openPaper(page, PROJECT, file);
const noErrors = (errors: string[]) => errors.filter(e => !/favicon|ResizeObserver/.test(e));

async function emph(page: Page, text: string) {
  await page.keyboard.press('Control+e'); await page.keyboard.type(text); await page.keyboard.press('Control+e');
}
/** A single-letter inline formula ($L$, $\theta$, ...). */
async function mathVar(page: Page, name: string) {
  await inlineMath(page, async () => { if (name.startsWith('\\')) await typeBareSymbol(page, name); else await page.keyboard.type(name); });
}

test.beforeEach(async ({ page }) => { await login(page); });

test('writing "BERT" from a blank document: lists, footnote, emphasis, subsections and a results table', async ({ page }) => {
  test.setTimeout(240000);
  const errors = collectErrors(page);
  freshPaper('bert.tex', 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding', { resetBib: true });
  await open(page, 'bert.tex');

  await afterAuthor(page);
  await setLayout(page, 'a');   // Abstract
  await page.keyboard.type('We introduce a new language representation model called BERT, which stands for Bidirectional Encoder Representations from Transformers. Unlike recent language representation models, BERT is designed to pre-train deep bidirectional representations from unlabeled text by jointly conditioning on both left and right context in all layers. As a result, the pre-trained BERT model can be fine-tuned with just one additional output layer to create state-of-the-art models for a wide range of tasks, such as question answering and language inference, without substantial task-specific architecture modifications. BERT is conceptually simple and empirically powerful. It obtains new state-of-the-art results on eleven natural language processing tasks, including pushing the GLUE score to 80.5% (7.7% point absolute improvement), MultiNLI accuracy to 86.7% (4.6% absolute improvement), SQuAD v1.1 question answering Test F1 to 93.2 (1.5 point absolute improvement) and SQuAD v2.0 Test F1 to 83.1 (5.1 point absolute improvement).');
  await expect(page.locator('.lyx-layout-abstract')).toContainText('eleven natural language processing tasks');

  await newParagraph(page);
  await setLayout(page, '2');   // Section
  await page.keyboard.type('Introduction');
  await newParagraph(page);     // Standard
  await page.keyboard.type('Language model pre-training has been shown to be effective for improving many natural language processing tasks ');
  await citeFromPastedBibtex(page,
    `@inproceedings{peters2018deep,\n  title={Deep contextualized word representations},\n  author={Peters, Matthew E. and Neumann, Mark and Iyyer, Mohit and Gardner, Matt and Clark, Christopher and Lee, Kenton and Zettlemoyer, Luke},\n  booktitle={Proceedings of NAACL-HLT},\n  pages={2227--2237},\n  year={2018}\n}`,
    'Peters');
  await page.keyboard.type('. These include sentence-level tasks such as natural language inference and paraphrasing, which aim to predict the relationships between sentences by analyzing them holistically, as well as token-level tasks such as named entity recognition and question answering, where models are required to produce fine-grained output at the token level.');
  await newParagraph(page);
  await page.keyboard.type('The contributions of our paper are as follows:');

  await newParagraph(page);
  await setLayout(page, 'i');   // Itemize
  await page.keyboard.type('We demonstrate the importance of bidirectional pre-training for language representations. Unlike ');
  await citeFromPastedBibtex(page,
    `@misc{radford2018improving,\n  title={Improving language understanding by generative pre-training},\n  author={Radford, Alec and Narasimhan, Karthik and Salimans, Tim and Sutskever, Ilya},\n  year={2018},\n  note={OpenAI}\n}`,
    'Radford');
  await page.keyboard.type(', which uses unidirectional language models for pre-training, BERT uses masked language models to enable pre-trained deep bidirectional representations.');
  await newParagraph(page);     // next item
  await page.keyboard.type('We show that pre-trained representations reduce the need for many heavily-engineered task-specific architectures. BERT is the first fine-tuning based representation model that achieves state-of-the-art performance on a large suite of sentence-level and token-level tasks, outperforming many task-specific architectures.');
  await newParagraph(page);
  await page.keyboard.type('BERT advances the state of the art for eleven NLP tasks. The code and pre-trained models are available at https://github.com/google-research/bert.');
  await expect(page.locator('.lyx-layout-itemize')).toHaveCount(3);

  await newParagraph(page);     // a fourth (empty) item ...
  await setLayout(page, '2');   // ... becomes the next Section
  await page.keyboard.type('BERT');
  await newParagraph(page);
  await page.keyboard.type('We introduce BERT and its detailed implementation in this section. There are two steps in our framework: ');
  await emph(page, 'pre-training');
  await page.keyboard.type(' and ');
  await emph(page, 'fine-tuning');
  await page.keyboard.type('.');

  await newParagraph(page);
  await setLayout(page, '3');   // Subsection
  await page.keyboard.type('Model Architecture');
  await newParagraph(page);
  await page.keyboard.type('In this work, we denote the number of layers (i.e., Transformer blocks) as ');
  await mathVar(page, 'L');
  await page.keyboard.type(', the hidden size as ');
  await mathVar(page, 'H');
  await page.keyboard.type(', and the number of self-attention heads as ');
  await mathVar(page, 'A');
  await page.keyboard.press('Control+Alt+f');   // footnote
  await page.keyboard.type('In all cases we set the feed-forward/filter size to be 4H, i.e., 3072 for the H = 768 and 4096 for the H = 1024.');
  await page.keyboard.press('Escape');
  await page.keyboard.type('. We primarily report results on two model sizes: BERT');
  await inlineMath(page, async () => { await page.keyboard.type('_BASE'); });
  await page.keyboard.type(' (L=12, H=768, A=12, Total Parameters=110M) and BERT');
  await inlineMath(page, async () => { await page.keyboard.type('_LARGE'); });
  await page.keyboard.type(' (L=24, H=1024, A=16, Total Parameters=340M).');

  await newParagraph(page);
  await setLayout(page, '2');
  await page.keyboard.type('Experiments');
  await newParagraph(page);
  await setLayout(page, '3');
  await page.keyboard.type('GLUE');
  await newParagraph(page);
  await page.keyboard.type('Results are presented in Table 1. Both BERT');
  await inlineMath(page, async () => { await page.keyboard.type('_BASE'); });
  await page.keyboard.type(' and BERT');
  await inlineMath(page, async () => { await page.keyboard.type('_LARGE'); });
  await page.keyboard.type(' outperform all systems on all tasks by a substantial margin, obtaining 4.5% and 7.0% respective average accuracy improvement over the prior state of the art.');

  // a 4 × 3 results table (Table 1, MNLI and QQP columns), typed cell by cell with Tab
  await newParagraph(page);
  await page.keyboard.press('Control+Alt+t');
  const dialog = page.locator('.dialog');
  await expect(dialog).toContainText('Insert Table');
  await dialog.locator('.row', { hasText: 'Rows' }).locator('input').fill('4');
  await dialog.locator('.btn.primary').click();
  await expect(page.locator('.lyx-tabular td')).toHaveCount(12);
  const cells = ['System', 'MNLI', 'QQP', 'BiLSTM+ELMo+Attn', '76.4', '64.8', null, '84.6', '71.2', null, '86.7', '72.1'];
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (c === null) {
      await page.keyboard.type('BERT');
      await inlineMath(page, async () => { await page.keyboard.type(i === 6 ? '_BASE' : '_LARGE'); });
    } else await page.keyboard.type(c);
    if (i < cells.length - 1) { await page.keyboard.press('Tab'); await page.waitForTimeout(40); }
  }
  await expect(page.locator('.lyx-tabular td').nth(11)).toContainText('72.1');
  await expect(page.locator('.lyx-tabular td').nth(9).locator('.lm-static, .lm-field')).toHaveCount(1);

  await page.waitForTimeout(2000);
  const text = fileText('bert.tex');
  expect(text).toMatch(/\\title\{BERT:[\s\S]*Language[\s\S]*Understanding\}/);
  expect(text).toMatch(/\\begin\{abstract\}[\s\S]*Bidirectional[\s\S]*Encoder[\s\S]*Representations[\s\S]*80\.5\\%[\s\S]*\\end\{abstract\}/);   // % is escaped in the file
  expect(text).toContain('\\section{Introduction}');
  expect(text).toMatch(/processing tasks \\citep?\{peters[a-z0-9]*\}\./i);
  expect(text).toMatch(/\\begin\{itemize\}\n\\item We demonstrate[\s\S]*Unlike \\citep?\{radford[a-z0-9]*\}, which[\s\S]*\n\\item We show[\s\S]*\n\\item BERT advances[\s\S]*google-research\/bert\.\n\\end\{itemize\}/i);
  expect(text).toContain('\\section{BERT}');
  expect(text).toMatch(/framework: \\emph\{pre-training\} and \\emph\{fine-tuning\}\./);
  expect(text).toContain('\\subsection{Model Architecture}');
  expect(text).toMatch(/blocks\) as \$L\$, the hidden size as \$H\$, and the number of self-attention heads as \$A\$\\footnote\{In all cases[\s\S]*H = 1024\.\}\. We primarily/);
  expect(text).toMatch(/BERT\$_\{BASE\}\$ \(L=12, H=768, A=12, Total Parameters=110M\) and BERT\$_\{LARGE\}\$ \(L=24/);
  expect(text).toContain('\\section{Experiments}');
  expect(text).toContain('\\subsection{GLUE}');
  const rows = ['System & MNLI & QQP', 'BiLSTM\\+ELMo\\+Attn & 76\\.4 & 64\\.8', 'BERT\\$_\\{BASE\\}\\$ & 84\\.6 & 71\\.2', 'BERT\\$_\\{LARGE\\}\\$ & 86\\.7 & 72\\.1'];
  expect(text).toMatch(new RegExp('\\\\begin\\{tabular\\}\\{\\|c\\|c\\|c\\|\\}\\n\\\\hline\\s*' + rows.join('\\\\tabularnewline\\n\\\\hline\\s*') + '\\\\tabularnewline\\n\\\\hline\\s*\\\\end\\{tabular\\}'));

  await expect(page.locator('.katex-error')).toHaveCount(0);
  expect(noErrors(errors)).toEqual([]);
});

test('the paper survives a reload byte-identically and cited.bib carries every pasted reference', async ({ page }) => {
  for (const file of ['bert.tex']) {
    await open(page, file);
    await expect(page.locator('.lyx-editor .lyx-command-citation').first()).toBeVisible({ timeout: 15000 });
    const before = fileText(file);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 0, null, { timeout: 30000 });
    await page.waitForTimeout(1500);
    expect(fileText(file)).toBe(before);
  }
  const bib = fileText('cited.bib');
  for (const title of ['Deep contextualized word representations', 'Improving language understanding by generative pre-training']) expect(bib).toContain(title);
});
