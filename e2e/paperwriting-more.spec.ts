/**
 * More "a user writes a paper" simulations (see paperwriting.spec.ts): three brand-new documents
 * typed from scratch through the real editor UI, their content lifted verbatim from three real
 * papers pulled from arXiv — 1810.04805 "BERT", 1406.2661 "Generative Adversarial Networks" and
 * 1412.6980 "Adam". Each exercises a different slice of what an author needs beyond prose and
 * simple formulas:
 *  - BERT: a bulleted list of contributions, emphasis, a footnote, subsections, inline math inside
 *    running text and table cells, a small results table typed cell by cell, two pasted citations;
 *  - GANs: the minimax value function (\min/\max with limits, \mathbb, \sim, \log, nested
 *    subscripts), a numbered equation given a label through its label chip, a theorem-style
 *    paragraph with a fraction, a \ref back to the equation, a BibTeX bibliography inset, and a
 *    full latexmk build whose PDF text is checked (equation number and citation resolved);
 *  - Adam: the update rules as a five-row align (Tab/Enter/Shift+Tab for columns and rows),
 *    \hat, \sqrt, \leftarrow, \cdot, scripts on Greek letters, 10^{-8} inline, an \eqref to the
 *    labelled align, and the outline panel listing the sections.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { login, collectErrors, PROJECTS_DIR } from './helpers';
import {
  blankArticle, openPaper, afterAuthor, setLayout, newParagraph, citeFromPastedBibtex, typeFrac, typeSqrt, typeScript, typeScriptWith,
  typeCommandArg, typeBareSymbol, inlineMath, startDisplayMath, startAlign, labelLastEquation, insertRef, insertBibliography,
} from './papertyping';

const PROJECT = 'e2e-paperwriting-more';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;
const TMP = process.env.CLAUDE_JOB_DIR ? `${process.env.CLAUDE_JOB_DIR}/tmp` : '/tmp';

/**
 * Each paper starts from the blank document "New document" writes, created by its own test: Playwright
 * restarts the worker after a failed test, which would re-run a beforeAll and wipe the papers typed so far
 * (the last test reloads all three). The first test also starts a fresh cited.bib.
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
async function bold(page: Page, text: string) {
  await page.keyboard.press('Control+b'); await page.keyboard.type(text); await page.keyboard.press('Control+b');
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

test('writing "Generative Adversarial Networks" from a blank document: the minimax game, a labelled equation, \\ref, bibliography and a PDF build', async ({ page }) => {
  test.setTimeout(420000);
  const errors = collectErrors(page);
  freshPaper('gan.tex', 'Generative Adversarial Networks');
  await open(page, 'gan.tex');

  await afterAuthor(page);
  await setLayout(page, 'a');
  await page.keyboard.type('We propose a new framework for estimating generative models via an adversarial process, in which we simultaneously train two models: a generative model G that captures the data distribution, and a discriminative model D that estimates the probability that a sample came from the training data rather than G. The training procedure for G is to maximize the probability of D making a mistake. This framework corresponds to a minimax two-player game. In the space of arbitrary functions G and D, a unique solution exists, with G recovering the training data distribution and D equal to 1/2 everywhere. In the case where G and D are defined by multilayer perceptrons, the entire system can be trained with backpropagation. There is no need for any Markov chains or unrolled approximate inference networks during either training or generation of samples. Experiments demonstrate the potential of the framework through qualitative and quantitative evaluation of the generated samples.');
  await expect(page.locator('.lyx-layout-abstract')).toContainText('minimax two-player game');

  await newParagraph(page);
  await setLayout(page, '2');
  await page.keyboard.type('Introduction');
  await newParagraph(page);
  await page.keyboard.type('The promise of deep learning is to discover rich, hierarchical models ');
  await citeFromPastedBibtex(page,
    `@article{bengio2009learning,\n  title={Learning deep architectures for AI},\n  author={Bengio, Yoshua},\n  journal={Foundations and Trends in Machine Learning},\n  volume={2},\n  number={1},\n  pages={1--127},\n  year={2009}\n}`,
    'Bengio');
  await page.keyboard.type(' that represent probability distributions over the kinds of data encountered in artificial intelligence applications, such as natural images, audio waveforms containing speech, and symbols in natural language corpora. We propose a new generative model estimation procedure that sidesteps these difficulties.');
  await page.keyboard.press('Control+Alt+f');
  await page.keyboard.type('All code and hyperparameters available at http://www.github.com/goodfeli/adversarial');
  await page.keyboard.press('Escape');

  await newParagraph(page);
  await setLayout(page, '2');
  await page.keyboard.type('Adversarial nets');
  await newParagraph(page);
  await page.keyboard.type('In other words, ');
  await mathVar(page, 'D');
  await page.keyboard.type(' and ');
  await mathVar(page, 'G');
  await page.keyboard.type(' play the following two-player minimax game with value function ');
  await inlineMath(page, async () => { await page.keyboard.type('V(G,D)'); });
  await page.keyboard.type(':');

  // min_G max_D V(D,G) = E_{x~p_data(x)}[log D(x)] + E_{z~p_z(z)}[log(1-D(G(z)))]   (numbered, labelled eq:minimax)
  await startDisplayMath(page);
  await page.keyboard.type('\\min'); await typeScript(page, '_', 'G');
  await page.keyboard.type('\\max'); await typeScript(page, '_', 'D');
  await page.keyboard.type('V(D,G)=');
  await typeCommandArg(page, '\\mathbb', 'E');
  await typeScriptWith(page, '_', async () => {
    await page.keyboard.type('x'); await typeBareSymbol(page, '\\sim'); await page.keyboard.type('p'); await typeScript(page, '_', 'data'); await page.keyboard.type('(x)');
  });
  await page.keyboard.type('['); await typeBareSymbol(page, '\\log'); await page.keyboard.type('D(x)]+');
  await typeCommandArg(page, '\\mathbb', 'E');
  await typeScriptWith(page, '_', async () => {
    await page.keyboard.type('z'); await typeBareSymbol(page, '\\sim'); await page.keyboard.type('p'); await typeScript(page, '_', 'z'); await page.keyboard.type('(z)');
  });
  await page.keyboard.type('['); await typeBareSymbol(page, '\\log'); await page.keyboard.type('(1-D(G(z)))]');
  await page.keyboard.press('Alt+m'); await page.keyboard.press('n');   // numbered
  await page.keyboard.press('Escape');
  await labelLastEquation(page, 'eq:minimax');

  await newParagraph(page);
  await setLayout(page, '2');
  await page.keyboard.type('Theoretical Results');
  await newParagraph(page);
  await setLayout(page, '3');
  await page.keyboard.type('Global Optimality of ');
  await inlineMath(page, async () => { await page.keyboard.type('p'); await typeScript(page, '_', 'g'); await page.keyboard.type('=p'); await typeScript(page, '_', 'data'); });
  await newParagraph(page);
  await page.keyboard.type('We first consider the optimal discriminator ');
  await mathVar(page, 'D');
  await page.keyboard.type(' for any given generator ');
  await mathVar(page, 'G');
  await page.keyboard.type('.');
  await newParagraph(page);
  await bold(page, 'Proposition 1.');
  await page.keyboard.type(' ');
  // one emphasized run with formulas inside: the formulas take the font, typing after them stays emphasized (LyX)
  await page.keyboard.press('Control+e');
  await page.keyboard.type('For ');
  await mathVar(page, 'G');
  await page.keyboard.type(' fixed, the optimal discriminator ');
  await mathVar(page, 'D');
  await page.keyboard.type(' is');
  await page.keyboard.press('Control+e');
  // D^*_G(x) = p_data(x) / (p_data(x) + p_g(x))
  await startDisplayMath(page);
  await page.keyboard.type('D'); await typeScript(page, '^', '*'); await typeScript(page, '_', 'G'); await page.keyboard.type('(x)=');
  await typeFrac(page,
    async () => { await page.keyboard.type('p'); await typeScript(page, '_', 'data'); await page.keyboard.type('(x)'); },
    async () => { await page.keyboard.type('p'); await typeScript(page, '_', 'data'); await page.keyboard.type('(x)+p'); await typeScript(page, '_', 'g'); await page.keyboard.type('(x)'); });
  await page.keyboard.press('Alt+m'); await page.keyboard.press('n');
  await page.keyboard.press('Escape');

  await newParagraph(page);
  await page.keyboard.type('The minimax game in Eq. ');
  await insertRef(page, 'eq:minimax', 'ref');
  await page.keyboard.type(' can now be reformulated as:');
  await startDisplayMath(page);
  await page.keyboard.type('C(G)=\\max'); await typeScript(page, '_', 'D'); await page.keyboard.type('V(G,D)');
  await page.keyboard.press('Escape');

  // the bibliography: cited.bib (written by the citation dialog) printed with the plain style
  await newParagraph(page);
  await insertBibliography(page, 'cited', 'plain');

  await page.waitForTimeout(2000);
  const text = fileText('gan.tex');
  expect(text).toMatch(/\\begin\{abstract\}[\s\S]*adversarial process[\s\S]*\\end\{abstract\}/);
  expect(text).toMatch(/hierarchical models \\citep?\{bengio[a-z0-9]*\} that represent/i);
  expect(text).toMatch(/these difficulties\.\\footnote\{All code and hyperparameters available at http:\/\/www\.github\.com\/goodfeli\/adversarial\}/);
  expect(text).toContain('\\section{Adversarial nets}');
  expect(text).toMatch(/In other words, \$D\$ and \$G\$ play the following two-player minimax game with value function \$V\(G,D\)\$:/);
  expect(text).toMatch(/\\begin\{equation\}\n\\min_\{G\}\\max_\{D\}V\(D,G\)=\\mathbb\{E\}_\{x\\sim p_\{data\}\(x\)\}\[\\log D\(x\)\]\+\\mathbb\{E\}_\{z\\sim p_\{z\}\(z\)\}\[\\log\(1-D\(G\(z\)\)\)\]\\label\{eq:minimax\}\n\\end\{equation\}/);
  expect(text).toContain('\\section{Theoretical Results}');
  expect(text).toMatch(/\\subsection\{Global Optimality of \$p_\{g\}=p_\{data\}\$\}/);
  expect(text).toMatch(/\\textbf\{Proposition 1\.\} \\emph\{For \$G\$ fixed, the optimal discriminator \$D\$ is\}/);
  expect(text).toMatch(/\\begin\{equation\}\nD(\^\{\*\}_\{G\}|_\{G\}\^\{\*\})\(x\)=\\frac\{p_\{data\}\(x\)\}\{p_\{data\}\(x\)\+p_\{g\}\(x\)\}\n\\end\{equation\}/);
  expect(text).toMatch(/The minimax game in Eq\. \\ref\{eq:minimax\} can now be reformulated as:/);
  expect(text).toMatch(/\\\[\nC\(G\)=\\max_\{D\}V\(G,D\)\n\\\]/);
  expect(text).toMatch(/\\bibliographystyle\{plain\}\s*\\bibliography\{cited\}/);
  expect(fileText('cited.bib')).toContain('Learning deep architectures for AI');
  await expect(page.locator('.katex-error')).toHaveCount(0);

  // build the PDF: the equation is numbered (1), the \ref resolves to it and the citation is printed
  await page.locator('.tb-btn[title^="View PDF"]').click();
  await expect(page.locator('.pdf-panel .build-progress')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.pdf-panel .build-progress')).toHaveCount(0, { timeout: 300000 });
  await expect(page.locator('.pdf-panel .bar span')).toContainText('built');
  await expect(page.locator('.pdf-panel iframe')).toHaveCount(1);
  const res = await page.request.get(`/api/docs/${encodeURIComponent(`${PROJECT}/gan.tex`)}/pdf`);
  expect(res.ok()).toBe(true);
  const pdf = `${TMP}/e2e-gan.pdf`;
  writeFileSync(pdf, await res.body());
  const pdfText = execFileSync('pdftotext', [pdf, '-'], { encoding: 'utf8' }).replace(/\s+/g, ' ');
  expect(pdfText).toContain('Generative Adversarial Networks');
  expect(pdfText).toContain('Proposition 1. For G fixed, the optimal discriminator D is');
  expect(pdfText).toContain('The minimax game in Eq. 1 can now be reformulated as');
  expect(pdfText).toMatch(/References.*Yoshua Bengio\. Learning deep architectures for ai\. Foundations and Trends in Machine Learning/i);   // bibtex's plain style lower-cases the title
  expect(pdfText).toMatch(/hierarchical models \[1\] that represent/);
  expect(noErrors(errors)).toEqual([]);
});

test('writing "Adam" from a blank document: the update rules as a five-row align, \\eqref, the outline', async ({ page }) => {
  test.setTimeout(240000);
  const errors = collectErrors(page);
  freshPaper('adam.tex', 'Adam: A Method for Stochastic Optimization');
  await open(page, 'adam.tex');

  await afterAuthor(page);
  await setLayout(page, 'a');
  await page.keyboard.type('We introduce Adam, an algorithm for first-order gradient-based optimization of stochastic objective functions, based on adaptive estimates of lower-order moments. The method is straightforward to implement, is computationally efficient, has little memory requirements, is invariant to diagonal rescaling of the gradients, and is well suited for problems that are large in terms of data and/or parameters. The method is also appropriate for non-stationary objectives and problems with very noisy and/or sparse gradients. The hyper-parameters have intuitive interpretations and typically require little tuning. Some connections to related algorithms, on which Adam was inspired, are discussed. We also analyze the theoretical convergence properties of the algorithm and provide a regret bound on the convergence rate that is comparable to the best known results under the online convex optimization framework. Empirical results demonstrate that Adam works well in practice and compares favorably to other stochastic optimization methods. Finally, we discuss AdaMax, a variant of Adam based on the infinity norm.');
  await expect(page.locator('.lyx-layout-abstract')).toContainText('lower-order moments');

  await newParagraph(page);
  await setLayout(page, '2');
  await page.keyboard.type('Introduction');
  await newParagraph(page);
  await page.keyboard.type('Stochastic gradient-based optimization is of core practical importance in many fields of science and engineering. Many problems in these fields can be cast as the optimization of some scalar parameterized objective function requiring maximization or minimization with respect to its parameters. Our method is designed to combine the advantages of two recently popular methods: AdaGrad ');
  await citeFromPastedBibtex(page,
    `@article{duchi2011adaptive,\n  title={Adaptive subgradient methods for online learning and stochastic optimization},\n  author={Duchi, John and Hazan, Elad and Singer, Yoram},\n  journal={Journal of Machine Learning Research},\n  volume={12},\n  pages={2121--2159},\n  year={2011}\n}`,
    'Duchi');
  await page.keyboard.type(', which works well with sparse gradients, and RMSProp ');
  await citeFromPastedBibtex(page,
    `@misc{tieleman2012lecture,\n  title={Lecture 6.5-rmsprop: Divide the gradient by a running average of its recent magnitude},\n  author={Tieleman, Tijmen and Hinton, Geoffrey},\n  year={2012},\n  note={COURSERA: Neural Networks for Machine Learning}\n}`,
    'Tieleman');
  await page.keyboard.type(', which works well in on-line and non-stationary settings.');

  await newParagraph(page);
  await setLayout(page, '2');
  await page.keyboard.type('Algorithm');
  await newParagraph(page);
  await page.keyboard.type('Let ');
  await inlineMath(page, async () => { await page.keyboard.type('f('); await typeBareSymbol(page, '\\theta'); await page.keyboard.type(')'); });
  await page.keyboard.type(' be a noisy objective function: a stochastic scalar function that is differentiable w.r.t. parameters ');
  await mathVar(page, '\\theta');
  await page.keyboard.type('. With ');
  await inlineMath(page, async () => {
    await page.keyboard.type('g'); await typeScript(page, '_', 't'); await page.keyboard.type('=');
    await typeBareSymbol(page, '\\nabla'); await typeScriptWith(page, '_', async () => { await typeBareSymbol(page, '\\theta'); });
    await page.keyboard.type('f'); await typeScript(page, '_', 't'); await page.keyboard.type('('); await typeBareSymbol(page, '\\theta'); await page.keyboard.type(')');
  });
  await page.keyboard.type(' we denote the gradient, i.e. the vector of partial derivatives of ');
  await inlineMath(page, async () => { await page.keyboard.type('f'); await typeScript(page, '_', 't'); });
  await page.keyboard.type(', w.r.t ');
  await mathVar(page, '\\theta');
  await page.keyboard.type(' evaluated at timestep ');
  await mathVar(page, 't');
  await page.keyboard.type('. The algorithm updates exponential moving averages of the gradient (');
  await inlineMath(page, async () => { await page.keyboard.type('m'); await typeScript(page, '_', 't'); });
  await page.keyboard.type(') and the squared gradient (');
  await inlineMath(page, async () => { await page.keyboard.type('v'); await typeScript(page, '_', 't'); });
  await page.keyboard.type(') where the hyper-parameters ');
  await inlineMath(page, async () => {
    await typeBareSymbol(page, '\\beta'); await typeScript(page, '_', '1'); await page.keyboard.type(',');
    await typeBareSymbol(page, '\\beta'); await typeScript(page, '_', '2'); await typeBareSymbol(page, '\\in'); await page.keyboard.type('[0,1)');
  });
  await page.keyboard.type(' control the exponential decay rates of these moving averages:');

  // Algorithm 1's update rules, one align row each: lhs Tab rhs, Enter for the next row, Shift+Tab back to the first column
  await startAlign(page);
  const beta = async (i: string) => { await typeBareSymbol(page, '\\beta'); await typeScript(page, '_', i); };
  const hat = async (v: string) => { await typeCommandArg(page, '\\hat', v); await typeScript(page, '_', 't'); };
  const rows: (() => Promise<void>)[][] = [
    [async () => { await page.keyboard.type('m'); await typeScript(page, '_', 't'); },
      async () => { await typeBareSymbol(page, '\\leftarrow'); await beta('1'); await typeBareSymbol(page, '\\cdot'); await page.keyboard.type('m'); await typeScript(page, '_', 't-1'); await page.keyboard.type('+(1-'); await beta('1'); await page.keyboard.type(')'); await typeBareSymbol(page, '\\cdot'); await page.keyboard.type('g'); await typeScript(page, '_', 't'); }],
    [async () => { await page.keyboard.type('v'); await typeScript(page, '_', 't'); },
      async () => { await typeBareSymbol(page, '\\leftarrow'); await beta('2'); await typeBareSymbol(page, '\\cdot'); await page.keyboard.type('v'); await typeScript(page, '_', 't-1'); await page.keyboard.type('+(1-'); await beta('2'); await page.keyboard.type(')'); await typeBareSymbol(page, '\\cdot'); await page.keyboard.type('g'); await typeScript(page, '_', 't'); await typeScript(page, '^', '2'); }],
    [async () => { await hat('m'); },
      async () => { await typeBareSymbol(page, '\\leftarrow'); await page.keyboard.type('m'); await typeScript(page, '_', 't'); await page.keyboard.type('/(1-'); await beta('1'); await typeScript(page, '^', 't'); await page.keyboard.type(')'); }],
    [async () => { await hat('v'); },
      async () => { await typeBareSymbol(page, '\\leftarrow'); await page.keyboard.type('v'); await typeScript(page, '_', 't'); await page.keyboard.type('/(1-'); await beta('2'); await typeScript(page, '^', 't'); await page.keyboard.type(')'); }],
    [async () => { await typeBareSymbol(page, '\\theta'); await typeScript(page, '_', 't'); },
      async () => { await typeBareSymbol(page, '\\leftarrow'); await typeBareSymbol(page, '\\theta'); await typeScript(page, '_', 't-1'); await page.keyboard.type('-'); await typeBareSymbol(page, '\\alpha'); await typeBareSymbol(page, '\\cdot'); await hat('m'); await page.keyboard.type('/('); await typeSqrt(page, async () => { await hat('v'); }); await page.keyboard.type('+'); await typeBareSymbol(page, '\\epsilon'); await page.keyboard.type(')'); }],
  ];
  for (let i = 0; i < rows.length; i++) {
    if (i > 0) { await page.keyboard.press('Enter'); await page.waitForTimeout(60); await page.keyboard.press('Shift+Tab'); await page.waitForTimeout(60); }
    await rows[i][0]();
    await page.keyboard.press('Tab'); await page.waitForTimeout(60);
    await rows[i][1]();
  }
  await page.keyboard.press('Escape');
  await labelLastEquation(page, 'eq:adam');

  await newParagraph(page);
  await page.keyboard.type('Good default settings for the tested machine learning problems are ');
  await inlineMath(page, async () => { await typeBareSymbol(page, '\\alpha'); await page.keyboard.type('=0.001'); });
  await page.keyboard.type(', ');
  await inlineMath(page, async () => { await beta('1'); await page.keyboard.type('=0.9'); });
  await page.keyboard.type(', ');
  await inlineMath(page, async () => { await beta('2'); await page.keyboard.type('=0.999'); });
  await page.keyboard.type(' and ');
  await inlineMath(page, async () => { await typeBareSymbol(page, '\\epsilon'); await page.keyboard.type('=10'); await typeScript(page, '^', '-8'); });
  await page.keyboard.type('. All operations on vectors are element-wise.');

  await newParagraph(page);
  await setLayout(page, '3');
  await page.keyboard.type("Adam's update rule");
  await newParagraph(page);
  await page.keyboard.type('An important property of the update rule ');
  await insertRef(page, 'eq:adam', 'eqref');
  await page.keyboard.type(' is its careful choice of stepsizes. Assuming ');
  await inlineMath(page, async () => { await typeBareSymbol(page, '\\epsilon'); await page.keyboard.type('=0'); });
  await page.keyboard.type(', the effective step taken in parameter space at timestep ');
  await mathVar(page, 't');
  await page.keyboard.type(' is ');
  await inlineMath(page, async () => {
    await typeBareSymbol(page, '\\Delta'); await typeScript(page, '_', 't'); await page.keyboard.type('='); await typeBareSymbol(page, '\\alpha'); await typeBareSymbol(page, '\\cdot');
    await hat('m'); await page.keyboard.type('/'); await typeSqrt(page, async () => { await hat('v'); });
  });
  await page.keyboard.type('.');

  // the outline lists the headings in order
  if (await page.locator('.outline-text').count() === 0) await page.keyboard.press('Control+Alt+o');
  await expect(page.locator('.outline-text')).toHaveCount(4, { timeout: 5000 });   // title + 3 headings
  await expect(page.locator('.outline-text').nth(0)).toContainText('Adam: A Method for Stochastic Optimization');
  await expect(page.locator('.outline-text').nth(1)).toContainText('Introduction');
  await expect(page.locator('.outline-text').nth(2)).toContainText('Algorithm');
  await expect(page.locator('.outline-text').nth(3)).toContainText("Adam's update rule");

  await page.waitForTimeout(2000);
  const text = fileText('adam.tex');
  expect(text).toMatch(/\\begin\{abstract\}[\s\S]*AdaMax[\s\S]*\\end\{abstract\}/);
  expect(text).toMatch(/AdaGrad \\citep?\{duchi[a-z0-9]*\}, which works well with sparse gradients, and RMSProp \\citep?\{tieleman[a-z0-9]*\}, which/i);
  expect(text).toContain('\\section{Algorithm}');
  expect(text).toMatch(/Let \$f\(\\theta\)\$ be a noisy objective function/);
  expect(text).toMatch(/With \$g_\{t\}=\\nabla_\{\\theta\}f_\{t\}\(\\theta\)\$ we denote the gradient/);
  expect(text).toMatch(/hyper-parameters \$\\beta_\{1\},\\beta_\{2\}\\in\[0,1\)\$ control/);
  // the LyX writer puts " & " between the columns and may write a sub/superscript pair in either order
  const rx = (latex: string) => latex.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  const both = (base: string, lo: string, hi: string) => `(${rx(`${base}_{${lo}}^{${hi}}`)}|${rx(`${base}^{${hi}}_{${lo}}`)})`;
  const align = [
    rx('m_{t} & \\leftarrow\\beta_{1}\\cdot m_{t-1}+(1-\\beta_{1})\\cdot g_{t}'),
    rx('v_{t} & \\leftarrow\\beta_{2}\\cdot v_{t-1}+(1-\\beta_{2})\\cdot ') + both('g', 't', '2'),
    rx('\\hat{m}_{t} & \\leftarrow m_{t}/(1-') + both('\\beta', '1', 't') + rx(')'),
    rx('\\hat{v}_{t} & \\leftarrow v_{t}/(1-') + both('\\beta', '2', 't') + rx(')'),
    rx('\\theta_{t} & \\leftarrow\\theta_{t-1}-\\alpha\\cdot\\hat{m}_{t}/(\\sqrt{\\hat{v}_{t}}+\\epsilon)'),
  ];
  expect(text).toMatch(new RegExp(rx('\\begin{align}') + '\\n' + align.join(rx('\\\\') + '\\n') + rx('\\label{eq:adam}') + '\\n' + rx('\\end{align}')));
  expect(text).toMatch(/are \$\\alpha=0\.001\$, \$\\beta_\{1\}=0\.9\$, \$\\beta_\{2\}=0\.999\$ and \$\\epsilon=10\^\{-8\}\$\. All operations/);
  expect(text).toContain("\\subsection{Adam's update rule}");
  expect(text).toMatch(/update rule \\eqref\{eq:adam\} is its careful choice of stepsizes\. Assuming \$\\epsilon=0\$, the effective step taken in parameter space at timestep \$t\$ is \$\\Delta_\{t\}=\\alpha\\cdot\\hat\{m\}_\{t\}\/\\sqrt\{\\hat\{v\}_\{t\}\}\$\./);
  await expect(page.locator('.katex-error')).toHaveCount(0);
  expect(noErrors(errors)).toEqual([]);
});

test('all three papers survive a reload byte-identically and cited.bib carries every pasted reference', async ({ page }) => {
  for (const file of ['bert.tex', 'gan.tex', 'adam.tex']) {
    await open(page, file);
    await expect(page.locator('.lyx-editor .lyx-command-citation').first()).toBeVisible({ timeout: 15000 });
    const before = fileText(file);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 0, null, { timeout: 30000 });
    await page.waitForTimeout(1500);
    expect(fileText(file)).toBe(before);
  }
  const bib = fileText('cited.bib');
  for (const title of ['Deep contextualized word representations', 'Improving language understanding by generative pre-training', 'Learning deep architectures for AI', 'Adaptive subgradient methods', 'Lecture 6.5-rmsprop']) expect(bib).toContain(title);
});
