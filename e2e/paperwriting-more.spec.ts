/**
 * Another "a user writes a paper" simulation (see paperwriting.spec.ts): the first pages of
 * 1810.04805 "BERT" typed from a blank document through the real editor UI — a bulleted list of
 * contributions, emphasis, a footnote, subsections, inline math inside running text and table
 * cells, a small results table typed cell by cell, two pasted citations — then BERT's real
 * appendices A-C typed in two follow-up sessions (Document ▸ Start Appendix Here, a nested
 * bullet list, bold run-in headings, description items with footnotes, figure and table floats,
 * forward references into the appendix) and a reload check.
 * Whole papers, every section from the abstract to the bibliography (theorems, floats with
 * uploaded figures, algorithm floats, aligns, forward references, a PDF build):
 * paperwriting-gan.spec.ts and paperwriting-adam.spec.ts.
 */
import { test, expect, type Page } from '@playwright/test';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { login, collectErrors, PROJECTS_DIR } from './helpers';
import { openPaper, afterAuthor, setLayout, newParagraph, citeFromPastedBibtex, inlineMath, inlineLatex, typeBareSymbol, insertFloat, uploadGraphics, typeCaption, leaveFloat, insertRef, placeholderPng, resumeAtEnd, freshPaper as serverFreshPaper } from './papertyping';

const PROJECT = 'e2e-paperwriting-more';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;
const TMP = process.env.CLAUDE_JOB_DIR ? `${process.env.CLAUDE_JOB_DIR}/tmp` : '/tmp';
const FIGS = `${TMP}/e2e-bert-figs`;

/**
 * The paper starts from the blank document "New document" writes, created by its own test: Playwright
 * restarts the worker after a failed test, which would re-run a beforeAll and wipe what was typed so far
 * (the last test reloads the file). The server is told to forget any earlier copy first (papertyping's
 * freshPaper) — an instance that still had the document open from a previous run would briefly serve the
 * old content, whose figures no longer exist. The test also starts a fresh cited.bib.
 */
async function freshPaper(page: Page, file: string, title: string, opts: { resetBib?: boolean } = {}) {
  await serverFreshPaper(page, PROJECT, file, title, opts);
  for (const m of ['.complete', '.appendix-a', '.appendix']) rmSync(`${DIR}/${m}`, { force: true });   // markers of an earlier run
  rmSync(`${DIR}/figures`, { recursive: true, force: true });   // a new paper has no figures yet
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
  await freshPaper(page, 'bert.tex', 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding', { resetBib: true });
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
  writeFileSync(`${DIR}/.complete`, 'bert');   // the appendix sessions below continue from here
});

/**
 * A second session: the author comes back and types the paper's real appendix A ("Additional
 * Details for BERT") after the results table. Document ▸ Start Appendix Here makes the headings
 * lettered; the arXiv version's organization preface becomes a nested bullet list, the run-in
 * headings ("Masked LM and the Masking Procedure") bold text, and A.4/A.5 reference two figure
 * floats with uploaded images through forward references. Text lifted verbatim from 1810.04805
 * (typos like "langauge", "pretraing" and "ELMo ,and" included).
 */
test('writing "BERT", the appendix: additional details (A)', async ({ page }) => {
  test.skip(!existsSync(`${DIR}/.complete`), 'the paper was not typed');
  test.setTimeout(900000);
  const errors = collectErrors(page);
  mkdirSync(FIGS, { recursive: true });
  placeholderPng(`${FIGS}/bert-archs.png`, 640, 220, [70, 130, 180]);
  placeholderPng(`${FIGS}/bert-finetune.png`, 640, 480, [60, 160, 90]);
  await open(page, 'bert.tex');
  await expect(page.locator('.lyx-tabular td').nth(11)).toContainText('72.1', { timeout: 15000 });

  const T = (text: string) => page.keyboard.type(text);
  const M = (latex: string) => inlineLatex(page, latex);
  const P = () => newParagraph(page);
  const bold = async (text: string) => { await page.keyboard.press('Control+b'); await T(text); await page.keyboard.press('Control+b'); };
  const subsection = async (title: string) => { await P(); await setLayout(page, '3'); await T(title); await P(); };
  const figure = async (png: string, caption: string, label: string) => {
    await P();
    await insertFloat(page, 'Figure');
    await uploadGraphics(page, png);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(100);
    await typeCaption(page, caption, label);
    await leaveFloat(page);
  };

  await resumeAtEnd(page, 1);   // the end of the document is inside the table's last cell: one Escape out
  await P();
  await page.locator('.menubar .menu button', { hasText: 'Document' }).first().click();
  await page.locator('.menu-list .menu-item', { hasText: 'Start Appendix Here' }).click();

  /* --- the arXiv version's organization preface, a nested bullet list ------------- */
  await T('We organize the appendix into three sections:');
  await P();
  await setLayout(page, 'i');
  await T('Additional implementation details for BERT are presented in Appendix A;');
  await P();
  await T('Additional details for our experiments are presented in Appendix B; and');
  await P();
  await T('Additional ablation studies are presented in Appendix C. We present additional ablation studies for BERT including:');
  await P();
  await page.keyboard.press('Alt+Shift+ArrowRight'); await page.waitForTimeout(100);   // one level deeper
  await T('Effect of Number of Training Steps; and');
  await P();
  await T('Ablation for Different Masking Procedures.');
  await P();
  await page.keyboard.press('Alt+Shift+ArrowLeft'); await page.waitForTimeout(100);

  /* --- A Additional Details for BERT ---------------------------------------------- */
  await setLayout(page, '2');
  await T('Additional Details for BERT');

  await subsection('Illustration of the Pre-training Tasks');
  await T('We provide examples of the pre-training tasks in the following.');
  await P();
  await bold('Masked LM and the Masking Procedure ');
  await T('Assuming the unlabeled sentence is my dog is hairy, and during the random masking procedure we chose the 4-th token (which corresponding to hairy), our masking procedure can be further illustrated by');
  await P();
  await setLayout(page, 'i');
  await T('80% of the time: Replace the word with the [MASK] token, e.g., my dog is hairy ');
  await M('\\to');
  await T(' my dog is [MASK]');
  await P();
  await T('10% of the time: Replace the word with a random word, e.g., my dog is hairy ');
  await M('\\to');
  await T(' my dog is apple');
  await P();
  await T('10% of the time: Keep the word unchanged, e.g., my dog is hairy ');
  await M('\\to');
  await T(' my dog is hairy. The purpose of this is to bias the representation towards the actual observed word.');
  await P();
  await setLayout(page, 's');
  await T('The advantage of this procedure is that the Transformer encoder does not know which words it will be asked to predict or which have been replaced by random words, so it is forced to keep a distributional contextual representation of every input token. Additionally, because random replacement only occurs for 1.5% of all tokens (i.e., 10% of 15%), this does not seem to harm the model\'s language understanding capability. In Section C.2, we evaluate the impact this procedure.');
  await P();
  await T('Compared to standard langauge model training, the masked LM only make predictions on 15% of tokens in each batch, which suggests that more pre-training steps may be required for the model to converge. In Section C.1 we demonstrate that MLM does converge marginally slower than a left-to-right model (which predicts every token), but the empirical improvements of the MLM model far outweigh the increased training cost.');
  await P();
  await bold('Next Sentence Prediction ');
  await T('The next sentence prediction task can be illustrated in the following examples.');
  await P();
  await T('Input = [CLS] the man went to [MASK] store [SEP] he bought a gallon [MASK] milk [SEP]');
  await P();
  await T('Label = IsNext');
  await P();
  await T('Input = [CLS] the man [MASK] to the store [SEP] penguin [MASK] are flight ##less birds [SEP]');
  await P();
  await T('Label = NotNext');

  await subsection('Pre-training Procedure');
  await T('To generate each training input sequence, we sample two spans of text from the corpus, which we refer to as "sentences" even though they are typically much longer than single sentences (but can be shorter also). The first sentence receives the A embedding and the second receives the B embedding. 50% of the time B is the actual next sentence that follows A and 50% of the time it is a random sentence, which is done for the "next sentence prediction" task. They are sampled such that the combined length is ');
  await M('\\leq512');
  await T(' tokens. The LM masking is applied after WordPiece tokenization with a uniform masking rate of 15%, and no special consideration given to partial word pieces.');
  await P();
  await T('We train with batch size of 256 sequences (256 sequences * 512 tokens = 128,000 tokens/batch) for 1,000,000 steps, which is approximately 40 epochs over the 3.3 billion word corpus. We use Adam with learning rate of 1e-4, ');
  await M('\\beta_{1}=0.9');
  await T(', ');
  await M('\\beta_{2}=0.999');
  await T(', ');
  await M('L_{2}');
  await T(' weight decay of 0.01, learning rate warmup over the first 10,000 steps, and linear decay of the learning rate. We use a dropout probability of 0.1 on all layers. We use a gelu activation (Hendrycks and Gimpel, 2016) rather than the standard relu, following OpenAI GPT. The training loss is the sum of the mean masked LM likelihood and the mean next sentence prediction likelihood.');
  await P();
  await T('Training of BERT');
  await M('_{BASE}');
  await T(' was performed on 4 Cloud TPUs in Pod configuration (16 TPU chips total).');
  await page.keyboard.press('Control+Alt+f');   // footnote
  await T('https://cloudplatform.googleblog.com/2018/06/Cloud-TPU-now-offers-preemptible-pricing-and-global-availability.html');
  await page.keyboard.press('Escape');
  await T(' Training of BERT');
  await M('_{LARGE}');
  await T(' was performed on 16 Cloud TPUs (64 TPU chips total). Each pre-training took 4 days to complete.');
  await P();
  await T('Longer sequences are disproportionately expensive because attention is quadratic to the sequence length. To speed up pretraing in our experiments, we pre-train the model with sequence length of 128 for 90% of the steps. Then, we train the rest 10% of the steps of sequence of 512 to learn the positional embeddings.');

  await subsection('Fine-tuning Procedure');
  await T('For fine-tuning, most model hyperparameters are the same as in pre-training, with the exception of the batch size, learning rate, and number of training epochs. The dropout probability was always kept at 0.1. The optimal hyperparameter values are task-specific, but we found the following range of possible values to work well across all tasks:');
  await P();
  await setLayout(page, 'i');
  await T('Batch size: 16, 32');
  await P();
  await T('Learning rate (Adam): 5e-5, 3e-5, 2e-5');
  await P();
  await T('Number of epochs: 2, 3, 4');
  await P();
  await setLayout(page, 's');
  await T('We also observed that large data sets (e.g., 100k+ labeled training examples) were far less sensitive to hyperparameter choice than small data sets. Fine-tuning is typically very fast, so it is reasonable to simply run an exhaustive search over the above parameters and choose the model that performs best on the development set.');

  await subsection('Comparison of BERT, ELMo ,and OpenAI GPT');
  await T('Here we studies the differences in recent popular representation learning models including ELMo, OpenAI GPT and BERT. The comparisons between the model architectures are shown visually in Figure ');
  await insertRef(page, 'fig:archs');   // the figure follows below: a forward reference
  await T('. Note that in addition to the architecture differences, BERT and OpenAI GPT are fine-tuning approaches, while ELMo is a feature-based approach.');
  await P();
  await T('The most comparable existing pre-training method to BERT is OpenAI GPT, which trains a left-to-right Transformer LM on a large text corpus. In fact, many of the design decisions in BERT were intentionally made to make it as close to GPT as possible so that the two methods could be minimally compared. The core argument of this work is that the bi-directionality and the two pre-training tasks presented in Section 3.1 account for the majority of the empirical improvements, but we do note that there are several other differences between how BERT and GPT were trained:');
  await P();
  await setLayout(page, 'i');
  await T('GPT is trained on the BooksCorpus (800M words); BERT is trained on the BooksCorpus (800M words) and Wikipedia (2,500M words).');
  await P();
  await T('GPT uses a sentence separator ([SEP]) and classifier token ([CLS]) which are only introduced at fine-tuning time; BERT learns [SEP], [CLS] and sentence A/B embeddings during pre-training.');
  await P();
  await T('GPT was trained for 1M steps with a batch size of 32,000 words; BERT was trained for 1M steps with a batch size of 128,000 words.');
  await P();
  await T('GPT used the same learning rate of 5e-5 for all fine-tuning experiments; BERT chooses a task-specific fine-tuning learning rate which performs the best on the development set.');
  await P();
  await setLayout(page, 's');
  await T('To isolate the effect of these differences, we perform ablation experiments in Section 5.1 which demonstrate that the majority of the improvements are in fact coming from the two pre-training tasks and the bidirectionality they enable.');
  await figure(`${FIGS}/bert-archs.png`,
    'Differences in pre-training model architectures. BERT uses a bidirectional Transformer. OpenAI GPT uses a left-to-right Transformer. ELMo uses the concatenation of independently trained left-to-right and right-to-left LSTMs to generate features for downstream tasks. Among the three, only BERT representations are jointly conditioned on both left and right context in all layers. In addition to the architecture differences, BERT and OpenAI GPT are fine-tuning approaches, while ELMo is a feature-based approach.',
    'fig:archs');

  await subsection('Illustrations of Fine-tuning on Different Tasks');
  await T('The illustration of fine-tuning BERT on different tasks can be seen in Figure ');
  await insertRef(page, 'fig:finetune');
  await T('. Our task-specific models are formed by incorporating BERT with one additional output layer, so a minimal number of parameters need to be learned from scratch. Among the tasks, (a) and (b) are sequence-level tasks while (c) and (d) are token-level tasks. In the figure, E represents the input embedding, ');
  await M('T_{i}');
  await T(' represents the contextual representation of token ');
  await M('i');
  await T(', [CLS] is the special symbol for classification output, and [SEP] is the special symbol to separate non-consecutive token sequences.');
  await figure(`${FIGS}/bert-finetune.png`, 'Illustrations of Fine-tuning BERT on Different Tasks.', 'fig:finetune');

  /* --- what the file holds --------------------------------------------------------- */
  await expect.poll(() => fileText('bert.tex').includes('\\label{fig:finetune}'), { timeout: 20000 }).toBe(true);
  await page.waitForTimeout(2500);
  const text = fileText('bert.tex');
  expect(text).toMatch(/\\end\{tabular\}\n+\\appendix\n+We organize the appendix into three sections:/);
  expect((text.match(/\\appendix/g) ?? []).length).toBe(1);   // one marker, not one per paragraph
  expect(text).toMatch(/\\begin\{itemize\}\n\\item Additional implementation details for BERT are presented in Appendix A;\n\\item Additional details for our experiments are presented in Appendix B; and\n\\item Additional ablation studies are presented in Appendix C\. We present additional ablation studies for BERT including:\n+\\begin\{itemize\}\n\\item Effect of Number of Training Steps; and\n\\item Ablation for Different Masking Procedures\.\n\\end\{itemize\}\n+\\end\{itemize\}/);
  for (const s of ['\\section{Additional Details for BERT}', '\\subsection{Illustration of the Pre-training Tasks}', '\\subsection{Pre-training Procedure}', '\\subsection{Fine-tuning Procedure}',
    '\\subsection{Comparison of BERT, ELMo ,and OpenAI GPT}', '\\subsection{Illustrations of Fine-tuning on Different Tasks}']) expect(text).toContain(s);
  expect(text).toMatch(/\\textbf\{Masked LM and the Masking Procedure \}Assuming the unlabeled sentence is my dog is hairy/);
  // [ and ] are escaped as {[} / {]} by the writer (they could otherwise be read as optional arguments)
  expect(text).toMatch(/\\begin\{itemize\}\n\\item 80\\% of the time: Replace the word with the \{\[\}MASK\{\]\} token, e\.g\., my dog is hairy \$\\to\$ my dog is \{\[\}MASK\{\]\}\n\\item 10\\% of the time: Replace the word with a random word, e\.g\., my dog is hairy \$\\to\$ my dog is apple\n\\item 10\\% of the time: Keep the word unchanged, e\.g\., my dog is hairy \$\\to\$ my dog is hairy\./);
  expect(text).toMatch(/\\textbf\{Next Sentence Prediction \}The next sentence prediction task/);
  expect(text).toContain('Input = {[}CLS{]} the man went to {[}MASK{]} store {[}SEP{]} he bought a gallon {[}MASK{]} milk {[}SEP{]}');
  expect(text).toContain('Label = IsNext');
  expect(text).toContain('Input = {[}CLS{]} the man {[}MASK{]} to the store {[}SEP{]} penguin {[}MASK{]} are flight \\#\\#less birds {[}SEP{]}');
  expect(text).toContain('Label = NotNext');
  expect(text).toMatch(/combined length is \$\\leq512\$ tokens\./);
  expect(text).toMatch(/We use Adam with learning rate of 1e-4, \$\\beta_\{1\}=0\.9\$, \$\\beta_\{2\}=0\.999\$, \$L_\{2\}\$ weight decay of 0\.01/);
  expect(text).toMatch(/\(16 TPU chips total\)\.\\footnote\{https:\/\/cloudplatform\.googleblog\.com\/2018\/06\/Cloud-TPU-now-offers-preemptible-pricing-and-global-availability\.html\} Training of BERT\$_\{LARGE\}\$ was performed on 16 Cloud TPUs/);
  expect(text).toMatch(/\\begin\{itemize\}\n\\item Batch size: 16, 32\n\\item Learning rate \(Adam\): 5e-5, 3e-5, 2e-5\n\\item Number of epochs: 2, 3, 4\n\\end\{itemize\}/);
  expect(text).toMatch(/shown visually in Figure \\ref\{fig:archs\}\. Note that/);
  expect(text).toMatch(/can be seen in Figure \\ref\{fig:finetune\}\. Our task-specific/);
  expect(text).toMatch(/\\item GPT is trained on the BooksCorpus \(800M words\); BERT is trained on the BooksCorpus \(800M words\) and Wikipedia \(2,500M words\)\.\n\\item GPT uses a sentence separator/);
  for (const f of ['bert-archs', 'bert-finetune']) {
    expect(existsSync(`${DIR}/figures/${f}.png`)).toBe(true);
    expect(text).toContain(`\\includegraphics[width=1\\columnwidth]{figures/${f}.png}`);
  }
  expect(text).toMatch(/\\caption\{Differences in pre-training model architectures\. BERT uses a bidirectional Transformer\.[\s\S]*feature-based approach\.\}\\label\{fig:archs\}/);
  expect(text).toMatch(/\\caption\{Illustrations of Fine-tuning BERT on Different Tasks\.\}\\label\{fig:finetune\}/);
  expect(text).toMatch(/E represents the input embedding, \$T_\{i\}\$ represents the contextual representation of token \$i\$/);
  await expect(page.locator('.katex-error')).toHaveCount(0);
  expect(noErrors(errors)).toEqual([]);
  writeFileSync(`${DIR}/.appendix-a`, 'bert');
});

/**
 * A third session: appendices B ("Detailed Experimental Setup" — the GLUE dataset descriptions as
 * a description list with two footnotes) and C ("Additional Ablation Studies" — the training-steps
 * figure with a Question/Answer enumerate and the masking-strategies ablation with its table
 * float, both reached through forward references).
 */
test('writing "BERT", the appendix: experimental setup and ablation studies (B, C)', async ({ page }) => {
  test.skip(!existsSync(`${DIR}/.appendix-a`), 'appendix A was not typed');
  test.setTimeout(900000);
  const errors = collectErrors(page);
  mkdirSync(FIGS, { recursive: true });
  placeholderPng(`${FIGS}/bert-steps.png`, 640, 300, [170, 90, 60]);
  await open(page, 'bert.tex');
  await expect(page.locator('.lyx-editor')).toContainText('Illustrations of Fine-tuning', { timeout: 15000 });

  const T = (text: string) => page.keyboard.type(text);
  const M = (latex: string) => inlineLatex(page, latex);
  const P = () => newParagraph(page);
  const bold = async (text: string) => { await page.keyboard.press('Control+b'); await T(text); await page.keyboard.press('Control+b'); };
  const footnote = async (text: string) => { await page.keyboard.press('Control+Alt+f'); await T(text); await page.keyboard.press('Escape'); };
  const section = async (title: string) => { await P(); await setLayout(page, '2'); await T(title); await P(); };
  const subsection = async (title: string) => { await P(); await setLayout(page, '3'); await T(title); await P(); };

  await resumeAtEnd(page, 2);   // the document ends in a figure float: caption, float

  /* --- B Detailed Experimental Setup ----------------------------------------------- */
  await section('Detailed Experimental Setup');
  await page.keyboard.press('Backspace');   // section() opens a Standard paragraph; B has only the subsection
  await subsection('Detailed Descriptions for the GLUE Benchmark Experiments.');
  await T('Our GLUE results in Table1 are obtained from https://gluebenchmark.com/leaderboard and https://blog.openai.com/language-unsupervised. The GLUE benchmark includes the following datasets, the descriptions of which were originally summarized in Wang et al. (2018a):');
  await P();
  await setLayout(page, 'd');
  await T('MNLI Multi-Genre Natural Language Inference is a large-scale, crowdsourced entailment classification task (Williams et al., 2018). Given a pair of sentences, the goal is to predict whether the second sentence is an entailment, contradiction, or neutral with respect to the first one.');
  await P();
  await T('QQP Quora Question Pairs is a binary classification task where the goal is to determine if two questions asked on Quora are semantically equivalent (Chen et al., 2018).');
  await P();
  await T('QNLI Question Natural Language Inference is a version of the Stanford Question Answering Dataset (Rajpurkar et al., 2016) which has been converted to a binary classification task (Wang et al., 2018a). The positive examples are (question, sentence) pairs which do contain the correct answer, and the negative examples are (question, sentence) from the same paragraph which do not contain the answer.');
  await P();
  await T('SST-2 The Stanford Sentiment Treebank is a binary single-sentence classification task consisting of sentences extracted from movie reviews with human annotations of their sentiment (Socher et al., 2013).');
  await P();
  await T('CoLA The Corpus of Linguistic Acceptability is a binary single-sentence classification task, where the goal is to predict whether an English sentence is linguistically "acceptable" or not (Warstadt et al., 2018).');
  await P();
  await T('STS-B The Semantic Textual Similarity Benchmark is a collection of sentence pairs drawn from news headlines and other sources (Cer et al., 2017). They were annotated with a score from 1 to 5 denoting how similar the two sentences are in terms of semantic meaning.');
  await P();
  await T('MRPC Microsoft Research Paraphrase Corpus consists of sentence pairs automatically extracted from online news sources, with human annotations for whether the sentences in the pair are semantically equivalent (Dolan and Brockett, 2005).');
  await P();
  await T('RTE Recognizing Textual Entailment is a binary entailment task similar to MNLI, but with much less training data (Bentivogli et al., 2009).');
  await footnote('Note that we only report single-task fine-tuning results in this paper. A multitask fine-tuning approach could potentially push the performance even further. For example, we did observe substantial improvements on RTE from multi-task training with MNLI.');
  await P();
  await T('WNLI Winograd NLI is a small natural language inference dataset (Levesque et al., 2011). The GLUE webpage notes that there are issues with the construction of this dataset,');
  await footnote('https://gluebenchmark.com/faq');
  await T(" and every trained system that's been submitted to GLUE has performed worse than the 65.1 baseline accuracy of predicting the majority class. We therefore exclude this set to be fair to OpenAI GPT. For our GLUE submission, we always predicted the majority class.");

  /* --- C Additional Ablation Studies ----------------------------------------------- */
  await section('Additional Ablation Studies');
  await page.keyboard.press('Backspace');   // C, too, goes straight into its first subsection
  await subsection('Effect of Number of Training Steps');
  await T('Figure ');
  await insertRef(page, 'fig:steps');   // the figure follows below: a forward reference
  await T(' presents MNLI Dev accuracy after fine-tuning from a checkpoint that has been pre-trained for ');
  await M('k');
  await T(' steps. This allows us to answer the following questions:');
  await P();
  await setLayout(page, 'e');
  await bold('Question: ');
  await T('Does BERT really need such a large amount of pre-training (128,000 words/batch * 1,000,000 steps) to achieve high fine-tuning accuracy? ');
  await bold('Answer: ');
  await T('Yes, BERT');
  await M('_{BASE}');
  await T(' achieves almost 1.0% additional accuracy on MNLI when trained on 1M steps compared to 500k steps.');
  await P();
  await bold('Question: ');
  await T('Does MLM pre-training converge slower than LTR pre-training, since only 15% of words are predicted in each batch rather than every word? ');
  await bold('Answer: ');
  await T('The MLM model does converge slightly slower than the LTR model. However, in terms of absolute accuracy the MLM model begins to outperform the LTR model almost immediately.');
  await P();
  await setLayout(page, 's');
  await insertFloat(page, 'Figure');
  await uploadGraphics(page, `${FIGS}/bert-steps.png`);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(100);
  await typeCaption(page, async () => {
    await T('Ablation over number of training steps. This shows the MNLI accuracy after fine-tuning, starting from model parameters that have been pre-trained for ');
    await M('k');
    await T(' steps. The x-axis is the value of ');
    await M('k');
    await T('.');
  }, 'fig:steps');
  await leaveFloat(page);

  await subsection('Ablation for Different Masking Procedures');
  await T('In Section 3.1, we mention that BERT uses a mixed strategy for masking the target tokens when pre-training with the masked language model (MLM) objective. The following is an ablation study to evaluate the effect of different masking strategies.');
  await P();
  await T('Note that the purpose of the masking strategies is to reduce the mismatch between pre-training and fine-tuning, as the [MASK] symbol never appears during the fine-tuning stage. We report the Dev results for both MNLI and NER. For NER, we report both fine-tuning and feature-based approaches, as we expect the mismatch will be amplified for the feature-based approach as the model will not have the chance to adjust the representations.');
  await P();
  await T('The results are presented in Table ');
  await insertRef(page, 'tab:masking');
  await T('. In the table, MASK means that we replace the target token with the [MASK] symbol for MLM; SAME means that we keep the target token as is; RND means that we replace the target token with another random token.');

  // Table 8: the masking-strategies ablation, typed cell by cell
  await P();
  await insertFloat(page, 'Table');
  await typeCaption(page, 'Ablation over different masking strategies.', 'tab:masking');
  await page.keyboard.press('Escape');   // out of the caption, into the float's second paragraph
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(100);
  await page.keyboard.press('Control+Alt+t');
  const tableDialog = page.locator('.dialog');
  await expect(tableDialog).toContainText('Insert Table');
  await tableDialog.locator('.row', { hasText: 'Rows' }).locator('input').fill('7');
  await tableDialog.locator('.row', { hasText: 'Columns' }).locator('input').fill('6');
  await tableDialog.locator('.btn.primary').click();
  await expect(page.locator('.lyx-tabular').last().locator('td')).toHaveCount(42);
  const masking = [
    'MASK', 'SAME', 'RND', 'MNLI', 'NER Fine-tune', 'NER Feature-based',
    '80%', '10%', '10%', '84.2', '95.4', '94.9',
    '100%', '0%', '0%', '84.3', '94.9', '94.0',
    '80%', '0%', '20%', '84.1', '95.2', '94.6',
    '80%', '20%', '0%', '84.4', '95.2', '94.7',
    '0%', '20%', '80%', '83.7', '94.8', '94.6',
    '0%', '0%', '100%', '83.6', '94.9', '94.6',
  ];
  for (let i = 0; i < masking.length; i++) {
    await T(masking[i]);
    if (i < masking.length - 1) { await page.keyboard.press('Tab'); await page.waitForTimeout(30); }
  }
  await expect(page.locator('.lyx-tabular').last().locator('td').nth(41)).toContainText('94.6');
  await leaveFloat(page, 3);   // cell, table paragraph, float

  await P();
  await T('The numbers in the left part of the table represent the probabilities of the specific strategies used during MLM pre-training (BERT uses 80%, 10%, 10%). The right part of the paper represents the Dev set results. For the feature-based approach, we concatenate the last 4 layers of BERT as the features, which was shown to be the best approach in Section 5.3.');
  await P();
  await T('From the table it can be seen that fine-tuning is surprisingly robust to different masking strategies. However, as expected, using only the MASK strategy was problematic when applying the feature-based approach to NER. Interestingly, using only the RND strategy performs much worse than our strategy as well.');

  /* --- what the file holds --------------------------------------------------------- */
  await expect.poll(() => fileText('bert.tex').includes('much worse than our strategy as well.'), { timeout: 20000 }).toBe(true);
  await page.waitForTimeout(2500);
  const text = fileText('bert.tex');
  for (const s of ['\\section{Detailed Experimental Setup}', '\\subsection{Detailed Descriptions for the GLUE Benchmark Experiments.}', '\\section{Additional Ablation Studies}',
    '\\subsection{Effect of Number of Training Steps}', '\\subsection{Ablation for Different Masking Procedures}']) expect(text).toContain(s);
  const order = ['\\appendix', '\\section{Additional Details for BERT}', '\\section{Detailed Experimental Setup}', '\\section{Additional Ablation Studies}', '\\label{fig:steps}', '\\label{tab:masking}'].map(s => text.indexOf(s));
  expect(order.every(i => i >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(text).toContain('Our GLUE results in Table1 are obtained from https://gluebenchmark.com/leaderboard');
  expect(text).toMatch(/\\begin\{description\}\n\\item \[\{MNLI\}\] Multi-Genre Natural Language Inference is a large-scale, crowdsourced entailment classification task \(Williams et al\., 2018\)\./);
  expect((text.match(/\\item \[\{(MNLI|QQP|QNLI|SST-2|CoLA|STS-B|MRPC|RTE|WNLI)\}\]/g) ?? []).length).toBe(9);
  expect(text).toMatch(/much less training data \(Bentivogli et al\., 2009\)\.\\footnote\{Note that we only report single-task fine-tuning results in this paper\./);
  expect(text).toMatch(/issues with the construction of this dataset,\\footnote\{https:\/\/gluebenchmark\.com\/faq\} and every trained system/);
  expect(text).toMatch(/predicted the majority class\.\n\\end\{description\}/);
  expect(text).toMatch(/Figure \\ref\{fig:steps\} presents MNLI Dev accuracy after fine-tuning from a checkpoint that has been pre-trained for \$k\$ steps\./);
  expect(text).toMatch(/\\begin\{enumerate\}\n\\item \\textbf\{Question: \}Does BERT really need such a large amount of pre-training \(128,000 words\/batch \{\*\} 1,000,000 steps\) to achieve high fine-tuning accuracy\? \\textbf\{Answer: \}Yes, BERT\$_\{BASE\}\$ achieves almost 1\.0\\% additional accuracy/);   // the writer escapes a bare * as {*}
  expect(text).toMatch(/\\item \\textbf\{Question: \}Does MLM pre-training converge slower[\s\S]*\\textbf\{Answer: \}The MLM model does converge slightly slower[\s\S]*almost immediately\.\n\\end\{enumerate\}/);
  expect(existsSync(`${DIR}/figures/bert-steps.png`)).toBe(true);
  expect(text).toContain('\\includegraphics[width=1\\columnwidth]{figures/bert-steps.png}');
  expect(text).toMatch(/\\caption\{Ablation over number of training steps\.[\s\S]*The x-axis is the value of \$k\$\.\}\\label\{fig:steps\}/);
  expect(text).toMatch(/The results are presented in Table \\ref\{tab:masking\}\. In the table, MASK means/);
  expect(text).toMatch(/\\caption\{Ablation over different masking strategies\.\}\\label\{tab:masking\}/);
  expect(text).toContain('MASK & SAME & RND & MNLI & NER Fine-tune & NER Feature-based\\tabularnewline');
  expect(text).toContain('80\\% & 10\\% & 10\\% & 84.2 & 95.4 & 94.9\\tabularnewline');
  expect(text).toContain('0\\% & 0\\% & 100\\% & 83.6 & 94.9 & 94.6\\tabularnewline');
  expect(text).toMatch(/best approach in Section 5\.3\./);
  await expect(page.locator('.katex-error')).toHaveCount(0);
  expect(noErrors(errors)).toEqual([]);
  writeFileSync(`${DIR}/.appendix`, 'bert');
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
