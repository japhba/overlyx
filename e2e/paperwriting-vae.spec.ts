/**
 * The whole of "Auto-Encoding Variational Bayes" (arXiv 1312.6114) written from a blank document
 * through the editor UI, the text lifted verbatim from the paper — the body in two sessions and
 * the six appendices (A visualisations, B the Gaussian KL solution, C MLP encoders/decoders with
 * two subsections, D the marginal likelihood estimator, E Monte Carlo EM, F full VB with its
 * example and a second algorithm) in a third, after Document ▸ Start Appendix Here. Beyond what
 * the GAN and Adam papers already drive through the GUI, this one needs:
 *  - aligns whose first row carries no number (LyX's Alt+M Shift+N math-number-line-toggle) and
 *    unnumbered aligns (Alt+M N on an align), \eqref cross-references, section titles that hold a
 *    formula (appendix B), a footnote that holds a formula, a \paragraph{} run-in heading (Alt+P 5);
 *  - formulas with \left. … \right|_{…} evaluations, scripts on \right) and on \rbrace, nested
 *    fractions, \tilde{\mathcal{L}}, \odot, \prod, \quad + \mathrm{where} annotations, a display
 *    formula inside an enumerate item;
 *  - two enumerates in one subsection (each restarting at 1), lettered appendix sections with
 *    numbered subsections (C.1, C.2, F.1), equation numbers running on into the appendix, two
 *    figures side by side in one float;
 *  - 17 references pasted as BibTeX, several re-cited (from the appendix as well);
 *  - the typed file survives a reload byte-identically and latexmk builds it: the PDF text is
 *    checked for the numbering (equations, appendix letters, algorithms, figures), the resolved
 *    references and the reference list.
 * Runs against an isolated instance (README "Testing"); OVERLYX_E2E_KEEP=1 keeps the project.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { login, collectErrors, PROJECTS_DIR } from './helpers';
import {
  openPaper, afterAuthor, setLayout, newParagraph, typeLatex, inlineLatex, canonMath, startAlign, startDisplayMath, labelLastEquation,
  insertFloat, uploadGraphics, insertLabel, typeCaption, leaveFloat, citeExisting, citeFromPastedBibtexMany, insertRef, insertBibliography,
  freshPaper, placeholderPng, resumeAtEnd,
} from './papertyping';

const PROJECT = 'e2e-paper-vae';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;
const KEYS_FILE = `${DIR}/.keys.json`;
const TMP = process.env.CLAUDE_JOB_DIR ? `${process.env.CLAUDE_JOB_DIR}/tmp` : '/tmp';
const FIGS = `${TMP}/e2e-vae-figs`;
const r = String.raw;

test.afterAll(() => { if (!process.env.OVERLYX_E2E_KEEP) rmSync(DIR, { recursive: true, force: true }); });

const fileText = () => readFileSync(`${DIR}/vae.tex`, 'utf8');
const noErrors = (errors: string[]) => errors.filter(e => !/favicon|ResizeObserver/.test(e));

/* ------------------------------------------------------------------ the paper's references (BibTeX as an author would paste it) */
const BIB: Record<string, { bibtex: string; surname: string }> = {
  bengio2013representation: { surname: 'Bengio', bibtex: `@article{bengio2013representation,\n  title={Representation learning: A review and new perspectives},\n  author={Bengio, Yoshua and Courville, Aaron and Vincent, Pascal},\n  journal={IEEE Transactions on Pattern Analysis and Machine Intelligence},\n  volume={35},\n  number={8},\n  pages={1798--1828},\n  year={2013}\n}` },
  blei2012variational: { surname: 'Blei', bibtex: `@inproceedings{blei2012variational,\n  title={Variational Bayesian inference with stochastic search},\n  author={Blei, David M. and Jordan, Michael I. and Paisley, John W.},\n  booktitle={Proceedings of the 29th International Conference on Machine Learning (ICML-12)},\n  pages={1367--1374},\n  year={2012}\n}` },
  bengio2013deep: { surname: 'Bengio', bibtex: `@techreport{bengio2013deep,\n  title={Deep generative stochastic networks trainable by backprop},\n  author={Bengio, Yoshua and Thibodeau-Laufer, {\\'E}ric},\n  institution={arXiv:1306.1091},\n  year={2013}\n}` },
  devroye1986sample: { surname: 'Devroye', bibtex: `@inproceedings{devroye1986sample,\n  title={Sample-based non-uniform random variate generation},\n  author={Devroye, Luc},\n  booktitle={Proceedings of the 18th conference on Winter simulation},\n  pages={260--265},\n  publisher={ACM},\n  year={1986}\n}` },
  duchi2010adaptive: { surname: 'Duchi', bibtex: `@article{duchi2010adaptive,\n  title={Adaptive subgradient methods for online learning and stochastic optimization},\n  author={Duchi, John and Hazan, Elad and Singer, Yoram},\n  journal={Journal of Machine Learning Research},\n  volume={12},\n  pages={2121--2159},\n  year={2010}\n}` },
  duane1987hybrid: { surname: 'Duane', bibtex: `@article{duane1987hybrid,\n  title={Hybrid Monte Carlo},\n  author={Duane, Simon and Kennedy, Anthony D. and Pendleton, Brian J. and Roweth, Duncan},\n  journal={Physics Letters B},\n  volume={195},\n  number={2},\n  pages={216--222},\n  year={1987}\n}` },
  gregor2013deep: { surname: 'Gregor', bibtex: `@techreport{gregor2013deep,\n  title={Deep autoregressive networks},\n  author={Gregor, Karol and Mnih, Andriy and Wierstra, Daan},\n  institution={arXiv:1310.8499},\n  year={2013}\n}` },
  hoffman2013stochastic: { surname: 'Hoffman', bibtex: `@article{hoffman2013stochastic,\n  title={Stochastic variational inference},\n  author={Hoffman, Matthew D. and Blei, David M. and Wang, Chong and Paisley, John},\n  journal={The Journal of Machine Learning Research},\n  volume={14},\n  number={1},\n  pages={1303--1347},\n  year={2013}\n}` },
  hinton1995wake: { surname: 'Hinton', bibtex: `@article{hinton1995wake,\n  title={The wake-sleep algorithm for unsupervised neural networks},\n  author={Hinton, Geoffrey E. and Dayan, Peter and Frey, Brendan J. and Neal, Radford M.},\n  journal={Science},\n  volume={268},\n  pages={1158--1161},\n  year={1995}\n}` },
  kavukcuoglu2008fast: { surname: 'Kavukcuoglu', bibtex: `@techreport{kavukcuoglu2008fast,\n  title={Fast inference in sparse coding algorithms with applications to object recognition},\n  author={Kavukcuoglu, Koray and Ranzato, Marc'Aurelio and LeCun, Yann},\n  institution={Computational and Biological Learning Lab, Courant Institute, NYU},\n  number={CBLL-TR-2008-12-01},\n  year={2008}\n}` },
  linsker1989application: { surname: 'Linsker', bibtex: `@book{linsker1989application,\n  title={An application of the principle of maximum information preservation to linear systems},\n  author={Linsker, Ralph},\n  publisher={Morgan Kaufmann Publishers Inc.},\n  year={1989}\n}` },
  ranganath2013black: { surname: 'Ranganath', bibtex: `@techreport{ranganath2013black,\n  title={Black box variational inference},\n  author={Ranganath, Rajesh and Gerrish, Sean and Blei, David M.},\n  institution={arXiv:1401.0118},\n  year={2013}\n}` },
  rezende2014stochastic: { surname: 'Rezende', bibtex: `@techreport{rezende2014stochastic,\n  title={Stochastic backpropagation and variational inference in deep latent Gaussian models},\n  author={Rezende, Danilo Jimenez and Mohamed, Shakir and Wierstra, Daan},\n  institution={arXiv:1401.4082},\n  year={2014}\n}` },
  roweis1998em: { surname: 'Roweis', bibtex: `@inproceedings{roweis1998em,\n  title={EM algorithms for PCA and SPCA},\n  author={Roweis, Sam},\n  booktitle={Advances in Neural Information Processing Systems},\n  pages={626--632},\n  year={1998}\n}` },
  salimans2013fixed: { surname: 'Salimans', bibtex: `@article{salimans2013fixed,\n  title={Fixed-form variational posterior approximation through stochastic linear regression},\n  author={Salimans, Tim and Knowles, David A.},\n  journal={Bayesian Analysis},\n  volume={8},\n  number={4},\n  year={2013}\n}` },
  salakhutdinov2010efficient: { surname: 'Salakhutdinov', bibtex: `@inproceedings{salakhutdinov2010efficient,\n  title={Efficient learning of deep Boltzmann machines},\n  author={Salakhutdinov, Ruslan and Larochelle, Hugo},\n  booktitle={International Conference on Artificial Intelligence and Statistics},\n  pages={693--700},\n  year={2010}\n}` },
  vincent2010stacked: { surname: 'Vincent', bibtex: `@article{vincent2010stacked,\n  title={Stacked denoising autoencoders: Learning useful representations in a deep network with a local denoising criterion},\n  author={Vincent, Pascal and Larochelle, Hugo and Lajoie, Isabelle and Bengio, Yoshua and Manzagol, Pierre-Antoine},\n  journal={The Journal of Machine Learning Research},\n  volume={11},\n  pages={3371--3408},\n  year={2010}\n}` },
};

/** The shorthands the writing sessions share; `keys` maps a BIB name to the key the server gave it (persisted between the sessions). */
function tools(page: Page, keys: Record<string, string>) {
  const T = (text: string) => page.keyboard.type(text);
  const M = (latex: string) => inlineLatex(page, latex);
  const P = () => newParagraph(page);
  const heading = async (key: string, title: string | (() => Promise<void>), label?: string) => { await P(); await setLayout(page, key); if (typeof title === 'string') await T(title); else await title(); if (label) await insertLabel(page, label); await P(); };
  const section = (title: string | (() => Promise<void>), label?: string) => heading('2', title, label);
  const subsection = (title: string, label?: string) => heading('3', title, label);
  /** a \paragraph{} run-in heading (Alt+P 5); the text that follows it goes into the next paragraph */
  const parHeading = (title: string) => heading('5', title);
  const bold = async (text: string) => { await page.keyboard.press('Control+b'); await T(text); await page.keyboard.press('Control+b'); };
  const emph = async (text: string) => { await page.keyboard.press('Control+e'); await T(text); await page.keyboard.press('Control+e'); };
  const ref = (label: string) => insertRef(page, label);
  const eqref = (label: string) => insertRef(page, label, 'eqref');
  /** a footnote at the cursor; `body` may type formulas; ends back in the text after the footnote */
  const footnote = async (body: string | (() => Promise<void>)) => {
    await page.keyboard.press('Control+Alt+f');
    if (typeof body === 'string') await T(body); else await body();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(80);
  };
  /**
   * A display formula in its own paragraph. An `equation` is unnumbered unless `numbered`; an
   * align (rows / columns) is numbered on every row unless `numbered: false` (Alt+M N) — the rows
   * listed in `unnumberedRows` (0-based) lose their number one by one (Alt+M Shift+N on that row).
   */
  const D = async (latex: string, opts: { numbered?: boolean; label?: string; unnumberedRows?: number[] } = {}) => {
    const align = latex.includes('\\\\') || latex.includes('&');
    if (align) await startAlign(page); else await startDisplayMath(page);
    await typeLatex(page, latex);
    if (align ? opts.numbered === false : opts.numbered) { await page.keyboard.press('Alt+m'); await page.waitForTimeout(60); await page.keyboard.press('n'); await page.waitForTimeout(100); }
    if (opts.unnumberedRows?.length) {
      const rows = latex.split('\\\\').length;
      let at = rows - 1;                       // the cursor ends in the last row
      for (const row of [...opts.unnumberedRows].sort((a, b) => b - a)) {
        for (; at > row; at--) { await page.keyboard.press('ArrowUp'); await page.waitForTimeout(60); }
        await page.keyboard.press('Alt+m'); await page.waitForTimeout(60); await page.keyboard.press('Shift+N'); await page.waitForTimeout(100);
      }
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(60);
    if (opts.label) await labelLastEquation(page, opts.label);
  };
  /** a display formula inside the current paragraph (an enumerate item, an algorithm step) */
  const displayHere = async (latex: string) => {
    await page.keyboard.press('Control+Shift+m');
    await expect(page.locator('.lm-field.display.focused')).toHaveCount(1, { timeout: 5000 });
    await typeLatex(page, latex);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(60);
  };
  // citations: the first mention of a paper pastes its BibTeX, later ones pick it from the project's bibliography
  const cite = async (...names: string[]) => {
    const fresh = names.filter(n => !keys[n]);
    if (fresh.length === names.length) {
      const got = await citeFromPastedBibtexMany(page, names.map(n => BIB[n]));
      names.forEach((n, i) => { keys[n] = got[i]; });
    } else {
      if (fresh.length) throw new Error('mixing new and known references in one citation: ' + names.join(','));
      await citeExisting(page, names.map(n => `[${keys[n]}]`));
    }
  };
  const figure = async (pngs: string[], caption: () => Promise<void>, label: string) => {
    await P();
    await insertFloat(page, 'Figure');
    for (const png of pngs) await uploadGraphics(page, png);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(100);
    await typeCaption(page, caption, label);
    await leaveFloat(page);
  };
  return { T, M, P, section, subsection, parHeading, bold, emph, ref, eqref, footnote, D, displayHere, cite, figure };
}

test.beforeEach(async ({ page }) => { await login(page); });

/* ================================================================== session 1: front matter, sections 1 and 2 */
test('writing "Auto-Encoding Variational Bayes" from a blank document: abstract, introduction and the method', async ({ page }) => {
  test.setTimeout(1200000);
  const errors = collectErrors(page);
  await freshPaper(page, PROJECT, 'vae.tex', 'Auto-Encoding Variational Bayes', { resetBib: true });
  for (const f of [KEYS_FILE, `${DIR}/.part1`, `${DIR}/.complete`, `${DIR}/.appendix`]) rmSync(f, { force: true });   // markers of an earlier run
  rmSync(`${DIR}/figures`, { recursive: true, force: true });
  mkdirSync(FIGS, { recursive: true });
  placeholderPng(`${FIGS}/vae-model.png`, 240, 160, [90, 90, 90]);
  placeholderPng(`${FIGS}/vae-lowerbound.png`, 640, 260, [70, 130, 180]);
  placeholderPng(`${FIGS}/vae-marginal.png`, 560, 220, [60, 160, 90]);
  placeholderPng(`${FIGS}/vae-manifold-frey.png`, 300, 300, [170, 90, 60]);
  placeholderPng(`${FIGS}/vae-manifold-mnist.png`, 300, 300, [120, 60, 170]);
  placeholderPng(`${FIGS}/vae-samples.png`, 640, 170, [80, 80, 140]);
  await openPaper(page, PROJECT, 'vae.tex');
  const keys: Record<string, string> = {};
  const { T, M, P, section, subsection, bold, emph, ref, eqref, footnote, D, cite } = tools(page, keys);

  /* --- abstract --------------------------------------------------------------------- */
  await afterAuthor(page);
  await setLayout(page, 'a');
  await T('How can we perform efficient inference and learning in directed probabilistic models, in the presence of continuous latent variables with intractable posterior distributions, and large datasets? We introduce a stochastic variational inference and learning algorithm that scales to large datasets and, under some mild differentiability conditions, even works in the intractable case. Our contributions are two-fold. First, we show that a reparameterization of the variational lower bound yields a lower bound estimator that can be straightforwardly optimized using standard stochastic gradient methods. Second, we show that for i.i.d. datasets with continuous latent variables per datapoint, posterior inference can be made especially efficient by fitting an approximate inference model (also called a recognition model) to the intractable posterior using the proposed lower bound estimator. Theoretical advantages are reflected in experimental results.');
  await expect(page.locator('.lyx-layout-abstract')).toContainText('recognition model');

  /* --- 1 Introduction --------------------------------------------------------------- */
  await section('Introduction');
  await T('How can we perform efficient approximate inference and learning with directed probabilistic models whose continuous latent variables and/or parameters have intractable posterior distributions? The variational Bayesian (VB) approach involves the optimization of an approximation to the intractable posterior. Unfortunately, the common mean-field approach requires analytical solutions of expectations w.r.t. the approximate posterior, which are also intractable in the general case. We show how a reparameterization of the variational lower bound yields a simple differentiable unbiased estimator of the lower bound; this SGVB (Stochastic Gradient Variational Bayes) estimator can be used for efficient approximate posterior inference in almost any model with continuous latent variables and/or parameters, and is straightforward to optimize using standard stochastic gradient ascent techniques.');
  await P();
  await T('For the case of an i.i.d. dataset and continuous latent variables per datapoint, we propose the Auto-Encoding VB (AEVB) algorithm. In the AEVB algorithm we make inference and learning especially efficient by using the SGVB estimator to optimize a recognition model that allows us to perform very efficient approximate posterior inference using simple ancestral sampling, which in turn allows us to efficiently learn the model parameters, without the need of expensive iterative inference schemes (such as MCMC) per datapoint. The learned approximate posterior inference model can also be used for a host of tasks such as recognition, denoising, representation and visualization purposes. When a neural network is used for the recognition model, we arrive at the ');
  await emph('variational auto-encoder');
  await T('.');

  /* --- 2 Method --------------------------------------------------------------------- */
  await section('Method', 'sec:method');
  await T('The strategy in this section can be used to derive a lower bound estimator (a stochastic objective function) for a variety of directed graphical models with continuous latent variables. We will restrict ourselves here to the common case where we have an i.i.d. dataset with latent variables per datapoint, and where we like to perform maximum likelihood (ML) or maximum a posteriori (MAP) inference on the (global) parameters, and variational inference on the latent variables. It is, for example, straightforward to extend this scenario to the case where we also perform variational inference on the global parameters; that algorithm is put in the appendix, but experiments with that case are left to future work. Note that our method can be applied to online, non-stationary settings, e.g. streaming data, but here we assume a fixed dataset for simplicity.');
  // Figure 1: the graphical model
  await P();
  await insertFloat(page, 'Figure');
  await uploadGraphics(page, `${FIGS}/vae-model.png`);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(100);
  await typeCaption(page, async () => {
    await T('The type of directed graphical model under consideration. Solid lines denote the generative model ');
    await M(r`p_{\theta}(z)p_{\theta}(x|z)`);
    await T(', dashed lines denote the variational approximation ');
    await M(r`q_{\phi}(z|x)`);
    await T(' to the intractable posterior ');
    await M(r`p_{\theta}(z|x)`);
    await T('. The variational parameters ');
    await M(r`\phi`);
    await T(' are learned jointly with the generative model parameters ');
    await M(r`\theta`);
    await T('.');
  }, 'fig:model');
  await leaveFloat(page);

  // 2.1
  await subsection('Problem scenario', 'sec:problem');
  await T('Let us consider some dataset ');
  await M(r`X=\lbrace x^{(i)}\rbrace_{i=1}^{N}`);
  await T(' consisting of ');
  await M('N');
  await T(' i.i.d. samples of some continuous or discrete variable ');
  await M('x');
  await T('. We assume that the data are generated by some random process, involving an unobserved continuous random variable ');
  await M('z');
  await T('. The process consists of two steps: (1) a value ');
  await M(r`z^{(i)}`);
  await T(' is generated from some prior distribution ');
  await M(r`p_{\theta^{*}}(z)`);
  await T('; (2) a value ');
  await M(r`x^{(i)}`);
  await T(' is generated from some conditional distribution ');
  await M(r`p_{\theta^{*}}(x|z)`);
  await T('. We assume that the prior ');
  await M(r`p_{\theta^{*}}(z)`);
  await T(' and likelihood ');
  await M(r`p_{\theta^{*}}(x|z)`);
  await T(' come from parametric families of distributions ');
  await M(r`p_{\theta}(z)`);
  await T(' and ');
  await M(r`p_{\theta}(x|z)`);
  await T(', and that their PDFs are differentiable almost everywhere w.r.t. both ');
  await M(r`\theta`);
  await T(' and ');
  await M('z');
  await T('. Unfortunately, a lot of this process is hidden from our view: the true parameters ');
  await M(r`\theta^{*}`);
  await T(' as well as the values of the latent variables ');
  await M(r`z^{(i)}`);
  await T(' are unknown to us.');
  await P();
  await T('Very importantly, we do not make the common simplifying assumptions about the marginal or posterior probabilities. Conversely, we are here interested in a general algorithm that even works efficiently in the case of:');
  await P();
  await setLayout(page, 'e');
  await bold('Intractability');
  await T(': the case where the integral of the marginal likelihood ');
  await M(r`p_{\theta}(x)=\int p_{\theta}(z)p_{\theta}(x|z)dz`);
  await T(' is intractable (so we cannot evaluate or differentiate the marginal likelihood), where the true posterior density ');
  await M(r`p_{\theta}(z|x)=p_{\theta}(x|z)p_{\theta}(z)/p_{\theta}(x)`);
  await T(' is intractable (so the EM algorithm cannot be used), and where the required integrals for any reasonable mean-field VB algorithm are also intractable. These intractabilities are quite common and appear in cases of moderately complicated likelihood functions ');
  await M(r`p_{\theta}(x|z)`);
  await T(', e.g. a neural network with a nonlinear hidden layer.');
  await P();
  await bold('A large dataset');
  await T(': we have so much data that batch optimization is too costly; we would like to make parameter updates using small minibatches or even single datapoints. Sampling-based solutions, e.g. Monte Carlo EM, would in general be too slow, since it involves a typically expensive sampling loop per datapoint.');
  await P();
  await setLayout(page, 's');
  await T('We are interested in, and propose a solution to, three related problems in the above scenario:');
  await P();
  await setLayout(page, 'e');
  await T('Efficient approximate ML or MAP estimation for the parameters ');
  await M(r`\theta`);
  await T('. The parameters can be of interest themselves, e.g. if we are analyzing some natural process. They also allow us to mimic the hidden random process and generate artificial data that resembles the real data.');
  await P();
  await T('Efficient approximate posterior inference of the latent variable ');
  await M('z');
  await T(' given an observed value ');
  await M('x');
  await T(' for a choice of parameters ');
  await M(r`\theta`);
  await T('. This is useful for coding or data representation tasks.');
  await P();
  await T('Efficient approximate marginal inference of the variable ');
  await M('x');
  await T('. This allows us to perform all kinds of inference tasks where a prior over ');
  await M('x');
  await T(' is required. Common applications in computer vision include image denoising, inpainting and super-resolution.');
  await expect(page.locator('.lyx-layout-enumerate')).toHaveCount(5);
  expect(await page.locator('.lyx-layout-enumerate').evaluateAll(els => els.map(e => e.getAttribute('data-label')))).toEqual(['1.', '2.', '1.', '2.', '3.']);   // the second list restarts
  await P();
  await setLayout(page, 's');
  await T('For the purpose of solving the above problems, let us introduce a recognition model ');
  await M(r`q_{\phi}(z|x)`);
  await T(': an approximation to the intractable true posterior ');
  await M(r`p_{\theta}(z|x)`);
  await T('. Note that in contrast with the approximate posterior in mean-field variational inference, it is not necessarily factorial and its parameters ');
  await M(r`\phi`);
  await T(" are not computed from some closed-form expectation. Instead, we'll introduce a method for learning the recognition model parameters ");
  await M(r`\phi`);
  await T(' jointly with the generative model parameters ');
  await M(r`\theta`);
  await T('.');
  await P();
  await T('From a coding theory perspective, the unobserved variables ');
  await M('z');
  await T(' have an interpretation as a latent representation or ');
  await emph('code');
  await T('. In this paper we will therefore also refer to the recognition model ');
  await M(r`q_{\phi}(z|x)`);
  await T(' as a probabilistic ');
  await emph('encoder');
  await T(', since given a datapoint ');
  await M('x');
  await T(' it produces a distribution (e.g. a Gaussian) over the possible values of the code ');
  await M('z');
  await T(' from which the datapoint ');
  await M('x');
  await T(' could have been generated. In a similar vein we will refer to ');
  await M(r`p_{\theta}(x|z)`);
  await T(' as a probabilistic ');
  await emph('decoder');
  await T(', since given a code ');
  await M('z');
  await T(' it produces a distribution over the possible corresponding values of ');
  await M('x');
  await T('.');

  // 2.2
  await subsection('The variational bound', 'sec:bound');
  await T('The marginal likelihood is composed of a sum over the marginal likelihoods of individual datapoints ');
  await M(r`\log p_{\theta}(x^{(1)},\cdots,x^{(N)})=\sum_{i=1}^{N}\log p_{\theta}(x^{(i)})`);
  await T(', which can each be rewritten as:');
  await D(r`\log p_{\theta}(x^{(i)})=D_{KL}(q_{\phi}(z|x^{(i)})\Vert p_{\theta}(z|x^{(i)}))+\mathcal{L}(\theta,\phi;x^{(i)})`, { numbered: true, label: 'eq:marginal' });
  await P();
  await T('The first RHS term is the KL divergence of the approximate from the true posterior. Since this KL-divergence is non-negative, the second RHS term ');
  await M(r`\mathcal{L}(\theta,\phi;x^{(i)})`);
  await T(' is called the (variational) ');
  await emph('lower bound');
  await T(' on the marginal likelihood of datapoint ');
  await M('i');
  await T(', and can be written as:');
  await D(r`\log p_{\theta}(x^{(i)})\geq\mathcal{L}(\theta,\phi;x^{(i)})=\mathbb{E}_{q_{\phi}(z|x)}\left[-\log q_{\phi}(z|x)+\log p_{\theta}(x,z)\right]`, { numbered: true, label: 'eq:lb' });
  await P();
  await T('which can also be written as:');
  await D(r`\mathcal{L}(\theta,\phi;x^{(i)})=-D_{KL}(q_{\phi}(z|x^{(i)})\Vert p_{\theta}(z))+\mathbb{E}_{q_{\phi}(z|x^{(i)})}\left[\log p_{\theta}(x^{(i)}|z)\right]`, { numbered: true, label: 'eq:lb2' });
  await P();
  await T('We want to differentiate and optimize the lower bound ');
  await M(r`\mathcal{L}(\theta,\phi;x^{(i)})`);
  await T(' w.r.t. both the variational parameters ');
  await M(r`\phi`);
  await T(' and generative parameters ');
  await M(r`\theta`);
  await T('. However, the gradient of the lower bound w.r.t. ');
  await M(r`\phi`);
  await T(' is a bit problematic. The usual (naive) Monte Carlo gradient estimator for this type of problem is: ');
  await M(r`\nabla_{\phi}\mathbb{E}_{q_{\phi}(z)}\left[f(z)\right]=\mathbb{E}_{q_{\phi}(z)}\left[f(z)\nabla_{q_{\phi}(z)}\log q_{\phi}(z)\right]\simeq\frac{1}{L}\sum_{l=1}^{L}f(z)\nabla_{q_{\phi}(z^{(l)})}\log q_{\phi}(z^{(l)})`);
  await T(' where ');
  await M(r`z^{(l)}\sim q_{\phi}(z|x^{(i)})`);
  await T('. This gradient estimator exhibits very high variance (see e.g. ');
  await cite('blei2012variational');
  await T(') and is impractical for our purposes.');

  // 2.3
  await subsection('The SGVB estimator and AEVB algorithm', 'sec:sgvb');
  await T('In this section we introduce a practical estimator of the lower bound and its derivatives w.r.t. the parameters. We assume an approximate posterior in the form ');
  await M(r`q_{\phi}(z|x)`);
  await T(', but please note that the technique can be applied to the case ');
  await M(r`q_{\phi}(z)`);
  await T(', i.e. where we do not condition on ');
  await M('x');
  await T(', as well. The fully variational Bayesian method for inferring a posterior over the parameters is given in the appendix.');
  await P();
  await T('Under certain mild conditions outlined in section ');
  await ref('sec:reparam');   // a forward reference to 2.4
  await T(' for a chosen approximate posterior ');
  await M(r`q_{\phi}(z|x)`);
  await T(' we can reparameterize the random variable ');
  await M(r`\tilde{z}\sim q_{\phi}(z|x)`);
  await T(' using a differentiable transformation ');
  await M(r`g_{\phi}(\epsilon,x)`);
  await T(' of an (auxiliary) noise variable ');
  await M(r`\epsilon`);
  await T(':');
  await D(r`\tilde{z}=g_{\phi}(\epsilon,x)\quad\mathrm{with}\quad\epsilon\sim p(\epsilon)`, { numbered: true, label: 'eq:reparam' });
  await P();
  await T('See section ');
  await ref('sec:reparam');
  await T(' for general strategies for chosing such an approriate distribution ');
  await M(r`p(\epsilon)`);
  await T(' and function ');
  await M(r`g_{\phi}(\epsilon,x)`);
  await T('. We can now form Monte Carlo estimates of expectations of some function ');
  await M('f(z)');
  await T(' w.r.t. ');
  await M(r`q_{\phi}(z|x)`);
  await T(' as follows:');
  await D(r`\mathbb{E}_{q_{\phi}(z|x^{(i)})}\left[f(z)\right]=\mathbb{E}_{p(\epsilon)}\left[f(g_{\phi}(\epsilon,x^{(i)}))\right]\simeq\frac{1}{L}\sum_{l=1}^{L}f(g_{\phi}(\epsilon^{(l)},x^{(i)}))\quad\mathrm{where}\quad\epsilon^{(l)}\sim p(\epsilon)`, { numbered: true, label: 'eq:mc' });
  await P();
  await T('We apply this technique to the variational lower bound (eq. ');
  await eqref('eq:lb');
  await T('), yielding our generic Stochastic Gradient Variational Bayes (SGVB) estimator ');
  await M(r`\tilde{\mathcal{L}}^{A}(\theta,\phi;x^{(i)})\simeq\mathcal{L}(\theta,\phi;x^{(i)})`);
  await T(':');
  await D(r`\tilde{\mathcal{L}}^{A}(\theta,\phi;x^{(i)}) & =\frac{1}{L}\sum_{l=1}^{L}\log p_{\theta}(x^{(i)},z^{(i,l)})-\log q_{\phi}(z^{(i,l)}|x^{(i)})\\ \mathrm{where}\quad z^{(i,l)} & =g_{\phi}(\epsilon^{(i,l)},x^{(i)})\quad\mathrm{and}\quad\epsilon^{(l)}\sim p(\epsilon)`, { label: 'eq:sgvb-a', unnumberedRows: [0] });

  // Algorithm 1
  await P();
  await insertFloat(page, 'Algorithm');
  await M(r`\theta,\phi\leftarrow`);
  await T(' Initialize parameters');
  await P();
  await bold('repeat');
  await P();
  await setLayout(page, 'i');
  await M(r`X^{M}\leftarrow`);
  await T(' Random minibatch of ');
  await M('M');
  await T(' datapoints (drawn from full dataset)');
  await P();
  await M(r`\epsilon\leftarrow`);
  await T(' Random samples from noise distribution ');
  await M(r`p(\epsilon)`);
  await P();
  await M(r`g\leftarrow\nabla_{\theta,\phi}\tilde{\mathcal{L}}^{M}(\theta,\phi;X^{M},\epsilon)`);
  await T(' (Gradients of minibatch estimator ');
  await eqref('eq:minibatch');   // forward reference to (8)
  await T(')');
  await P();
  await M(r`\theta,\phi\leftarrow`);
  await T(' Update parameters using gradients ');
  await M('g');
  await T(' (e.g. SGD or Adagrad ');
  await cite('duchi2010adaptive');
  await T(')');
  await P();
  await setLayout(page, 's');
  await bold('until');
  await T(' convergence of parameters ');
  await M(r`(\theta,\phi)`);
  await P();
  await bold('return');
  await T(' ');
  await M(r`\theta,\phi`);
  await page.keyboard.press('ArrowDown');   // into the caption
  await page.waitForTimeout(100);
  await typeCaption(page, async () => {
    await T('Minibatch version of the Auto-Encoding VB (AEVB) algorithm. Either of the two SGVB estimators in section ');
    await ref('sec:sgvb');
    await T(' can be used. We use settings ');
    await M('M=100');
    await T(' and ');
    await M('L=1');
    await T(' in experiments.');
  }, 'alg:aevb');
  await leaveFloat(page);

  await P();
  await T('Often, the KL-divergence ');
  await M(r`D_{KL}(q_{\phi}(z|x^{(i)})\Vert p_{\theta}(z))`);
  await T(' of eq. ');
  await eqref('eq:lb2');
  await T(' can be integrated analytically (see appendix ');
  await ref('app:kl');   // forward reference into the appendix, typed in a later session
  await T('), such that only the expected reconstruction error ');
  await M(r`\mathbb{E}_{q_{\phi}(z|x^{(i)})}\left[\log p_{\theta}(x^{(i)}|z)\right]`);
  await T(' requires estimation by sampling. The KL-divergence term can then be interpreted as regularizing ');
  await M(r`\phi`);
  await T(', encouraging the approximate posterior to be close to the prior ');
  await M(r`p_{\theta}(z)`);
  await T('. This yields a second version of the SGVB estimator ');
  await M(r`\tilde{\mathcal{L}}^{B}(\theta,\phi;x^{(i)})\simeq\mathcal{L}(\theta,\phi;x^{(i)})`);
  await T(', corresponding to eq. ');
  await eqref('eq:lb2');
  await T(', which typically has less variance than the generic estimator:');
  await D(r`\tilde{\mathcal{L}}^{B}(\theta,\phi;x^{(i)}) & =-D_{KL}(q_{\phi}(z|x^{(i)})\Vert p_{\theta}(z))+\frac{1}{L}\sum_{l=1}^{L}(\log p_{\theta}(x^{(i)}|z^{(i,l)}))\\ \mathrm{where}\quad z^{(i,l)} & =g_{\phi}(\epsilon^{(i,l)},x^{(i)})\quad\mathrm{and}\quad\epsilon^{(l)}\sim p(\epsilon)`, { label: 'eq:sgvb-b', unnumberedRows: [0] });
  await P();
  await T('Given multiple datapoints from a dataset ');
  await M('X');
  await T(' with ');
  await M('N');
  await T(' datapoints, we can construct an estimator of the marginal likelihood lower bound of the full dataset, based on minibatches:');
  await D(r`\mathcal{L}(\theta,\phi;X)\simeq\tilde{\mathcal{L}}^{M}(\theta,\phi;X^{M})=\frac{N}{M}\sum_{i=1}^{M}\tilde{\mathcal{L}}(\theta,\phi;x^{(i)})`, { numbered: true, label: 'eq:minibatch' });
  await P();
  await T('where the minibatch ');
  await M(r`X^{M}=\lbrace x^{(i)}\rbrace_{i=1}^{M}`);
  await T(' is a randomly drawn sample of ');
  await M('M');
  await T(' datapoints from the full dataset ');
  await M('X');
  await T(' with ');
  await M('N');
  await T(' datapoints. In our experiments we found that the number of samples ');
  await M('L');
  await T(' per datapoint can be set to 1 as long as the minibatch size ');
  await M('M');
  await T(' was large enough, e.g. ');
  await M('M=100');
  await T('. Derivatives ');
  await M(r`\nabla_{\theta,\phi}\tilde{\mathcal{L}}(\theta;X^{M})`);
  await T(' can be taken, and the resulting gradients can be used in conjunction with stochastic optimization methods such as SGD or Adagrad ');
  await cite('duchi2010adaptive');
  await T('. See algorithm ');
  await ref('alg:aevb');
  await T(' for a basic approach to compute the stochastic gradients.');
  await P();
  await T('A connection with auto-encoders becomes clear when looking at the objective function given at eq. ');
  await eqref('eq:sgvb-b');
  await T('. The first term is (the KL divergence of the approximate posterior from the prior) acts as a regularizer, while the second term is a an expected negative reconstruction error. The function ');
  await M(r`g_{\phi}(.)`);
  await T(' is chosen such that it maps a datapoint ');
  await M(r`x^{(i)}`);
  await T(' and a random noise vector ');
  await M(r`\epsilon^{(l)}`);
  await T(' to a sample from the approximate posterior for that datapoint: ');
  await M(r`z^{(i,l)}=g_{\phi}(\epsilon^{(l)},x^{(i)})`);
  await T(' where ');
  await M(r`z^{(i,l)}\sim q_{\phi}(z|x^{(i)})`);
  await T('. Subsequently, the sample ');
  await M(r`z^{(i,l)}`);
  await T(' is then input to function ');
  await M(r`\log p_{\theta}(x^{(i)}|z^{(i,l)})`);
  await T(', which equals the probability density (or mass) of datapoint ');
  await M(r`x^{(i)}`);
  await T(' under the generative model, given ');
  await M(r`z^{(i,l)}`);
  await T('. This term is a negative reconstruction error in auto-encoder parlance.');

  // 2.4
  await subsection('The reparameterization trick', 'sec:reparam');
  await T('In order to solve our problem we invoked an alternative method for generating samples from ');
  await M(r`q_{\phi}(z|x)`);
  await T('. The essential parameterization trick is quite simple. Let ');
  await M('z');
  await T(' be a continuous random variable, and ');
  await M(r`z\sim q_{\phi}(z|x)`);
  await T(' be some conditional distribution. It is then often possible to express the random variable ');
  await M('z');
  await T(' as a deterministic variable ');
  await M(r`z=g_{\phi}(\epsilon,x)`);
  await T(', where ');
  await M(r`\epsilon`);
  await T(' is an auxiliary variable with independent marginal ');
  await M(r`p(\epsilon)`);
  await T(', and ');
  await M(r`g_{\phi}(.)`);
  await T(' is some vector-valued function parameterized by ');
  await M(r`\phi`);
  await T('.');
  await P();
  await T('This reparameterization is useful for our case since it can be used to rewrite an expectation w.r.t ');
  await M(r`q_{\phi}(z|x)`);
  await T(' such that the Monte Carlo estimate of the expectation is differentiable w.r.t. ');
  await M(r`\phi`);
  await T('. A proof is as follows. Given the deterministic mapping ');
  await M(r`z=g_{\phi}(\epsilon,x)`);
  await T(' we know that ');
  await M(r`q_{\phi}(z|x)\prod_{i}dz_{i}=p(\epsilon)\prod_{i}d\epsilon_{i}`);
  await T('. Therefore');
  await footnote(async () => { await T('Note that for infinitesimals we use the notational convention '); await M(r`dz=\prod_{i}dz_{i}`); });
  await T(', ');
  await M(r`\int q_{\phi}(z|x)f(z)dz=\int p(\epsilon)f(z)d\epsilon=\int p(\epsilon)f(g_{\phi}(\epsilon,x))d\epsilon`);
  await T('. It follows that a differentiable estimator can be constructed: ');
  await M(r`\int q_{\phi}(z|x)f(z)dz\simeq\frac{1}{L}\sum_{l=1}^{L}f(g_{\phi}(x,\epsilon^{(l)}))`);
  await T(' where ');
  await M(r`\epsilon^{(l)}\sim p(\epsilon)`);
  await T('. In section ');
  await ref('sec:sgvb');
  await T(' we applied this trick to obtain a differentiable estimator of the variational lower bound.');
  await P();
  await T('Take, for example, the univariate Gaussian case: let ');
  await M(r`z\sim p(z|x)=\mathcal{N}(\mu,\sigma^{2})`);
  await T('. In this case, a valid reparameterization is ');
  await M(r`z=\mu+\sigma\epsilon`);
  await T(', where ');
  await M(r`\epsilon`);
  await T(' is an auxiliary noise variable ');
  await M(r`\epsilon\sim\mathcal{N}(0,1)`);
  await T('. Therefore, ');
  await M(r`\mathbb{E}_{\mathcal{N}(z;\mu,\sigma^{2})}\left[f(z)\right]=\mathbb{E}_{\mathcal{N}(\epsilon;0,1)}\left[f(\mu+\sigma\epsilon)\right]\simeq\frac{1}{L}\sum_{l=1}^{L}f(\mu+\sigma\epsilon^{(l)})`);
  await T(' where ');
  await M(r`\epsilon^{(l)}\sim\mathcal{N}(0,1)`);
  await T('.');
  await P();
  await T('For which ');
  await M(r`q_{\phi}(z|x)`);
  await T(' can we choose such a differentiable transformation ');
  await M(r`g_{\phi}(.)`);
  await T(' and auxiliary variable ');
  await M(r`\epsilon\sim p(\epsilon)`);
  await T('? Three basic approaches are:');
  await P();
  await setLayout(page, 'e');
  await T('Tractable inverse CDF. In this case, let ');
  await M(r`\epsilon\sim\mathcal{U}(0,I)`);
  await T(', and let ');
  await M(r`g_{\phi}(\epsilon,x)`);
  await T(' be the inverse CDF of ');
  await M(r`q_{\phi}(z|x)`);
  await T('. Examples: Exponential, Cauchy, Logistic, Rayleigh, Pareto, Weibull, Reciprocal, Gompertz, Gumbel and Erlang distributions.');
  await P();
  await T('Analogous to the Gaussian example, for any "location-scale" family of distributions we can choose the standard distribution (with location ');
  await M('=0');
  await T(', scale ');
  await M('=1');
  await T(') as the auxiliary variable ');
  await M(r`\epsilon`);
  await T(', and let ');
  await M('g(.)=');
  await T(' location ');
  await M('+');
  await T(' scale ');
  await M(r`\cdot\epsilon`);
  await T(". Examples: Laplace, Elliptical, Student's t, Logistic, Uniform, Triangular and Gaussian distributions.");
  await P();
  await T('Composition: It is often possible to express random variables as different transformations of auxiliary variables. Examples: Log-Normal (exponentiation of normally distributed variable), Gamma (a sum over exponentially distributed variables), Dirichlet (weighted sum of Gamma variates), Beta, Chi-Squared, and F distributions.');
  await P();
  await setLayout(page, 's');
  await T('When all three approaches fail, good approximations to the inverse CDF exist requiring computations with time complexity comparable to the PDF (see e.g. ');
  await cite('devroye1986sample');
  await T(' for some methods).');

  /* --- what the file holds ---------------------------------------------------------- */
  await expect.poll(() => fileText().includes('for some methods)'), { timeout: 20000 }).toBe(true);
  await page.waitForTimeout(2500);
  const text = fileText();
  const c = canonMath(text);
  const has = (latex: string) => expect(c, `expected the formula ${latex}`).toContain(canonMath(latex));
  expect(text).toMatch(/\\begin\{abstract\}\nHow can we perform efficient inference[\s\S]*experimental results\.\n\\end\{abstract\}/);
  for (const s of ['\\section{Introduction}', '\\section{Method}\\label{sec:method}', '\\subsection{Problem scenario}\\label{sec:problem}', '\\subsection{The variational bound}\\label{sec:bound}',
    '\\subsection{The SGVB estimator and AEVB algorithm}\\label{sec:sgvb}', '\\subsection{The reparameterization trick}\\label{sec:reparam}']) expect(text).toContain(s);
  expect(text).toMatch(/we arrive at the \\emph\{variational auto-encoder\}\./);
  expect(text).toMatch(/\\includegraphics\[width=1\\columnwidth\]\{figures\/vae-model\.png\}[\s\S]*\\caption\{The type of directed graphical model under consideration\. Solid lines denote the generative model \$p_\{\\theta\}\(z\)p_\{\\theta\}\(x\|z\)\$[\s\S]*parameters \$\\theta\$\.\}\\label\{fig:model\}/);
  // the two enumerates of 2.1, the one of 2.4
  expect((text.match(/\\begin\{enumerate\}/g) ?? []).length).toBe(3);
  expect(text).toMatch(/\\begin\{enumerate\}\n\\item \\textbf\{Intractability\}: the case where the integral of the marginal likelihood \$p_\{\\theta\}\(x\)=\\int p_\{\\theta\}\(z\)p_\{\\theta\}\(x\|z\)dz\$ is intractable[\s\S]*\n\\item \\textbf\{A large dataset\}: we have so much data[\s\S]*per datapoint\.\n\\end\{enumerate\}\n+We are interested in, and propose a solution to, three related problems in the above scenario:\n+\\begin\{enumerate\}\n\\item Efficient approximate ML or MAP estimation/);
  has(r`$X=\lbrace x^{(i)}\rbrace_{i=1}^{N}$`);
  has(r`$p_{\theta^{*}}(x|z)$`);
  expect(text).toMatch(/as a probabilistic \\emph\{encoder\}, since given a datapoint/);
  // the numbered equations of 2.2 and 2.3, with their labels and \eqref references
  has(r`\begin{equation}\log p_{\theta}(x^{(i)})=D_{KL}(q_{\phi}(z|x^{(i)})\Vert p_{\theta}(z|x^{(i)}))+\mathcal{L}(\theta,\phi;x^{(i)})\label{eq:marginal}\end{equation}`);
  has(r`\begin{equation}\log p_{\theta}(x^{(i)})\geq\mathcal{L}(\theta,\phi;x^{(i)})=\mathbb{E}_{q_{\phi}(z|x)}\left[-\log q_{\phi}(z|x)+\log p_{\theta}(x,z)\right]\label{eq:lb}\end{equation}`);
  has(r`\begin{equation}\tilde{z}=g_{\phi}(\epsilon,x)\quad\mathrm{with}\quad\epsilon\sim p(\epsilon)\label{eq:reparam}\end{equation}`);
  has(r`$\nabla_{\phi}\mathbb{E}_{q_{\phi}(z)}\left[f(z)\right]=\mathbb{E}_{q_{\phi}(z)}\left[f(z)\nabla_{q_{\phi}(z)}\log q_{\phi}(z)\right]\simeq\frac{1}{L}\sum_{l=1}^{L}f(z)\nabla_{q_{\phi}(z^{(l)})}\log q_{\phi}(z^{(l)})$`);
  expect(text).toMatch(/outlined in section \\ref\{sec:reparam\} for a chosen/);
  expect(text).toMatch(/lower bound \(eq\. \\eqref\{eq:lb\}\), yielding/);
  // the two-row aligns: the "where" row carries the number and the label, the first row none
  has(r`\begin{align}\tilde{\mathcal{L}}^{A}(\theta,\phi;x^{(i)}) & =\frac{1}{L}\sum_{l=1}^{L}\log p_{\theta}(x^{(i)},z^{(i,l)})-\log q_{\phi}(z^{(i,l)}|x^{(i)})\nonumber \\ \mathrm{where}\quad z^{(i,l)} & =g_{\phi}(\epsilon^{(i,l)},x^{(i)})\quad\mathrm{and}\quad\epsilon^{(l)}\sim p(\epsilon)\label{eq:sgvb-a}\end{align}`);
  has(r`\begin{align}\tilde{\mathcal{L}}^{B}(\theta,\phi;x^{(i)}) & =-D_{KL}(q_{\phi}(z|x^{(i)})\Vert p_{\theta}(z))+\frac{1}{L}\sum_{l=1}^{L}(\log p_{\theta}(x^{(i)}|z^{(i,l)}))\nonumber \\ \mathrm{where}\quad z^{(i,l)} & =g_{\phi}(\epsilon^{(i,l)},x^{(i)})\quad\mathrm{and}\quad\epsilon^{(l)}\sim p(\epsilon)\label{eq:sgvb-b}\end{align}`);
  has(r`\begin{equation}\mathcal{L}(\theta,\phi;X)\simeq\tilde{\mathcal{L}}^{M}(\theta,\phi;X^{M})=\frac{N}{M}\sum_{i=1}^{M}\tilde{\mathcal{L}}(\theta,\phi;x^{(i)})\label{eq:minibatch}\end{equation}`);
  // Algorithm 1: keywords in bold, the steps as a bullet list, a forward \eqref and a citation inside
  expect(text).toMatch(new RegExp(`\\\\begin\\{algorithm\\}\\n\\$\\\\theta,\\\\phi\\\\leftarrow\\$ Initialize parameters\\n\\n\\\\textbf\\{repeat\\}\\n\\\\begin\\{itemize\\}\\n\\\\item \\$X\\^\\{M\\}\\\\leftarrow\\$ Random minibatch of \\$M\\$ datapoints \\(drawn from full dataset\\)\\n\\\\item \\$\\\\epsilon\\\\leftarrow\\$ Random samples from noise distribution \\$p\\(\\\\epsilon\\)\\$\\n\\\\item \\$g\\\\leftarrow\\\\nabla_\\{\\\\theta,\\\\phi\\}\\\\tilde\\{\\\\mathcal\\{L\\}\\}\\^\\{M\\}\\(\\\\theta,\\\\phi;X\\^\\{M\\},\\\\epsilon\\)\\$ \\(Gradients of minibatch estimator \\\\eqref\\{eq:minibatch\\}\\)\\n\\\\item \\$\\\\theta,\\\\phi\\\\leftarrow\\$ Update parameters using gradients \\$g\\$ \\(e\\.g\\. SGD or Adagrad \\\\citep?\\{${keys.duchi2010adaptive}\\}\\)\\n\\\\end\\{itemize\\}\\n\\\\textbf\\{until\\} convergence of parameters \\$\\(\\\\theta,\\\\phi\\)\\$\\n\\n\\\\textbf\\{return\\} \\$\\\\theta,\\\\phi\\$\\n+\\\\caption\\{Minibatch version of the Auto-Encoding VB \\(AEVB\\) algorithm\\. Either of the two SGVB estimators in section (\\\\protect)?\\\\ref\\{sec:sgvb\\} can be used\\. We use settings \\$M=100\\$ and \\$L=1\\$ in experiments\\.\\}\\\\label\\{alg:aevb\\}\\n\\\\end\\{algorithm\\}`));
  expect(text).toMatch(/\(see appendix \\ref\{app:kl\}\), such that/);
  expect(text).toMatch(/such as SGD or Adagrad \\citep?\{[^}]+\}\. See algorithm \\ref\{alg:aevb\} for a basic/);
  // 2.4: the footnote with a formula, the products and integrals
  has(r`\footnote{Note that for infinitesimals we use the notational convention $dz=\prod_{i}dz_{i}$}`);
  has(r`$q_{\phi}(z|x)\prod_{i}dz_{i}=p(\epsilon)\prod_{i}d\epsilon_{i}$`);
  has(r`$\int q_{\phi}(z|x)f(z)dz\simeq\frac{1}{L}\sum_{l=1}^{L}f(g_{\phi}(x,\epsilon^{(l)}))$`);
  has(r`$\mathbb{E}_{\mathcal{N}(z;\mu,\sigma^{2})}\left[f(z)\right]=\mathbb{E}_{\mathcal{N}(\epsilon;0,1)}\left[f(\mu+\sigma\epsilon)\right]\simeq\frac{1}{L}\sum_{l=1}^{L}f(\mu+\sigma\epsilon^{(l)})$`);
  expect(text).toMatch(/for any ``location-scale'' family of distributions/);
  expect(text).toMatch(/Student's t, Logistic/);
  expect(text).toMatch(new RegExp(`\\(see e\\.g\\. \\\\citep?\\{${keys.devroye1986sample}\\} for some methods\\)\\.`));
  expect(Object.keys(keys).length).toBe(3);
  await expect(page.locator('.katex-error')).toHaveCount(0);
  expect(noErrors(errors)).toEqual([]);
  writeFileSync(KEYS_FILE, JSON.stringify(keys));
  writeFileSync(`${DIR}/.part1`, 'vae');
});

/* ================================================================== session 2: sections 3–7 and the bibliography */
test('writing "Auto-Encoding Variational Bayes", the example, related work, experiments, conclusion and the bibliography', async ({ page }) => {
  test.skip(!existsSync(`${DIR}/.part1`), 'the first sections were not typed');
  test.setTimeout(1200000);
  const errors = collectErrors(page);
  const keys: Record<string, string> = JSON.parse(readFileSync(KEYS_FILE, 'utf8'));
  const { T, M, P, section, parHeading, ref, eqref, footnote, D, cite, figure } = tools(page, keys);
  await openPaper(page, PROJECT, 'vae.tex');
  await expect(page.locator('.lyx-editor .lyx-command-citation').first()).toBeVisible({ timeout: 15000 });
  await resumeAtEnd(page);

  /* --- 3 Example: Variational Auto-Encoder ------------------------------------------ */
  await section('Example: Variational Auto-Encoder', 'sec:example');
  await T("In this section we'll give an example where we use a neural network for the probabilistic encoder ");
  await M(r`q_{\phi}(z|x)`);
  await T(' (the approximation to the posterior of the generative model ');
  await M(r`p_{\theta}(x,z)`);
  await T(') and where the parameters ');
  await M(r`\phi`);
  await T(' and ');
  await M(r`\theta`);
  await T(' are optimized jointly with the AEVB algorithm.');
  await P();
  await T('Let the prior over the latent variables be the centered isotropic multivariate Gaussian ');
  await M(r`p_{\theta}(z)=\mathcal{N}(z;0,I)`);
  await T('. Note that in this case, the prior lacks parameters. We let ');
  await M(r`p_{\theta}(x|z)`);
  await T(' be a multivariate Gaussian (in case of real-valued data) or Bernoulli (in case of binary data) whose distribution parameters are computed from ');
  await M('z');
  await T(' with a MLP (a fully-connected neural network with a single hidden layer, see appendix ');
  await ref('app:mlp');
  await T('). Note the true posterior ');
  await M(r`p_{\theta}(z|x)`);
  await T(' is in this case intractable. While there is much freedom in the form ');
  await M(r`q_{\phi}(z|x)`);
  await T(", we'll assume the true (but intractable) posterior takes on a approximate Gaussian form with an approximately diagonal covariance. In this case, we can let the variational approximate posterior be a multivariate Gaussian with a diagonal covariance structure");
  await footnote('Note that this is just a (simplifying) choice, and not a limitation of our method.');
  await T(':');
  await D(r`\log q_{\phi}(z|x^{(i)})=\log\mathcal{N}(z;\mu^{(i)},\sigma^{2(i)}I)`, { numbered: true, label: 'eq:gaussian-post' });
  await P();
  await T('where the mean and s.d. of the approximate posterior, ');
  await M(r`\mu^{(i)}`);
  await T(' and ');
  await M(r`\sigma^{(i)}`);
  await T(', are outputs of the encoding MLP, i.e. nonlinear functions of datapoint ');
  await M(r`x^{(i)}`);
  await T(' and the variational parameters ');
  await M(r`\phi`);
  await T(' (see appendix ');
  await ref('app:mlp');
  await T(').');
  await P();
  await T('As explained in section ');
  await ref('sec:reparam');
  await T(', we sample from the posterior ');
  await M(r`z^{(i,l)}\sim q_{\phi}(z|x^{(i)})`);
  await T(' using ');
  await M(r`z^{(i,l)}=g_{\phi}(x^{(i)},\epsilon^{(l)})=\mu^{(i)}+\sigma^{(i)}\odot\epsilon^{(l)}`);
  await T(' where ');
  await M(r`\epsilon^{(l)}\sim\mathcal{N}(0,I)`);
  await T('. With ');
  await M(r`\odot`);
  await T(' we signify an element-wise product. In this model both ');
  await M(r`p_{\theta}(z)`);
  await T(' (the prior) and ');
  await M(r`q_{\phi}(z|x)`);
  await T(' are Gaussian; in this case, we can use the estimator of eq. ');
  await eqref('eq:sgvb-b');
  await T(' where the KL divergence can be computed and differentiated without estimation (see appendix ');
  await ref('app:kl');
  await T('). The resulting estimator for this model and datapoint ');
  await M(r`x^{(i)}`);
  await T(' is:');
  await D(r`\mathcal{L}(\theta,\phi;x^{(i)}) & \simeq\frac{1}{2}\sum_{j=1}^{J}\left(1+\log((\sigma_{j}^{(i)})^{2})-(\mu_{j}^{(i)})^{2}-(\sigma_{j}^{(i)})^{2}\right)+\frac{1}{L}\sum_{l=1}^{L}\log p_{\theta}(x^{(i)}|z^{(i,l)})\\ \mathrm{where}\quad z^{(i,l)} & =\mu^{(i)}+\sigma^{(i)}\odot\epsilon^{(l)}\quad\mathrm{and}\quad\epsilon^{(l)}\sim\mathcal{N}(0,I)`, { label: 'eq:vae-estimator', unnumberedRows: [0] });
  await P();
  await T('As explained above and in appendix ');
  await ref('app:mlp');
  await T(', the decoding term ');
  await M(r`\log p_{\theta}(x^{(i)}|z^{(i,l)})`);
  await T(' is a Bernoulli or Gaussian MLP, depending on the type of data we are modelling.');

  /* --- 4 Related work --------------------------------------------------------------- */
  await section('Related work');
  await T('The wake-sleep algorithm ');
  await cite('hinton1995wake');
  await T(' is, to the best of our knowledge, the only other on-line learning method in the literature that is applicable to the same general class of continuous latent variable models. Like our method, the wake-sleep algorithm employs a recognition model that approximates the true posterior. A drawback of the wake-sleep algorithm is that it requires a concurrent optimization of two objective functions, which together do not correspond to optimization of (a bound of) the marginal likelihood. An advantage of wake-sleep is that it also applies to models with discrete latent variables. Wake-Sleep has the same computational complexity as AEVB per datapoint.');
  await P();
  await T('Stochastic variational inference ');
  await cite('hoffman2013stochastic');
  await T(' has recently received increasing interest. Recently, ');
  await cite('blei2012variational');
  await T(' introduced a control variate schemes to reduce the high variance of the naive gradient estimator discussed in section ');
  await ref('sec:problem');
  await T(', and applied to exponential family approximations of the posterior. In ');
  await cite('ranganath2013black');
  await T(' some general methods, i.e. a control variate scheme, were introduced for reducing the variance of the original gradient estimator. In ');
  await cite('salimans2013fixed');
  await T(', a similar reparameterization as in this paper was used in an efficient version of a stochastic variational inference algorithm for learning the natural parameters of exponential-family approximating distributions.');
  await P();
  await T('The AEVB algorithm exposes a connection between directed probabilistic models (trained with a variational objective) and auto-encoders. A connection between linear auto-encoders and a certain class of generative linear-Gaussian models has long been known. In ');
  await cite('roweis1998em');
  await T(' it was shown that PCA corresponds to the maximum-likelihood (ML) solution of a special case of the linear-Gaussian model with a prior ');
  await M(r`p(z)=\mathcal{N}(0,I)`);
  await T(' and a conditional distribution ');
  await M(r`p(x|z)=\mathcal{N}(x;Wz,\epsilon I)`);
  await T(', specifically the case with infinitesimally small ');
  await M(r`\epsilon`);
  await T('.');
  await P();
  await T('In relevant recent work on autoencoders ');
  await cite('vincent2010stacked');
  await T(' it was shown that the training criterion of unregularized autoencoders corresponds to maximization of a lower bound (see the infomax principle ');
  await cite('linsker1989application');
  await T(') of the mutual information between input ');
  await M('X');
  await T(' and latent representation ');
  await M('Z');
  await T('. Maximizing (w.r.t. parameters) of the mutual information is equivalent to maximizing the conditional entropy, which is lower bounded by the expected loglikelihood of the data under the autoencoding model ');
  await cite('vincent2010stacked');
  await T(', i.e. the negative reconstrution error. However, it is well known that this reconstruction criterion is in itself not sufficient for learning useful representations ');
  await cite('bengio2013representation');
  await T('. Regularization techniques have been proposed to make autoencoders learn useful representations, such as denoising, contractive and sparse autoencoder variants ');
  await cite('bengio2013representation');
  await T('. The SGVB objective contains a regularization term dictated by the variational bound (e.g. eq. ');
  await eqref('eq:vae-estimator');
  await T('), lacking the usual nuisance regularization hyperparameter required to learn useful representations. Related are also encoder-decoder architectures such as the predictive sparse decomposition (PSD) ');
  await cite('kavukcuoglu2008fast');
  await T(', from which we drew some inspiration. Also relevant are the recently introduced Generative Stochastic Networks ');
  await cite('bengio2013deep');
  await T(' where noisy auto-encoders learn the transition operator of a Markov chain that samples from the data distribution. In ');
  await cite('salakhutdinov2010efficient');
  await T(' a recognition model was employed for efficient learning with Deep Boltzmann Machines. These methods are targeted at either unnormalized models (i.e. undirected models like Boltzmann machines) or limited to sparse coding models, in contrast to our proposed algorithm for learning a general class of directed probabilistic models.');
  await P();
  await T('The recently proposed DARN method ');
  await cite('gregor2013deep');
  await T(', also learns a directed probabilistic model using an auto-encoding structure, however their method applies to binary latent variables. Even more recently, ');
  await cite('rezende2014stochastic');
  await T(' also make the connection between auto-encoders, directed proabilistic models and stochastic variational inference using the reparameterization trick we describe in this paper. Their work was developed independently of ours and provides an additional perspective on AEVB.');

  /* --- 5 Experiments ---------------------------------------------------------------- */
  await section('Experiments', 'sec:experiments');
  await T('We trained generative models of images from the MNIST and Frey Face datasets');
  await footnote('Available at http://www.cs.nyu.edu/~roweis/data.html');
  await T(' and compared learning algorithms in terms of the variational lower bound, and the estimated marginal likelihood.');
  await P();
  await T('The generative model (encoder) and variational approximation (decoder) from section ');
  await ref('sec:example');
  await T(' were used, where the described encoder and decoder have an equal number of hidden units. Since the Frey Face data are continuous, we used a decoder with Gaussian outputs, identical to the encoder, except that the means were constrained to the interval ');
  await M('(0,1)');
  await T(' using a sigmoidal activation function at the decoder output. Note that with ');
  await emphasis(page, 'hidden units');
  await T(' we refer to the hidden layer of the neural networks of the encoder and decoder.');
  await figure([`${FIGS}/vae-lowerbound.png`], async () => {
    await T('Comparison of our AEVB method to the wake-sleep algorithm, in terms of optimizing the lower bound, for different dimensionality of latent space (');
    await M(r`N_{z}`);
    await T('). Our method converged considerably faster and reached a better solution in all experiments. Interestingly enough, more latent variables does not result in more overfitting, which is explained by the regularizing effect of the lower bound. Vertical axis: the estimated average variational lower bound per datapoint. The estimator variance was small (');
    await M('<1');
    await T(') and omitted. Horizontal axis: amount of training points evaluated. Computation took around 20-40 minutes per million training samples with a Intel Xeon CPU running at an effective 40 GFLOPS.');
  }, 'fig:lb');
  await P();
  await T('Parameters are updated using stochastic gradient ascent where gradients are computed by differentiating the lower bound estimator ');
  await M(r`\nabla_{\theta,\phi}\mathcal{L}(\theta,\phi;X)`);
  await T(' (see algorithm ');
  await ref('alg:aevb');
  await T('), plus a small weight decay term corresponding to a prior ');
  await M(r`p(\theta)=\mathcal{N}(0,I)`);
  await T('. Optimization of this objective is equivalent to approximate MAP estimation, where the likelihood gradient is approximated by the gradient of the lower bound.');
  await P();
  await T('We compared performance of AEVB to the wake-sleep algorithm ');
  await cite('hinton1995wake');
  await T('. We employed the same encoder (also called recognition model) for the wake-sleep algorithm and the variational auto-encoder. All parameters, both variational and generative, were initialized by random sampling from ');
  await M(r`\mathcal{N}(0,0.01)`);
  await T(', and were jointly stochastically optimized using the MAP criterion. Stepsizes were adapted with Adagrad ');
  await cite('duchi2010adaptive');
  await T('; the Adagrad global stepsize parameters were chosen from ');
  await M(r`\lbrace0.01,0.02,0.1\rbrace`);
  await T(' based on performance on the training set in the first few iterations. Minibatches of size ');
  await M('M=100');
  await T(' were used, with ');
  await M('L=1');
  await T(' samples per datapoint.');
  await parHeading('Likelihood lower bound');
  await T('We trained generative models (decoders) and corresponding encoders (a.k.a. recognition models) having 500 hidden units in case of MNIST, and 200 hidden units in case of the Frey Face dataset (to prevent overfitting, since it is a considerably smaller dataset). The chosen number of hidden units is based on prior literature on auto-encoders, and the relative performance of different algorithms was not very sensitive to these choices. Figure ');
  await ref('fig:lb');
  await T(' shows the results when comparing the lower bounds. Interestingly, superfluous latent variables did not result in overfitting, which is explained by the regularizing nature of the variational bound.');
  await parHeading('Marginal likelihood');
  await T('For very low-dimensional latent space it is possible to estimate the marginal likelihood of the learned generative models using an MCMC estimator. More information about the marginal likelihood estimator is available in the appendix. For the encoder and decoder we again used neural networks, this time with 100 hidden units, and 3 latent variables; for higher dimensional latent space the estimates became unreliable. Again, the MNIST dataset was used. The AEVB and Wake-Sleep methods were compared to Monte Carlo EM (MCEM) with a Hybrid Monte Carlo (HMC) ');
  await cite('duane1987hybrid');
  await T(' sampler; details are in the appendix. We compared the convergence speed for the three algorithms, for a small and large training set size. Results are in figure ');
  await ref('fig:ml');
  await T('.');
  await figure([`${FIGS}/vae-marginal.png`], async () => {
    await T("Comparison of AEVB to the wake-sleep algorithm and Monte Carlo EM, in terms of the estimated marginal likelihood, for a different number of training points. Monte Carlo EM is not an on-line algorithm, and (unlike AEVB and the wake-sleep method) can't be applied efficiently for the full MNIST dataset.");
  }, 'fig:ml');
  await parHeading('Visualisation of high-dimensional data');
  await T('If we choose a low-dimensional latent space (e.g. 2D), we can use the learned encoders (recognition model) to project high-dimensional data to a low-dimensional manifold. See appendix ');
  await ref('app:vis');
  await T(' for visualisations of the 2D latent manifolds for the MNIST and Frey Face datasets.');

  /* --- 6 Conclusion, 7 Future work, the bibliography ------------------------------- */
  await section('Conclusion');
  await T('We have introduced a novel estimator of the variational lower bound, Stochastic Gradient VB (SGVB), for efficient approximate inference with continuous latent variables. The proposed estimator can be straightforwardly differentiated and optimized using standard stochastic gradient methods. For the case of i.i.d. datasets and continuous latent variables per datapoint we introduce an efficient algorithm for efficient inference and learning, Auto-Encoding VB (AEVB), that learns an approximate inference model using the SGVB estimator. The theoretical advantages are reflected in experimental results.');
  await section('Future work');
  await T('Since the SGVB estimator and the AEVB algorithm can be applied to almost any inference and learning problem with continuous latent variables, there are plenty of future directions: (i) learning hierarchical generative architectures with deep neural networks (e.g. convolutional networks) used for the encoders and decoders, trained jointly with AEVB; (ii) time-series models (i.e. dynamic Bayesian networks); (iii) application of SGVB to the global parameters; (iv) supervised models with latent variables, useful for learning complicated noise distributions.');
  await P();
  await insertBibliography(page, 'cited', 'plain');

  /* --- what the file holds ---------------------------------------------------------- */
  await expect.poll(() => fileText().includes('\\bibliography{cited}'), { timeout: 20000 }).toBe(true);
  await page.waitForTimeout(2500);
  const text = fileText();
  const c = canonMath(text);
  const has = (latex: string) => expect(c, `expected the formula ${latex}`).toContain(canonMath(latex));
  for (const s of ['\\section{Example: Variational Auto-Encoder}\\label{sec:example}', '\\section{Related work}', '\\section{Experiments}\\label{sec:experiments}', '\\section{Conclusion}', '\\section{Future work}',
    '\\paragraph{Likelihood lower bound}', '\\paragraph{Marginal likelihood}', '\\paragraph{Visualisation of high-dimensional data}']) expect(text).toContain(s);
  const order = ['\\label{sec:reparam}', '\\label{sec:example}', '\\section{Related work}', '\\label{sec:experiments}', '\\paragraph{Likelihood lower bound}', '\\paragraph{Marginal likelihood}', '\\paragraph{Visualisation', '\\section{Conclusion}', '\\section{Future work}', '\\bibliography{cited}'].map(s => text.indexOf(s));
  expect(order.every(i => i >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(text).toMatch(/diagonal covariance structure\\footnote\{Note that this is just a \(simplifying\) choice, and not a limitation of our method\.\}:/);
  has(r`\begin{equation}\log q_{\phi}(z|x^{(i)})=\log\mathcal{N}(z;\mu^{(i)},\sigma^{2(i)}I)\label{eq:gaussian-post}\end{equation}`);
  has(r`$z^{(i,l)}=g_{\phi}(x^{(i)},\epsilon^{(l)})=\mu^{(i)}+\sigma^{(i)}\odot\epsilon^{(l)}$`);
  has(r`\begin{align}\mathcal{L}(\theta,\phi;x^{(i)}) & \simeq\frac{1}{2}\sum_{j=1}^{J}\left(1+\log((\sigma_{j}^{(i)})^{2})-(\mu_{j}^{(i)})^{2}-(\sigma_{j}^{(i)})^{2}\right)+\frac{1}{L}\sum_{l=1}^{L}\log p_{\theta}(x^{(i)}|z^{(i,l)})\nonumber \\ \mathrm{where}\quad z^{(i,l)} & =\mu^{(i)}+\sigma^{(i)}\odot\epsilon^{(l)}\quad\mathrm{and}\quad\epsilon^{(l)}\sim\mathcal{N}(0,I)\label{eq:vae-estimator}\end{align}`);
  expect(text).toMatch(/see appendix \\ref\{app:mlp\}\)\. Note the true posterior/);
  expect(text).toMatch(/estimator of eq\. \\eqref\{eq:sgvb-b\} where the KL divergence/);
  // related work: 12 fresh references, two of them cited twice (from the project's list the second time)
  expect(text).toMatch(new RegExp(`^The wake-sleep algorithm \\\\citep?\\{${keys.hinton1995wake}\\} is, to the best`, 'm'));
  expect(text).toMatch(new RegExp(`Recently, \\\\citep?\\{${keys.blei2012variational}\\} introduced a control variate schemes to reduce the high variance of the naive gradient estimator discussed in section \\\\ref\\{sec:problem\\}, and`));
  expect((text.match(new RegExp(`\\\\citep?\\{${keys.vincent2010stacked}\\}`, 'g')) ?? []).length).toBe(2);
  expect((text.match(new RegExp(`\\\\citep?\\{${keys.bengio2013representation}\\}`, 'g')) ?? []).length).toBe(2);
  expect((text.match(new RegExp(`\\\\citep?\\{${keys.hinton1995wake}\\}`, 'g')) ?? []).length).toBe(2);
  expect((text.match(new RegExp(`\\\\citep?\\{${keys.duchi2010adaptive}\\}`, 'g')) ?? []).length).toBe(3);
  expect(text).toMatch(/variational bound \(e\.g\. eq\. \\eqref\{eq:vae-estimator\}\), lacking/);
  // experiments: the URL footnote, the two figures, the run-in headings
  expect(text).toMatch(/Frey Face datasets\\footnote\{Available at http:\/\/www\.cs\.nyu\.edu\/(~|\\textasciitilde\{\}|\\textasciitilde )roweis\/data\.html\} and compared/);
  expect(text).toMatch(/Note that with \\emph\{hidden units\} we refer/);
  expect(text).toMatch(/\\includegraphics\[width=1\\columnwidth\]\{figures\/vae-lowerbound\.png\}[\s\S]*\\caption\{Comparison of our AEVB method to the wake-sleep algorithm[\s\S]*\(\$N_\{z\}\$\)\.[\s\S]*was small \(\$<1\$\) and omitted[\s\S]*40 GFLOPS\.\}\\label\{fig:lb\}/);
  expect(text).toMatch(/\\includegraphics\[width=1\\columnwidth\]\{figures\/vae-marginal\.png\}[\s\S]*\\caption\{Comparison of AEVB to the wake-sleep algorithm and Monte Carlo EM[\s\S]*full MNIST dataset\.\}\\label\{fig:ml\}/);
  has(r`$\lbrace0.01,0.02,0.1\rbrace$`);
  expect(text).toMatch(/\\paragraph\{Likelihood lower bound\}\n\nWe trained generative models \(decoders\)[\s\S]*Figure \\ref\{fig:lb\} shows the results/);
  expect(text).toMatch(/Results are in figure \\ref\{fig:ml\}\./);
  expect(text).toMatch(/See appendix \\ref\{app:vis\} for visualisations/);
  expect(text).toMatch(/\\bibliographystyle\{plain\}\s*\\bibliography\{cited\}/);
  expect(Object.keys(keys).length).toBe(17);
  const bib = readFileSync(`${DIR}/cited.bib`, 'utf8');
  for (const k of Object.values(keys)) expect(bib).toContain(`{${k},`);
  await expect(page.locator('.katex-error')).toHaveCount(0);
  expect(noErrors(errors)).toEqual([]);
  writeFileSync(KEYS_FILE, JSON.stringify(keys));
  writeFileSync(`${DIR}/.complete`, 'vae');
});

/** \emph{…} in running text (Ctrl+E around the words). */
async function emphasis(page: Page, text: string) { await page.keyboard.press('Control+e'); await page.keyboard.type(text); await page.keyboard.press('Control+e'); }

/* ================================================================== session 3: the appendices A–F */
test('writing "Auto-Encoding Variational Bayes", the appendices: visualisations, the KL solution, MLPs, the likelihood estimator, MCEM and full VB', async ({ page }) => {
  test.skip(!existsSync(`${DIR}/.complete`), 'the main body was not typed');
  test.setTimeout(1200000);
  const errors = collectErrors(page);
  const keys: Record<string, string> = JSON.parse(readFileSync(KEYS_FILE, 'utf8'));
  const { T, M, P, section, subsection, bold, ref, eqref, D, displayHere, cite, figure } = tools(page, keys);
  await openPaper(page, PROJECT, 'vae.tex');
  await expect(page.locator('.lyx-editor .lyx-command-bibtex')).toHaveCount(1, { timeout: 15000 });
  await resumeAtEnd(page);
  await P();
  await page.locator('.menubar .menu button', { hasText: 'Document' }).first().click();
  await page.locator('.menu-list .menu-item', { hasText: 'Start Appendix Here' }).click();

  /* --- A Visualisations ------------------------------------------------------------- */
  await setLayout(page, '2');
  await T('Visualisations');
  await insertLabel(page, 'app:vis');
  await P();
  await T('See figures ');
  await ref('fig:manifold');
  await T(' and ');
  await ref('fig:samples');
  await T(' for visualisations of latent space and corresponding observed space of models learned with SGVB.');
  await figure([`${FIGS}/vae-manifold-frey.png`, `${FIGS}/vae-manifold-mnist.png`], async () => {
    await T('Visualisations of learned data manifold for generative models with two-dimensional latent space, learned with AEVB. Since the prior of the latent space is Gaussian, linearly spaced coordinates on the unit square were transformed through the inverse CDF of the Gaussian to produce values of the latent variables ');
    await M('z');
    await T('. For each of these values ');
    await M('z');
    await T(', we plotted the corresponding generative ');
    await M(r`p_{\theta}(x|z)`);
    await T(' with the learned parameters ');
    await M(r`\theta`);
    await T('.');
  }, 'fig:manifold');
  await figure([`${FIGS}/vae-samples.png`], async () => { await T('Random samples from learned generative models of MNIST for different dimensionalities of latent space.'); }, 'fig:samples');

  /* --- B Solution of the KL term, Gaussian case ------------------------------------- */
  await section(async () => { await T('Solution of '); await M(r`-D_{KL}(q_{\phi}(z)\Vert p_{\theta}(z))`); await T(', Gaussian case'); }, 'app:kl');
  await T('The variational lower bound (the objective to be maximized) contains a KL term that can often be integrated analytically. Here we give the solution when both the prior ');
  await M(r`p_{\theta}(z)=\mathcal{N}(0,I)`);
  await T(' and the posterior approximation ');
  await M(r`q_{\phi}(z|x^{(i)})`);
  await T(' are Gaussian. Let ');
  await M('J');
  await T(' be the dimensionality of ');
  await M('z');
  await T('. Let ');
  await M(r`\mu`);
  await T(' and ');
  await M(r`\sigma`);
  await T(' denote the variational mean and s.d. evaluated at datapoint ');
  await M('i');
  await T(', and let ');
  await M(r`\mu_{j}`);
  await T(' and ');
  await M(r`\sigma_{j}`);
  await T(' simply denote the ');
  await M('j');
  await T('-th element of these vectors. Then:');
  await D(r`\int q_{\theta}(z)\log p(z)dz & =\int\mathcal{N}(z;\mu,\sigma^{2})\log\mathcal{N}(z;0,I)dz\\ & =-\frac{J}{2}\log(2\pi)-\frac{1}{2}\sum_{j=1}^{J}(\mu_{j}^{2}+\sigma_{j}^{2})`, { numbered: false });
  await P();
  await T('And:');
  await D(r`\int q_{\theta}(z)\log q_{\theta}(z)dz & =\int\mathcal{N}(z;\mu,\sigma^{2})\log\mathcal{N}(z;\mu,\sigma^{2})dz\\ & =-\frac{J}{2}\log(2\pi)-\frac{1}{2}\sum_{j=1}^{J}(1+\log\sigma_{j}^{2})`, { numbered: false });
  await P();
  await T('Therefore:');
  await D(r`-D_{KL}(q_{\phi}(z)\Vert p_{\theta}(z)) & =\int q_{\theta}(z)\left(\log p_{\theta}(z)-\log q_{\theta}(z)\right)dz\\ & =\frac{1}{2}\sum_{j=1}^{J}\left(1+\log((\sigma_{j})^{2})-(\mu_{j})^{2}-(\sigma_{j})^{2}\right)`, { numbered: false });
  await P();
  await T('When using a recognition model ');
  await M(r`q_{\phi}(z|x)`);
  await T(' then ');
  await M(r`\mu`);
  await T(' and s.d. ');
  await M(r`\sigma`);
  await T(' are simply functions of ');
  await M('x');
  await T(' and the variational parameters ');
  await M(r`\phi`);
  await T(', as exemplified in the text.');

  /* --- C MLP's as probabilistic encoders and decoders ------------------------------- */
  await section("MLP's as probabilistic encoders and decoders", 'app:mlp');
  await T('In variational auto-encoders, neural networks are used as probabilistic encoders and decoders. There are many possible choices of encoders and decoders, depending on the type of data and model. In our example we used relatively simple neural networks, namely multi-layered perceptrons (MLPs). For the encoder we used a MLP with Gaussian output, while for the decoder we used MLPs with either Gaussian or Bernoulli outputs, depending on the type of data.');
  await subsection('Bernoulli MLP as decoder', 'app:bernoulli');
  await T('In this case let ');
  await M(r`p_{\theta}(x|z)`);
  await T(' be a multivariate Bernoulli whose probabilities are computed from ');
  await M('z');
  await T(' with a fully-connected neural network with a single hidden layer:');
  await D(r`\log p(x|z) & =\sum_{i=1}^{D}x_{i}\log y_{i}+(1-x_{i})\cdot\log(1-y_{i})\\ \mathrm{where}\quad y & =f_{\sigma}(W_{2}\tanh(W_{1}z+b_{1})+b_{2})`, { label: 'eq:bernoulli', unnumberedRows: [0] });
  await P();
  await T('where ');
  await M(r`f_{\sigma}(.)`);
  await T(' is the elementwise sigmoid activation function, and where ');
  await M(r`\theta=\lbrace W_{1},W_{2},b_{1},b_{2}\rbrace`);
  await T(' are the weights and biases of the MLP.');
  await subsection('Gaussian MLP as encoder or decoder', 'app:gaussian');
  await T('In this case let encoder or decoder be a multivariate Gaussian with a diagonal covariance structure:');
  await D(r`\log p(x|z) & =\log\mathcal{N}(x;\mu,\sigma^{2}I)\\ \mathrm{where}\quad\mu & =W_{4}h+b_{4}\\ \log\sigma^{2} & =W_{5}h+b_{5}\\ h & =\tanh(W_{3}z+b_{3})`, { label: 'eq:gaussian-mlp', unnumberedRows: [0, 1, 2] });
  await P();
  await T('where ');
  await M(r`\lbrace W_{3},W_{4},W_{5},b_{3},b_{4},b_{5}\rbrace`);
  await T(' are the weights and biases of the MLP and part of ');
  await M(r`\theta`);
  await T(' when used as decoder. Note that when this network is used as an encoder ');
  await M(r`q_{\phi}(z|x)`);
  await T(', then ');
  await M('z');
  await T(' and ');
  await M('x');
  await T(' are swapped, and the weights and biases are variational parameters ');
  await M(r`\phi`);
  await T('.');

  /* --- D Marginal likelihood estimator ---------------------------------------------- */
  await section('Marginal likelihood estimator', 'app:ml');
  await T('We derived the following marginal likelihood estimator that produces good estimates of the marginal likelihood as long as the dimensionality of the sampled space is low (less then 5 dimensions), and sufficient samples are taken. Let ');
  await M(r`p_{\theta}(x,z)=p_{\theta}(z)p_{\theta}(x|z)`);
  await T(' be the generative model we are sampling from, and for a given datapoint ');
  await M(r`x^{(i)}`);
  await T(' we would like to estimate the marginal likelihood ');
  await M(r`p_{\theta}(x^{(i)})`);
  await T('.');
  await P();
  await T('The estimation process consists of three stages:');
  await P();
  await setLayout(page, 'e');
  await T('Sample ');
  await M('L');
  await T(' values ');
  await M(r`\lbrace z^{(l)}\rbrace`);
  await T(' from the posterior using gradient-based MCMC, e.g. Hybrid Monte Carlo, using ');
  await M(r`\nabla_{z}\log p_{\theta}(z|x)=\nabla_{z}\log p_{\theta}(z)+\nabla_{z}\log p_{\theta}(x|z)`);
  await T('.');
  await P();
  await T('Fit a density estimator ');
  await M('q(z)');
  await T(' to these samples ');
  await M(r`\lbrace z^{(l)}\rbrace`);
  await T('.');
  await P();
  await T('Again, sample ');
  await M('L');
  await T(' new values from the posterior. Plug these samples, as well as the fitted ');
  await M('q(z)');
  await T(', into the following estimator:');
  await displayHere(r`p_{\theta}(x^{(i)})\simeq\left(\frac{1}{L}\sum_{l=1}^{L}\frac{q(z^{(l)})}{p_{\theta}(z)p_{\theta}(x^{(i)}|z^{(l)})}\right)^{-1}\quad\mathrm{where}\quad z^{(l)}\sim p_{\theta}(z|x^{(i)})`);
  await P();
  await setLayout(page, 's');
  await T('Derivation of the estimator:');
  await D(r`\frac{1}{p_{\theta}(x^{(i)})} & =\frac{\int q(z)dz}{p_{\theta}(x^{(i)})}=\frac{\int q(z)\frac{p_{\theta}(x^{(i)},z)}{p_{\theta}(x^{(i)},z)}dz}{p_{\theta}(x^{(i)})}\\ & =\int\frac{p_{\theta}(x^{(i)},z)}{p_{\theta}(x^{(i)})}\frac{q(z)}{p_{\theta}(x^{(i)},z)}dz\\ & =\int p_{\theta}(z|x^{(i)})\frac{q(z)}{p_{\theta}(x^{(i)},z)}dz\\ & \simeq\frac{1}{L}\sum_{l=1}^{L}\frac{q(z^{(l)})}{p_{\theta}(z)p_{\theta}(x^{(i)}|z^{(l)})}\quad\mathrm{where}\quad z^{(l)}\sim p_{\theta}(z|x^{(i)})`, { numbered: false });

  /* --- E Monte Carlo EM ------------------------------------------------------------- */
  await section('Monte Carlo EM', 'app:mcem');
  await T('The Monte Carlo EM algorithm does not employ an encoder, instead it samples from the posterior of the latent variables using gradients of the posterior computed with ');
  await M(r`\nabla_{z}\log p_{\theta}(z|x)=\nabla_{z}\log p_{\theta}(z)+\nabla_{z}\log p_{\theta}(x|z)`);
  await T('. The Monte Carlo EM procedure consists of 10 HMC leapfrog steps with an automatically tuned stepsize such that the acceptance rate was 90%, followed by 5 weight updates steps using the acquired sample. For all algorithms the parameters were updated using the Adagrad stepsizes (with accompanying annealing schedule).');
  await P();
  await T('The marginal likelihood was estimated with the first 1000 datapoints from the train and test sets, for each datapoint sampling 50 values from the posterior of the latent variables using Hybrid Monte Carlo with 4 leapfrog steps.');

  /* --- F Full VB -------------------------------------------------------------------- */
  await section('Full VB', 'app:fullvb');
  await T('As written in the paper, it is possible to perform variational inference on both the parameters ');
  await M(r`\theta`);
  await T(' and the latent variables ');
  await M('z');
  await T(", as opposed to just the latent variables as we did in the paper. Here, we'll derive our estimator for that case.");
  await P();
  await T('Let ');
  await M(r`p_{\alpha}(\theta)`);
  await T(' be some hyperprior for the parameters introduced above, parameterized by ');
  await M(r`\alpha`);
  await T('. The marginal likelihood can be written as:');
  await D(r`\log p_{\alpha}(X)=D_{KL}(q_{\phi}(\theta)\Vert p_{\alpha}(\theta|X))+\mathcal{L}(\phi;X)`, { numbered: true, label: 'eq:fullvb-marginal' });
  await P();
  await T('where the first RHS term denotes a KL divergence of the approximate from the true posterior, and where ');
  await M(r`\mathcal{L}(\phi;X)`);
  await T(' denotes the variational lower bound to the marginal likelihood:');
  await D(r`\mathcal{L}(\phi;X)=\int q_{\phi}(\theta)\left(\log p_{\theta}(X)+\log p_{\alpha}(\theta)-\log q_{\phi}(\theta)\right)d\theta`, { numbered: true, label: 'eq:fullvb-lb' });
  await P();
  await T('Note that this is a lower bound since the KL divergence is non-negative; the bound equals the true marginal when the approximate and true posteriors match exactly. The term ');
  await M(r`\log p_{\theta}(X)`);
  await T(' is composed of a sum over the marginal likelihoods of individual datapoints ');
  await M(r`\log p_{\theta}(X)=\sum_{i=1}^{N}\log p_{\theta}(x^{(i)})`);
  await T(', which can each be rewritten as:');
  await D(r`\log p_{\theta}(x^{(i)})=D_{KL}(q_{\phi}(z|x^{(i)})\Vert p_{\theta}(z|x^{(i)}))+\mathcal{L}(\theta,\phi;x^{(i)})`, { numbered: true, label: 'eq:fullvb-datapoint' });
  await P();
  await T('where again the first RHS term is the KL divergence of the approximate from the true posterior, and ');
  await M(r`\mathcal{L}(\theta,\phi;x)`);
  await T(' is the variational lower bound of the marginal likelihood of datapoint ');
  await M('i');
  await T(':');
  await D(r`\mathcal{L}(\theta,\phi;x^{(i)})=\int q_{\phi}(z|x)\left(\log p_{\theta}(x^{(i)}|z)+\log p_{\theta}(z)-\log q_{\phi}(z|x)\right)dz`, { numbered: true, label: 'eq:fullvb-lb2' });
  await P();
  await T('The expectations on the RHS of eqs ');
  await eqref('eq:fullvb-lb');
  await T(' and ');
  await eqref('eq:fullvb-lb2');
  await T(' can obviously be written as a sum of three separate expectations, of which the second and third component can sometimes be analytically solved, e.g. when both ');
  await M(r`p_{\theta}(x)`);
  await T(' and ');
  await M(r`q_{\phi}(z|x)`);
  await T(' are Gaussian. For generality we will here assume that each of these expectations is intractable.');
  await P();
  await T('Under certain mild conditions outlined in section (see paper) for chosen approximate posteriors ');
  await M(r`q_{\phi}(\theta)`);
  await T(' and ');
  await M(r`q_{\phi}(z|x)`);
  await T(' we can reparameterize conditional samples ');
  await M(r`\tilde{z}\sim q_{\phi}(z|x)`);
  await T(' as');
  await D(r`\tilde{z}=g_{\phi}(\epsilon,x)\quad\mathrm{with}\quad\epsilon\sim p(\epsilon)`, { numbered: true, label: 'eq:fullvb-reparam' });
  await P();
  await T('where we choose a prior ');
  await M(r`p(\epsilon)`);
  await T(' and a function ');
  await M(r`g_{\phi}(\epsilon,x)`);
  await T(' such that the following holds:');
  await D(r`\mathcal{L}(\theta,\phi;x^{(i)}) & =\int q_{\phi}(z|x)\left(\log p_{\theta}(x^{(i)}|z)+\log p_{\theta}(z)-\log q_{\phi}(z|x)\right)dz\\ & =\int p(\epsilon)\left.\left(\log p_{\theta}(x^{(i)}|z)+\log p_{\theta}(z)-\log q_{\phi}(z|x)\right)\right|_{z=g_{\phi}(\epsilon,x^{(i)})}d\epsilon`, { label: 'eq:fullvb-mc', unnumberedRows: [0] });
  await P();
  await T('The same can be done for the approximate posterior ');
  await M(r`q_{\phi}(\theta)`);
  await T(':');
  await D(r`\tilde{\theta}=h_{\phi}(\zeta)\quad\mathrm{with}\quad\zeta\sim p(\zeta)`, { numbered: true, label: 'eq:theta-reparam' });
  await P();
  await T('where we, similarly as above, choose a prior ');
  await M(r`p(\zeta)`);
  await T(' and a function ');
  await M(r`h_{\phi}(\zeta)`);
  await T(' such that the following holds:');
  await D(r`\mathcal{L}(\phi;X) & =\int q_{\phi}(\theta)\left(\log p_{\theta}(X)+\log p_{\alpha}(\theta)-\log q_{\phi}(\theta)\right)d\theta\\ & =\int p(\zeta)\left.\left(\log p_{\theta}(X)+\log p_{\alpha}(\theta)-\log q_{\phi}(\theta)\right)\right|_{\theta=h_{\phi}(\zeta)}d\zeta`, { label: 'eq:fullvb-mc2', unnumberedRows: [0] });
  await P();
  await T('For notational conciseness we introduce a shorthand notation ');
  await M(r`f_{\phi}(x,z,\theta)`);
  await T(':');
  await D(r`f_{\phi}(x,z,\theta)=N\cdot\left(\log p_{\theta}(x|z)+\log p_{\theta}(z)-\log q_{\phi}(z|x)\right)+\log p_{\alpha}(\theta)-\log q_{\phi}(\theta)`, { numbered: true, label: 'eq:f' });
  await P();
  await T('Using equations ');
  await eqref('eq:fullvb-mc2');
  await T(' and ');
  await eqref('eq:fullvb-mc');
  await T(', the Monte Carlo estimate of the variational lower bound, given datapoint ');
  await M(r`x^{(i)}`);
  await T(', is:');
  await D(r`\mathcal{L}(\phi;X)\simeq\frac{1}{L}\sum_{l=1}^{L}f_{\phi}(x^{(l)},g_{\phi}(\epsilon^{(l)},x^{(l)}),h_{\phi}(\zeta^{(l)}))`, { numbered: true, label: 'eq:fullvb-estimator' });
  await P();
  await T('where ');
  await M(r`\epsilon^{(l)}\sim p(\epsilon)`);
  await T(' and ');
  await M(r`\zeta^{(l)}\sim p(\zeta)`);
  await T('. The estimator only depends on samples from ');
  await M(r`p(\epsilon)`);
  await T(' and ');
  await M(r`p(\zeta)`);
  await T(' which are obviously not influenced by ');
  await M(r`\phi`);
  await T(', therefore the estimator can be differentiated w.r.t. ');
  await M(r`\phi`);
  await T('. The resulting stochastic gradients can be used in conjunction with stochastic optimization methods such as SGD or Adagrad ');
  await cite('duchi2010adaptive');
  await T('. See algorithm ');
  await ref('alg:fullvb');   // the algorithm follows below
  await T(' for a basic approach to computing stochastic gradients.');

  // F.1
  await subsection('Example', 'app:example');
  await T('Let the prior over the parameters and latent variables be the centered isotropic Gaussian ');
  await M(r`p_{\alpha}(\theta)=\mathcal{N}(z;0,I)`);
  await T(' and ');
  await M(r`p_{\theta}(z)=\mathcal{N}(z;0,I)`);
  await T(". Note that in this case, the prior lacks parameters. Let's also assume that the true posteriors are approximatily Gaussian with an approximately diagonal covariance. In this case, we can let the variational approximate posteriors be multivariate Gaussians with a diagonal covariance structure:");
  await D(r`\log q_{\phi}(\theta) & =\log\mathcal{N}(\theta;\mu_{\theta},\sigma_{\theta}^{2}I)\\ \log q_{\phi}(z|x) & =\log\mathcal{N}(z;\mu_{z},\sigma_{z}^{2}I)`, { label: 'eq:example-posteriors', unnumberedRows: [0] });

  // Algorithm 2
  await P();
  await insertFloat(page, 'Algorithm');
  await bold('Require:');
  await T(' ');
  await M(r`\phi`);
  await T(' (Current value of variational parameters)');
  await P();
  await M(r`g\leftarrow0`);
  await P();
  await bold('for');
  await T(' ');
  await M('l');
  await T(' is 1 to ');
  await M('L');
  await T(' ');
  await bold('do');
  await P();
  await setLayout(page, 'i');
  await M(r`x\leftarrow`);
  await T(' Random draw from dataset ');
  await M('X');
  await P();
  await M(r`\epsilon\leftarrow`);
  await T(' Random draw from prior ');
  await M(r`p(\epsilon)`);
  await P();
  await M(r`\zeta\leftarrow`);
  await T(' Random draw from prior ');
  await M(r`p(\zeta)`);
  await P();
  await M(r`g\leftarrow g+\frac{1}{L}\nabla_{\phi}f_{\phi}(x,g_{\phi}(\epsilon,x),h_{\phi}(\zeta))`);
  await P();
  await setLayout(page, 's');
  await bold('end for');
  await P();
  await bold('return');
  await T(' ');
  await M('g');
  await page.keyboard.press('ArrowDown');   // into the caption
  await page.waitForTimeout(100);
  await typeCaption(page, async () => {
    await T('Pseudocode for computing a stochastic gradient using our estimator. See text for meaning of the functions ');
    await M(r`f_{\phi}`);
    await T(', ');
    await M(r`g_{\phi}`);
    await T(' and ');
    await M(r`h_{\phi}`);
    await T('.');
  }, 'alg:fullvb');
  await leaveFloat(page);

  await P();
  await T('where ');
  await M(r`\mu_{z}`);
  await T(' and ');
  await M(r`\sigma_{z}`);
  await T(' are yet unspecified functions of ');
  await M('x');
  await T('. Since they are Gaussian, we can parameterize the variational approximate posteriors:');
  await D(r`q_{\phi}(\theta)\quad\mathrm{as}\quad\tilde{\theta} & =\mu_{\theta}+\sigma_{\theta}\odot\zeta\quad\mathrm{where}\quad\zeta\sim\mathcal{N}(0,I)\\ q_{\phi}(z|x)\quad\mathrm{as}\quad\tilde{z} & =\mu_{z}+\sigma_{z}\odot\epsilon\quad\mathrm{where}\quad\epsilon\sim\mathcal{N}(0,I)`, { numbered: false });
  await P();
  await T('With ');
  await M(r`\odot`);
  await T(' we signify an element-wise product. These can be plugged into the lower bound defined above (eqs ');
  await eqref('eq:f');
  await T(' and ');
  await eqref('eq:fullvb-estimator');
  await T(').');
  await P();
  await T('In this case it is possible to construct an alternative estimator with a lower variance, since in this model ');
  await M(r`p_{\alpha}(\theta)`);
  await T(', ');
  await M(r`p_{\theta}(z)`);
  await T(', ');
  await M(r`q_{\phi}(\theta)`);
  await T(' and ');
  await M(r`q_{\phi}(z|x)`);
  await T(' are Gaussian, and therefore four terms of ');
  await M(r`f_{\phi}`);
  await T(' can be solved analytically. The resulting estimator is:');
  await D(r`\mathcal{L}(\phi;X) & \simeq\frac{1}{L}\sum_{l=1}^{L}N\cdot\left(\frac{1}{2}\sum_{j=1}^{J}\left(1+\log((\sigma_{z,j}^{(l)})^{2})-(\mu_{z,j}^{(l)})^{2}-(\sigma_{z,j}^{(l)})^{2}\right)+\log p_{\theta}(x^{(i)}|z^{(i)})\right)\\ & +\frac{1}{2}\sum_{j=1}^{J}\left(1+\log((\sigma_{\theta,j}^{(l)})^{2})-(\mu_{\theta,j}^{(l)})^{2}-(\sigma_{\theta,j}^{(l)})^{2}\right)`, { label: 'eq:example-estimator', unnumberedRows: [0] });
  await P();
  await M(r`\mu_{j}^{(i)}`);
  await T(' and ');
  await M(r`\sigma_{j}^{(i)}`);
  await T(' simply denote the ');
  await M('j');
  await T('-th element of vectors ');
  await M(r`\mu^{(i)}`);
  await T(' and ');
  await M(r`\sigma^{(i)}`);
  await T('.');

  /* --- what the file holds ---------------------------------------------------------- */
  await expect.poll(() => fileText().includes('-th element of vectors'), { timeout: 20000 }).toBe(true);
  await page.waitForTimeout(2500);
  const text = fileText();
  const c = canonMath(text);
  const has = (latex: string) => expect(c, `expected the formula ${latex}`).toContain(canonMath(latex));
  expect(text).toMatch(/\\bibliography\{cited\}\n+\\appendix\n+\\section\{Visualisations\}\\label\{app:vis\}\n+See figures \\ref\{fig:manifold\} and \\ref\{fig:samples\} for visualisations/);
  expect((text.match(/\\appendix/g) ?? []).length).toBe(1);
  expect(text).toMatch(/\\includegraphics\[width=1\\columnwidth\]\{figures\/vae-manifold-frey\.png\}\\includegraphics\[width=1\\columnwidth\]\{figures\/vae-manifold-mnist\.png\}\n\\par\\end\{centering\}\n\\caption\{Visualisations of learned data manifold[\s\S]*parameters \$\\theta\$\.\}\\label\{fig:manifold\}/);
  expect(text).toMatch(/\\section\{Solution of \$-D_\{KL\}\(q_\{\\phi\}\(z\)\\Vert p_\{\\theta\}\(z\)\)\$, Gaussian case\}\\label\{app:kl\}/);
  for (const s of ["\\section{MLP's as probabilistic encoders and decoders}\\label{app:mlp}", '\\subsection{Bernoulli MLP as decoder}\\label{app:bernoulli}', '\\subsection{Gaussian MLP as encoder or decoder}\\label{app:gaussian}',
    '\\section{Marginal likelihood estimator}\\label{app:ml}', '\\section{Monte Carlo EM}\\label{app:mcem}', '\\section{Full VB}\\label{app:fullvb}', '\\subsection{Example}\\label{app:example}']) expect(text).toContain(s);
  // unnumbered aligns (B, D, F.1), partly numbered ones (C.1, C.2: three rows without a number, the last with the label)
  expect((text.match(/\\begin\{align\*\}/g) ?? []).length).toBe(5);
  has(r`\begin{align*}\int q_{\theta}(z)\log p(z)dz & =\int\mathcal{N}(z;\mu,\sigma^{2})\log\mathcal{N}(z;0,I)dz\\ & =-\frac{J}{2}\log(2\pi)-\frac{1}{2}\sum_{j=1}^{J}(\mu_{j}^{2}+\sigma_{j}^{2})\end{align*}`);
  has(r`\begin{align}\log p(x|z) & =\sum_{i=1}^{D}x_{i}\log y_{i}+(1-x_{i})\cdot\log(1-y_{i})\nonumber \\ \mathrm{where}\quad y & =f_{\sigma}(W_{2}\tanh(W_{1}z+b_{1})+b_{2})\label{eq:bernoulli}\end{align}`);
  expect(text).toMatch(/\\begin\{align\}\n\\log p\(x\|z\) & =\\log\\mathcal\{N\}\(x;\\mu,\\sigma\^\{2\}I\)\\nonumber \\\\\n\\mathrm\{where\}\\quad\\mu & =W_\{4\}h\+b_\{4\}\\nonumber \\\\\n\\log\\sigma\^\{2\} & =W_\{5\}h\+b_\{5\}\\nonumber \\\\\nh & =\\tanh\(W_\{3\}z\+b_\{3\}\)\\label\{eq:gaussian-mlp\}\n\\end\{align\}/);
  // D: the enumerate with the estimator displayed inside its third item, the derivation with nested fractions
  expect(text).toMatch(/\\begin\{enumerate\}\n\\item Sample \$L\$ values \$\\lbrace z\^\{\(l\)\}\\rbrace\$ from the posterior[\s\S]*\n\\item Fit a density estimator \$q\(z\)\$[\s\S]*\n\\item Again, sample \$L\$ new values from the posterior\. Plug these samples, as well as the fitted \$q\(z\)\$, into the following estimator:\n\\\[\n[^\n]*\n\\\]\n\\end\{enumerate\}\n+Derivation of the estimator:/);
  has(r`\[p_{\theta}(x^{(i)})\simeq\left(\frac{1}{L}\sum_{l=1}^{L}\frac{q(z^{(l)})}{p_{\theta}(z)p_{\theta}(x^{(i)}|z^{(l)})}\right)^{-1}\quad\mathrm{where}\quad z^{(l)}\sim p_{\theta}(z|x^{(i)})\]`);
  has(r`\frac{1}{p_{\theta}(x^{(i)})} & =\frac{\int q(z)dz}{p_{\theta}(x^{(i)})}=\frac{\int q(z)\frac{p_{\theta}(x^{(i)},z)}{p_{\theta}(x^{(i)},z)}dz}{p_{\theta}(x^{(i)})}\\`);
  // F: the numbered equations run on, the \left. … \right|_{…} evaluations, the \eqref references
  for (const l of ['eq:fullvb-marginal', 'eq:fullvb-lb', 'eq:fullvb-datapoint', 'eq:fullvb-lb2', 'eq:fullvb-reparam', 'eq:fullvb-mc', 'eq:theta-reparam', 'eq:fullvb-mc2', 'eq:f', 'eq:fullvb-estimator', 'eq:example-posteriors', 'eq:example-estimator']) expect(text).toContain(`\\label{${l}}`);
  has(r`& =\int p(\epsilon)\left.\left(\log p_{\theta}(x^{(i)}|z)+\log p_{\theta}(z)-\log q_{\phi}(z|x)\right)\right|_{z=g_{\phi}(\epsilon,x^{(i)})}d\epsilon\label{eq:fullvb-mc}`);
  has(r`& =\int p(\zeta)\left.\left(\log p_{\theta}(X)+\log p_{\alpha}(\theta)-\log q_{\phi}(\theta)\right)\right|_{\theta=h_{\phi}(\zeta)}d\zeta\label{eq:fullvb-mc2}`);
  expect(text).toMatch(/The expectations on the RHS of eqs \\eqref\{eq:fullvb-lb\} and \\eqref\{eq:fullvb-lb2\} can obviously/);
  expect(text).toMatch(/Using equations \\eqref\{eq:fullvb-mc2\} and \\eqref\{eq:fullvb-mc\}, the Monte Carlo/);
  expect(text).toMatch(new RegExp(`SGD or Adagrad \\\\citep?\\{${keys.duchi2010adaptive}\\}\\. See algorithm \\\\ref\\{alg:fullvb\\} for a basic approach`));
  expect((text.match(new RegExp(`\\\\citep?\\{${keys.duchi2010adaptive}\\}`, 'g')) ?? []).length).toBe(4);
  expect(text).toMatch(/\\begin\{algorithm\}\n\\textbf\{Require:\} \$\\phi\$ \(Current value of variational parameters\)\n\n\$g\\leftarrow0\$\n\n\\textbf\{for\} \$l\$ is 1 to \$L\$ \\textbf\{do\}\n\\begin\{itemize\}\n\\item \$x\\leftarrow\$ Random draw from dataset \$X\$\n\\item \$\\epsilon\\leftarrow\$ Random draw from prior \$p\(\\epsilon\)\$\n\\item \$\\zeta\\leftarrow\$ Random draw from prior \$p\(\\zeta\)\$\n\\item \$g\\leftarrow g\+\\frac\{1\}\{L\}\\nabla_\{\\phi\}f_\{\\phi\}\(x,g_\{\\phi\}\(\\epsilon,x\),h_\{\\phi\}\(\\zeta\)\)\$\n\\end\{itemize\}\n\\textbf\{end for\}\n\n\\textbf\{return\} \$g\$\n+\\caption\{Pseudocode for computing a stochastic gradient using our estimator\. See text for meaning of the functions \$f_\{\\phi\}\$, \$g_\{\\phi\}\$ and \$h_\{\\phi\}\$\.\}\\label\{alg:fullvb\}\n\\end\{algorithm\}/);
  has(r`\begin{align*}q_{\phi}(\theta)\quad\mathrm{as}\quad\tilde{\theta} & =\mu_{\theta}+\sigma_{\theta}\odot\zeta\quad\mathrm{where}\quad\zeta\sim\mathcal{N}(0,I)\\ q_{\phi}(z|x)\quad\mathrm{as}\quad\tilde{z} & =\mu_{z}+\sigma_{z}\odot\epsilon\quad\mathrm{where}\quad\epsilon\sim\mathcal{N}(0,I)\end{align*}`);
  has(r`\mathcal{L}(\phi;X) & \simeq\frac{1}{L}\sum_{l=1}^{L}N\cdot\left(\frac{1}{2}\sum_{j=1}^{J}\left(1+\log((\sigma_{z,j}^{(l)})^{2})-(\mu_{z,j}^{(l)})^{2}-(\sigma_{z,j}^{(l)})^{2}\right)+\log p_{\theta}(x^{(i)}|z^{(i)})\right)\nonumber \\`);
  expect(text).toMatch(/\(eqs \\eqref\{eq:f\} and \\eqref\{eq:fullvb-estimator\}\)\./);
  await expect(page.locator('.katex-error')).toHaveCount(0);
  expect(noErrors(errors)).toEqual([]);
  writeFileSync(`${DIR}/.appendix`, 'vae');
});

/* ================================================================== reload, outline, build */
test('the VAE paper survives a reload byte-identically and its PDF has the numbered equations, the lettered appendices, both algorithms, five figures and the references', async ({ page }) => {
  test.skip(!existsSync(`${DIR}/.complete`) || !existsSync(`${DIR}/.appendix`), 'the paper was not typed completely');
  test.setTimeout(600000);
  const errors = collectErrors(page);
  await openPaper(page, PROJECT, 'vae.tex');
  await expect(page.locator('.lyx-editor .lyx-command-citation').first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.lyx-editor .lyx-inset-float')).toHaveCount(7);   // 5 figures, 2 algorithms
  await expect(page.locator('.lyx-editor .lyx-inset-foot')).toHaveCount(3);
  const before = fileText();
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 0, null, { timeout: 30000 });
  await page.waitForTimeout(2500);
  expect(fileText()).toBe(before);
  if (await page.locator('.outline-text').count() === 0) await page.keyboard.press('Control+Alt+o');
  await expect(page.locator('.outline-text')).toHaveCount(24 + 7, { timeout: 5000 });   // the headings (the appendix's included) and the seven floats
  const outline = (await page.locator('.outline-text').allInnerTexts()).filter(t => !/^(figure|table|algorithm):/.test(t.trim()));
  expect(outline).toHaveLength(24);
  const headings = ['Auto-Encoding Variational Bayes', 'Introduction', 'Method', 'Problem scenario', 'The variational bound', 'The SGVB estimator and AEVB algorithm', 'The reparameterization trick',
    'Example: Variational Auto-Encoder', 'Related work', 'Experiments', 'Likelihood lower bound', 'Marginal likelihood', 'Visualisation of high-dimensional data', 'Conclusion', 'Future work',
    'Visualisations', 'Solution of', "MLP's as probabilistic encoders and decoders", 'Bernoulli MLP as decoder', 'Gaussian MLP as encoder or decoder', 'Marginal likelihood estimator', 'Monte Carlo EM', 'Full VB', 'Example'];
  headings.forEach((h, i) => expect(outline[i]).toContain(h));
  expect(outline[15]).toMatch(/^\s*A\s*Visualisations/);      // lettered after \appendix
  expect(outline[19]).toMatch(/^\s*C\.2\s*Gaussian MLP/);
  expect(outline[23]).toMatch(/^\s*F\.1\s*Example/);

  await page.locator('.tb-btn[title^="View PDF"]').click();
  await expect(page.locator('.pdf-panel .build-progress')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.pdf-panel .build-progress')).toHaveCount(0, { timeout: 400000 });
  await expect(page.locator('.pdf-panel .bar span')).toContainText('built');
  const res = await page.request.get(`/api/docs/${encodeURIComponent(`${PROJECT}/vae.tex`)}/pdf`);
  expect(res.ok()).toBe(true);
  const pdf = `${TMP}/e2e-vae-full.pdf`;
  writeFileSync(pdf, await res.body());
  // one long line: control chars some viewers embed around link targets stripped, -layout's line-break hyphenations undone ("inte- grated" → "integrated")
  const pdfText = execFileSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8' }).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').replace(/\s+/g, ' ').replace(/([a-z])- ([a-z])/g, '$1$2');
  expect(pdfText).toContain('Auto-Encoding Variational Bayes');
  for (const s of ['1 Introduction', '2 Method', '2.1 Problem scenario', '2.2 The variational bound', '2.3 The SGVB estimator and AEVB algorithm', '2.4 The reparameterization trick', '3 Example: Variational Auto-Encoder',
    '4 Related work', '5 Experiments', '6 Conclusion', '7 Future work', 'References', 'A Visualisations', 'B Solution of', 'Gaussian case', 'C MLP\u2019s as probabilistic encoders and decoders', 'C.1 Bernoulli MLP as decoder',
    'C.2 Gaussian MLP as encoder or decoder', 'D Marginal likelihood estimator', 'E Monte Carlo EM', 'F Full VB', 'F.1 Example']) expect(pdfText).toContain(s);
  // the equation numbers: (1)-(3) the bound, (4)-(8) the estimators (the two-row aligns numbered once), (9)-(10) the example, (11)-(12) the MLPs, (13)-(24) full VB
  expect(pdfText).toMatch(/variational lower bound \(eq\. \(2\)\), yielding/);
  expect(pdfText).toMatch(/of eq\. \(3\) can be integrated analytically \(see appendix B\)/);
  expect(pdfText).toMatch(/corresponding to eq\. \(3\), which typically/);
  expect(pdfText).toMatch(/\(Gradients of minibatch estimator \(8\)\)/);
  expect(pdfText).toMatch(/objective function given at eq\. \(7\)\./);
  expect(pdfText).toMatch(/use the estimator of eq\. \(7\) where the KL divergence/);
  expect(pdfText).toMatch(/\(e\.g\. eq\. \(10\)\), lacking/);
  expect(pdfText).toMatch(/on the RHS of eqs \(14\) and \(16\) can obviously/);
  expect(pdfText).toMatch(/Using equations \(20\) and \(18\), the Monte Carlo/);
  expect(pdfText).toMatch(/\(eqs \(21\) and \(22\)\)\./);
  expect(pdfText).toMatch(/\(24\)/);
  // sections, algorithms, figures and the appendix letters resolved
  expect(pdfText).toMatch(/outlined in section 2\.4 for a chosen/);
  expect(pdfText).toMatch(/See algorithm 1 for a basic approach to compute/);
  expect(pdfText).toMatch(/Algorithm 1 Minibatch version of the Auto-Encoding VB \(AEVB\) algorithm\. Either of the two SGVB estimators in section 2\.3 can be used/);
  expect(pdfText).toMatch(/Algorithm 2 Pseudocode for computing a stochastic gradient using our estimator/);
  expect(pdfText).toMatch(/See algorithm 2 for a basic approach to computing/);
  expect(pdfText).toMatch(/single hidden layer, see appendix C\)/);
  expect(pdfText).toMatch(/Figure 2 shows the results when comparing/);
  expect(pdfText).toMatch(/Results are in figure 3\./);
  expect(pdfText).toMatch(/See appendix A for visualisations/);
  expect(pdfText).toMatch(/See figures 4 and 5 for visualisations/);
  for (const s of ['Figure 1: The type of directed graphical model under consideration', 'Figure 2: Comparison of our AEVB method to the wake-sleep algorithm', 'Figure 3: Comparison of AEVB to the wake-sleep algorithm and Monte Carlo EM',
    'Figure 4: Visualisations of learned data manifold', 'Figure 5: Random samples from learned generative models of MNIST']) expect(pdfText).toContain(s);
  expect(pdfText).toMatch(/Likelihood lower bound We trained generative models/);
  expect(pdfText).toMatch(/the naive gradient estimator discussed in section 2\.1, and applied/);
  // citations and the reference list
  expect(pdfText).toMatch(/\(see e\.g\. \[\d+\]\) and is impractical/);
  expect(pdfText).toMatch(/The wake-sleep algorithm \[\d+\] is, to the best/);
  expect(pdfText).toMatch(/References.*\[1\].*\[17\]/);
  expect(pdfText).toMatch(/Hybrid Monte Carlo\. Physics Letters B/i);
  expect(pdfText).toMatch(/A Visualisations/);
  expect(noErrors(errors)).toEqual([]);
});
