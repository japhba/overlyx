/**
 * The whole of "Generative Adversarial Nets" (arXiv 1406.2661) written from a blank document
 * through the editor UI, section by section, the text lifted verbatim from the paper — not the
 * first page only (paperwriting-more.spec.ts covers BERT that way). What a real author needs for a
 * complete paper, all driven through the GUI:
 *  - the theorems-ams module chosen in Document ▸ Settings, then Proposition / Proof / Theorem
 *    paragraphs from the layout list, with a label inside a theorem;
 *  - every formula of the paper typed keystroke by keystroke (typeLatex: \min\max, \mathbb{E},
 *    nested scripts, \frac, \int, \left[ … \right], \Vert, \lbrace, aligns with several rows);
 *  - numbered equations with labels, \ref to equations, sections, floats and the theorem;
 *  - a figure float with an uploaded image (the browser's file chooser) and a caption that itself
 *    contains formulas; a table float whose cells hold $\pm$ formulas and citations; a wide text
 *    table; an algorithm float holding nested itemize lists with display formulas inside the items;
 *  - single and multi-key citations pasted as BibTeX (29 references) and re-cited from the
 *    project's bibliography, a footnote, an enumerate, an unnumbered section (Alt+P * 2), the
 *    BibTeX bibliography inset;
 *  - the typed file survives a reload byte-identically and latexmk builds it: the PDF text is
 *    checked for the numbered theorem environments, equation numbers, float captions, resolved
 *    cross-references and the reference list.
 * Runs against an isolated instance (README "Testing"); OVERLYX_E2E_KEEP=1 keeps the project.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { login, collectErrors, PROJECTS_DIR } from './helpers';
import {
  openPaper, afterAuthor, setLayout, newParagraph, typeLatex, inlineLatex, displayLatex, canonMath, setModules, selectLayout,
  insertFloat, uploadGraphics, insertLabel, typeCaption, leaveFloat, citeExisting, citeFromPastedBibtexMany, insertRef, insertBibliography,
  freshPaper, placeholderPng,
} from './papertyping';

const PROJECT = 'e2e-paper-gan';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;
const TMP = process.env.CLAUDE_JOB_DIR ? `${process.env.CLAUDE_JOB_DIR}/tmp` : '/tmp';
const FIGS = `${TMP}/e2e-gan-figs`;
const r = String.raw;

test.afterAll(() => { if (!process.env.OVERLYX_E2E_KEEP) rmSync(DIR, { recursive: true, force: true }); });

const fileText = () => readFileSync(`${DIR}/gan.tex`, 'utf8');
const noErrors = (errors: string[]) => errors.filter(e => !/favicon|ResizeObserver/.test(e));

/* ------------------------------------------------------------------ the paper's references (BibTeX as an author would paste it) */
const BIB: Record<string, { bibtex: string; surname: string }> = {
  bengio2009: { surname: 'Bengio', bibtex: `@article{bengio2009learning,\n  title={Learning deep architectures for AI},\n  author={Bengio, Yoshua},\n  journal={Foundations and Trends in Machine Learning},\n  volume={2},\n  number={1},\n  pages={1--127},\n  year={2009}\n}` },
  hinton2012deep: { surname: 'Hinton', bibtex: `@article{hinton2012deep,\n  title={Deep neural networks for acoustic modeling in speech recognition},\n  author={Hinton, Geoffrey and Deng, Li and Dahl, George E. and Mohamed, Abdel-rahman and Jaitly, Navdeep and Senior, Andrew and Vanhoucke, Vincent and Nguyen, Patrick and Sainath, Tara and Kingsbury, Brian},\n  journal={IEEE Signal Processing Magazine},\n  volume={29},\n  number={6},\n  pages={82--97},\n  year={2012}\n}` },
  krizhevsky2012: { surname: 'Krizhevsky', bibtex: `@inproceedings{krizhevsky2012imagenet,\n  title={ImageNet classification with deep convolutional neural networks},\n  author={Krizhevsky, Alex and Sutskever, Ilya and Hinton, Geoffrey E.},\n  booktitle={Advances in Neural Information Processing Systems 25},\n  pages={1097--1105},\n  year={2012}\n}` },
  jarrett2009: { surname: 'Jarrett', bibtex: `@inproceedings{jarrett2009best,\n  title={What is the best multi-stage architecture for object recognition?},\n  author={Jarrett, Kevin and Kavukcuoglu, Koray and Ranzato, Marc'Aurelio and LeCun, Yann},\n  booktitle={Proc. International Conference on Computer Vision (ICCV'09)},\n  pages={2146--2153},\n  year={2009}\n}` },
  glorot2011: { surname: 'Glorot', bibtex: `@inproceedings{glorot2011deep,\n  title={Deep sparse rectifier neural networks},\n  author={Glorot, Xavier and Bordes, Antoine and Bengio, Yoshua},\n  booktitle={AISTATS'2011},\n  year={2011}\n}` },
  goodfellow2013maxout: { surname: 'Goodfellow', bibtex: `@inproceedings{goodfellow2013maxout,\n  title={Maxout networks},\n  author={Goodfellow, Ian J. and Warde-Farley, David and Mirza, Mehdi and Courville, Aaron and Bengio, Yoshua},\n  booktitle={ICML'2013},\n  year={2013}\n}` },
  hinton2012improving: { surname: 'Hinton', bibtex: `@techreport{hinton2012improving,\n  title={Improving neural networks by preventing co-adaptation of feature detectors},\n  author={Hinton, Geoffrey E. and Srivastava, Nitish and Krizhevsky, Alex and Sutskever, Ilya and Salakhutdinov, Ruslan},\n  institution={arXiv:1207.0580},\n  year={2012}\n}` },
  smolensky1986: { surname: 'Smolensky', bibtex: `@incollection{smolensky1986information,\n  title={Information processing in dynamical systems: Foundations of harmony theory},\n  author={Smolensky, Paul},\n  booktitle={Parallel Distributed Processing},\n  volume={1},\n  chapter={6},\n  pages={194--281},\n  publisher={MIT Press},\n  year={1986}\n}` },
  hinton2006fast: { surname: 'Hinton', bibtex: `@article{hinton2006fast,\n  title={A fast learning algorithm for deep belief nets},\n  author={Hinton, Geoffrey E. and Osindero, Simon and Teh, Yee Whye},\n  journal={Neural Computation},\n  volume={18},\n  pages={1527--1554},\n  year={2006}\n}` },
  salakhutdinov2009: { surname: 'Salakhutdinov', bibtex: `@inproceedings{salakhutdinov2009deep,\n  title={Deep Boltzmann machines},\n  author={Salakhutdinov, Ruslan and Hinton, Geoffrey E.},\n  booktitle={AISTATS'2009},\n  pages={448--455},\n  year={2009}\n}` },
  bengio2013better: { surname: 'Bengio', bibtex: `@inproceedings{bengio2013better,\n  title={Better mixing via deep representations},\n  author={Bengio, Yoshua and Mesnil, Gr{\\'e}goire and Dauphin, Yann and Rifai, Salah},\n  booktitle={ICML'13},\n  year={2013}\n}` },
  bengio2014deep: { surname: 'Bengio', bibtex: `@inproceedings{bengio2014deep,\n  title={Deep generative stochastic networks trainable by backprop},\n  author={Bengio, Yoshua and Thibodeau-Laufer, {\\'E}ric and Alain, Guillaume and Yosinski, Jason},\n  booktitle={ICML'14},\n  year={2014}\n}` },
  hyvarinen2005: { surname: 'Hyv', bibtex: `@article{hyvarinen2005estimation,\n  title={Estimation of non-normalized statistical models using score matching},\n  author={Hyv{\\"a}rinen, Aapo},\n  journal={Journal of Machine Learning Research},\n  volume={6},\n  pages={695--709},\n  year={2005}\n}` },
  gutmann2010: { surname: 'Gutmann', bibtex: `@inproceedings{gutmann2010noise,\n  title={Noise-contrastive estimation: A new estimation principle for unnormalized statistical models},\n  author={Gutmann, Michael and Hyv{\\"a}rinen, Aapo},\n  booktitle={AISTATS'2010},\n  year={2010}\n}` },
  vincent2008: { surname: 'Vincent', bibtex: `@inproceedings{vincent2008extracting,\n  title={Extracting and composing robust features with denoising autoencoders},\n  author={Vincent, Pascal and Larochelle, Hugo and Bengio, Yoshua and Manzagol, Pierre-Antoine},\n  booktitle={ICML 2008},\n  year={2008}\n}` },
  bengio2013generalized: { surname: 'Bengio', bibtex: `@inproceedings{bengio2013generalized,\n  title={Generalized denoising auto-encoders as generative models},\n  author={Bengio, Yoshua and Yao, Li and Alain, Guillaume and Vincent, Pascal},\n  booktitle={NIPS26},\n  publisher={NIPS Foundation},\n  year={2013}\n}` },
  kingma2013auto: { surname: 'Kingma', bibtex: `@techreport{kingma2013auto,\n  title={Auto-encoding variational Bayes},\n  author={Kingma, Diederik P. and Welling, Max},\n  institution={arXiv:1312.6114},\n  year={2013}\n}` },
  rezende2014: { surname: 'Rezende', bibtex: `@techreport{rezende2014stochastic,\n  title={Stochastic backpropagation and approximate inference in deep generative models},\n  author={Rezende, Danilo J. and Mohamed, Shakir and Wierstra, Daan},\n  institution={arXiv:1401.4082},\n  year={2014}\n}` },
  tieleman2008: { surname: 'Tieleman', bibtex: `@inproceedings{tieleman2008training,\n  title={Training restricted Boltzmann machines using approximations to the likelihood gradient},\n  author={Tieleman, Tijmen},\n  booktitle={ICML 2008},\n  pages={1064--1071},\n  year={2008}\n}` },
  younes1999: { surname: 'Younes', bibtex: `@article{younes1999convergence,\n  title={On the convergence of Markovian stochastic algorithms with rapidly decreasing ergodicity rates},\n  author={Younes, Laurent},\n  journal={Stochastics and Stochastic Reports},\n  volume={65},\n  number={3},\n  pages={177--228},\n  year={1999}\n}` },
  lecun1998: { surname: 'LeCun', bibtex: `@article{lecun1998gradient,\n  title={Gradient-based learning applied to document recognition},\n  author={LeCun, Yann and Bottou, L{\\'e}on and Bengio, Yoshua and Haffner, Patrick},\n  journal={Proceedings of the IEEE},\n  volume={86},\n  number={11},\n  pages={2278--2324},\n  year={1998}\n}` },
  susskind2010: { surname: 'Susskind', bibtex: `@techreport{susskind2010toronto,\n  title={The Toronto face dataset},\n  author={Susskind, Josh and Anderson, Adam and Hinton, Geoffrey E.},\n  institution={U. Toronto},\n  number={UTML TR 2010-001},\n  year={2010}\n}` },
  krizhevsky2009: { surname: 'Krizhevsky', bibtex: `@techreport{krizhevsky2009learning,\n  title={Learning multiple layers of features from tiny images},\n  author={Krizhevsky, Alex and Hinton, Geoffrey},\n  institution={University of Toronto},\n  year={2009}\n}` },
  breuleux2011: { surname: 'Breuleux', bibtex: `@article{breuleux2011quickly,\n  title={Quickly generating representative samples from an RBM-derived process},\n  author={Breuleux, Olivier and Bengio, Yoshua and Vincent, Pascal},\n  journal={Neural Computation},\n  volume={23},\n  number={8},\n  pages={2053--2073},\n  year={2011}\n}` },
  hinton1995: { surname: 'Hinton', bibtex: `@article{hinton1995wake,\n  title={The wake-sleep algorithm for unsupervised neural networks},\n  author={Hinton, Geoffrey E. and Dayan, Peter and Frey, Brendan J. and Neal, Radford M.},\n  journal={Science},\n  volume={268},\n  pages={1558--1161},\n  year={1995}\n}` },
  goodfellow2013multi: { surname: 'Goodfellow', bibtex: `@inproceedings{goodfellow2013multi,\n  title={Multi-prediction deep Boltzmann machines},\n  author={Goodfellow, Ian J. and Mirza, Mehdi and Courville, Aaron and Bengio, Yoshua},\n  booktitle={NIPS'2013},\n  year={2013}\n}` },
  goodfellow2013pylearn2: { surname: 'Goodfellow', bibtex: `@techreport{goodfellow2013pylearn2,\n  title={Pylearn2: a machine learning research library},\n  author={Goodfellow, Ian J. and Warde-Farley, David and Lamblin, Pascal and Dumoulin, Vincent and Mirza, Mehdi and Pascanu, Razvan and Bergstra, James and Bastien, Fr{\\'e}d{\\'e}ric and Bengio, Yoshua},\n  institution={arXiv:1308.4214},\n  year={2013}\n}` },
  bergstra2010theano: { surname: 'Bergstra', bibtex: `@inproceedings{bergstra2010theano,\n  title={Theano: a CPU and GPU math expression compiler},\n  author={Bergstra, James and Breuleux, Olivier and Bastien, Fr{\\'e}d{\\'e}ric and Lamblin, Pascal and Pascanu, Razvan and Desjardins, Guillaume and Turian, Joseph and Warde-Farley, David and Bengio, Yoshua},\n  booktitle={Proceedings of the Python for Scientific Computing Conference (SciPy)},\n  year={2010}\n}` },
  bastien2012theano: { surname: 'Bastien', bibtex: `@inproceedings{bastien2012theano,\n  title={Theano: new features and speed improvements},\n  author={Bastien, Fr{\\'e}d{\\'e}ric and Lamblin, Pascal and Pascanu, Razvan and Bergstra, James and Goodfellow, Ian J. and Bergeron, Arnaud and Bouchard, Nicolas and Bengio, Yoshua},\n  booktitle={Deep Learning and Unsupervised Feature Learning NIPS 2012 Workshop},\n  year={2012}\n}` },
};

test.beforeEach(async ({ page }) => { await login(page); });

test('writing the whole of "Generative Adversarial Nets" from a blank document', async ({ page }) => {
  test.setTimeout(1500000);
  const errors = collectErrors(page);
  await freshPaper(page, PROJECT, 'gan.tex', 'Generative Adversarial Nets', { resetBib: true });
  rmSync(`${DIR}/.complete`, { force: true });   // marker of an earlier run
  rmSync(`${DIR}/figures`, { recursive: true, force: true });   // a new paper has no figures yet
  mkdirSync(FIGS, { recursive: true });
  placeholderPng(`${FIGS}/gan-overview.png`, 640, 180, [70, 130, 180]);
  placeholderPng(`${FIGS}/gan-samples.png`, 480, 320, [60, 160, 90]);
  placeholderPng(`${FIGS}/gan-interpolation.png`, 480, 80, [170, 90, 60]);
  await openPaper(page, PROJECT, 'gan.tex');

  /* --- local shorthands ------------------------------------------------------------- */
  const T = (text: string) => page.keyboard.type(text);
  const M = (latex: string) => inlineLatex(page, latex);
  const P = () => newParagraph(page);
  const section = async (title: string, label?: string) => { await P(); await setLayout(page, '2'); await T(title); if (label) await insertLabel(page, label); await P(); };
  const subsection = async (title: string | (() => Promise<void>), label?: string) => { await P(); await setLayout(page, '3'); if (typeof title === 'string') await T(title); else await title(); if (label) await insertLabel(page, label); await P(); };
  /** a display formula inside the current paragraph (an algorithm step), not in a paragraph of its own */
  const displayHere = async (latex: string) => {
    await page.keyboard.press('Control+Shift+m');
    await expect(page.locator('.lm-field.display.focused')).toHaveCount(1, { timeout: 5000 });
    await typeLatex(page, latex);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(60);
  };
  // citations: the first mention of a paper pastes its BibTeX, later ones pick it from the project's bibliography
  const keys: Record<string, string> = {};
  const cite = async (...names: string[]) => {
    const fresh = names.filter(n => !keys[n]);
    if (fresh.length === names.length) {
      const got = await citeFromPastedBibtexMany(page, names.map(n => BIB[n]));
      names.forEach((n, i) => { keys[n] = got[i]; });
    } else {
      if (fresh.length) throw new Error('mixing new and known references in one citation is not needed by this paper: ' + names.join(','));
      await citeExisting(page, names.map(n => `[${keys[n]}]`));
    }
  };

  /* --- front matter --------------------------------------------------------------- */
  await setModules(page, 'theorems-ams', 'Theorem');   // the paper has propositions, a theorem and proofs
  await afterAuthor(page);
  await setLayout(page, 'a');
  await T('We propose a new framework for estimating generative models via an adversarial process, in which we simultaneously train two models: a generative model G that captures the data distribution, and a discriminative model D that estimates the probability that a sample came from the training data rather than G. The training procedure for G is to maximize the probability of D making a mistake. This framework corresponds to a minimax two-player game. In the space of arbitrary functions G and D, a unique solution exists, with G recovering the training data distribution and D equal to ');
  await M(r`\frac{1}{2}`);
  await T(' everywhere. In the case where G and D are defined by multilayer perceptrons, the entire system can be trained with backpropagation. There is no need for any Markov chains or unrolled approximate inference networks during either training or generation of samples. Experiments demonstrate the potential of the framework through qualitative and quantitative evaluation of the generated samples.');
  await expect(page.locator('.lyx-layout-abstract')).toContainText('minimax two-player game');

  /* --- 1 Introduction ------------------------------------------------------------- */
  await section('Introduction');
  await T('The promise of deep learning is to discover rich, hierarchical models ');
  await cite('bengio2009');
  await T(' that represent probability distributions over the kinds of data encountered in artificial intelligence applications, such as natural images, audio waveforms containing speech, and symbols in natural language corpora. So far, the most striking successes in deep learning have involved discriminative models, usually those that map a high-dimensional, rich sensory input to a class label ');
  await cite('hinton2012deep', 'krizhevsky2012');
  await T('. These striking successes have primarily been based on the backpropagation and dropout algorithms, using piecewise linear units ');
  await cite('jarrett2009', 'glorot2011', 'goodfellow2013maxout');
  await T(' which have a particularly well-behaved gradient. Deep generative models have had less of an impact, due to the difficulty of approximating many intractable probabilistic computations that arise in maximum likelihood estimation and related strategies, and due to difficulty of leveraging the benefits of piecewise linear units in the generative context. We propose a new generative model estimation procedure that sidesteps these difficulties.');
  await page.keyboard.press('Control+Alt+f');
  await T('All code and hyperparameters available at http://www.github.com/goodfeli/adversarial');
  await page.keyboard.press('Escape');
  await P();
  await T('In the proposed adversarial nets framework, the generative model is pitted against an adversary: a discriminative model that learns to determine whether a sample is from the model distribution or the data distribution. The generative model can be thought of as analogous to a team of counterfeiters, trying to produce fake currency and use it without detection, while the discriminative model is analogous to the police, trying to detect the counterfeit currency. Competition in this game drives both teams to improve their methods until the counterfeits are indistiguishable from the genuine articles.');
  await P();
  await T('This framework can yield specific training algorithms for many kinds of model and optimization algorithm. In this article, we explore the special case when the generative model generates samples by passing random noise through a multilayer perceptron, and the discriminative model is also a multilayer perceptron. We refer to this special case as ');
  await page.keyboard.press('Control+e'); await T('adversarial nets'); await page.keyboard.press('Control+e');
  await T('. In this case, we can train both models using only the highly successful backpropagation and dropout algorithms ');
  await cite('hinton2012improving');
  await T(' and sample from the generative model using only forward propagation. No approximate inference or Markov chains are necessary.');

  /* --- 2 Related work ------------------------------------------------------------- */
  await section('Related work');
  await T('An alternative to directed graphical models with latent variables are undirected graphical models with latent variables, such as restricted Boltzmann machines (RBMs) ');
  await cite('smolensky1986', 'hinton2006fast');
  await T(', deep Boltzmann machines (DBMs) ');
  await cite('salakhutdinov2009');
  await T(' and their numerous variants. The interactions within such models are represented as the product of unnormalized potential functions, normalized by a global summation/integration over all states of the random variables. This quantity (the partition function) and its gradient are intractable for all but the most trivial instances, although they can be estimated by Markov chain Monte Carlo (MCMC) methods. Mixing poses a significant problem for learning algorithms that rely on MCMC ');
  await cite('bengio2013better', 'bengio2014deep');
  await T('.');
  await P();
  await T('Deep belief networks (DBNs) ');
  await cite('hinton2006fast');
  await T(' are hybrid models containing a single undirected layer and several directed layers. While a fast approximate layer-wise training criterion exists, DBNs incur the computational difficulties associated with both undirected and directed models.');
  await P();
  await T('Alternative criteria that do not approximate or bound the log-likelihood have also been proposed, such as score matching ');
  await cite('hyvarinen2005');
  await T(' and noise-contrastive estimation (NCE) ');
  await cite('gutmann2010');
  await T('. Both of these require the learned probability density to be analytically specified up to a normalization constant. Note that in many interesting generative models with several layers of latent variables (such as DBNs and DBMs), it is not even possible to derive a tractable unnormalized probability density. Some models such as denoising auto-encoders ');
  await cite('vincent2008');
  await T(' and contractive autoencoders have learning rules very similar to score matching applied to RBMs. In NCE, as in this work, a discriminative training criterion is employed to fit a generative model. However, rather than fitting a separate discriminative model, the generative model itself is used to discriminate generated data from samples a fixed noise distribution. Because NCE uses a fixed noise distribution, learning slows dramatically after the model has learned even an approximately correct distribution over a small subset of the observed variables.');
  await P();
  await T('Finally, some techniques do not involve defining a probability distribution explicitly, but rather train a generative machine to draw samples from the desired distribution. This approach has the advantage that such machines can be designed to be trained by back-propagation. Prominent recent work in this area includes the generative stochastic network (GSN) framework ');
  await cite('bengio2014deep');
  await T(', which extends generalized denoising auto-encoders ');
  await cite('bengio2013generalized');
  await T(': both can be seen as defining a parameterized Markov chain, i.e., one learns the parameters of a machine that performs one step of a generative Markov chain. Compared to GSNs, the adversarial nets framework does not require a Markov chain for sampling. Because adversarial nets do not require feedback loops during generation, they are better able to leverage piecewise linear units ');
  await cite('jarrett2009', 'glorot2011', 'goodfellow2013maxout');
  await T(', which improve the performance of backpropagation but have problems with unbounded activation when used in a feedback loop. More recent examples of training a generative machine by back-propagating into it include recent work on auto-encoding variational Bayes ');
  await cite('kingma2013auto');
  await T(' and stochastic backpropagation ');
  await cite('rezende2014');
  await T('.');

  /* --- 3 Adversarial nets --------------------------------------------------------- */
  await section('Adversarial nets', 'sec:adversarial');
  await T("The adversarial modeling framework is most straightforward to apply when the models are both multilayer perceptrons. To learn the generator's distribution ");
  await M(r`p_{g}`);
  await T(' over data ');
  await M('x');
  await T(', we define a prior on input noise variables ');
  await M(r`p_{z}(z)`);
  await T(', then represent a mapping to data space as ');
  await M(r`G(z;\theta_{g})`);
  await T(', where ');
  await M('G');
  await T(' is a differentiable function represented by a multilayer perceptron with parameters ');
  await M(r`\theta_{g}`);
  await T('. We also define a second multilayer perceptron ');
  await M(r`D(x;\theta_{d})`);
  await T(' that outputs a single scalar. ');
  await M('D(x)');
  await T(' represents the probability that ');
  await M('x');
  await T(' came from the data rather than ');
  await M(r`p_{g}`);
  await T('. We train ');
  await M('D');
  await T(' to maximize the probability of assigning the correct label to both training examples and samples from ');
  await M('G');
  await T('. We simultaneously train ');
  await M('G');
  await T(' to minimize ');
  await M(r`\log(1-D(G(z)))`);
  await T(':');
  await P();
  await T('In other words, ');
  await M('D');
  await T(' and ');
  await M('G');
  await T(' play the following two-player minimax game with value function ');
  await M('V(G,D)');
  await T(':');
  await displayLatex(page, r`\min_{G}\max_{D}V(D,G)=\mathbb{E}_{x\sim p_{data}(x)}[\log D(x)]+\mathbb{E}_{z\sim p_{z}(z)}[\log(1-D(G(z)))].`, { numbered: true, label: 'eq:minimax' });
  await P();
  await T('In the next section, we present a theoretical analysis of adversarial nets, essentially showing that the training criterion allows one to recover the data generating distribution as ');
  await M('G');
  await T(' and ');
  await M('D');
  await T(' are given enough capacity, i.e., in the non-parametric limit. See Figure ');
  await insertRef(page, 'fig:overview');   // the figure itself follows below: a forward reference
  await T(' for a less formal, more pedagogical explanation of the approach. In practice, we must implement the game using an iterative, numerical approach. Optimizing ');
  await M('D');
  await T(' to completion in the inner loop of training is computationally prohibitive, and on finite datasets would result in overfitting. Instead, we alternate between ');
  await M('k');
  await T(' steps of optimizing ');
  await M('D');
  await T(' and one step of optimizing ');
  await M('G');
  await T('. This results in ');
  await M('D');
  await T(' being maintained near its optimal solution, so long as ');
  await M('G');
  await T(' changes slowly enough. This strategy is analogous to the way that SML/PCD ');
  await cite('younes1999', 'tieleman2008');
  await T(' training maintains samples from a Markov chain from one learning step to the next in order to avoid burning in a Markov chain as part of the inner loop of learning. The procedure is formally presented in Algorithm ');
  await insertRef(page, 'alg:gan');
  await T('.');
  await P();
  await T('In practice, equation ');
  await insertRef(page, 'eq:minimax');
  await T(' may not provide sufficient gradient for ');
  await M('G');
  await T(' to learn well. Early in learning, when ');
  await M('G');
  await T(' is poor, ');
  await M('D');
  await T(' can reject samples with high confidence because they are clearly different from the training data. In this case, ');
  await M(r`\log(1-D(G(z)))`);
  await T(' saturates. Rather than training ');
  await M('G');
  await T(' to minimize ');
  await M(r`\log(1-D(G(z)))`);
  await T(' we can train ');
  await M('G');
  await T(' to maximize ');
  await M(r`\log D(G(z))`);
  await T('. This objective function results in the same fixed point of the dynamics of ');
  await M('G');
  await T(' and ');
  await M('D');
  await T(' but provides much stronger gradients early in learning.');

  // Figure 1: an uploaded image and the paper's long caption, formulas included
  await P();
  await insertFloat(page, 'Figure');
  await uploadGraphics(page, `${FIGS}/gan-overview.png`);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(100);
  await typeCaption(page, async () => {
    await T('Generative adversarial nets are trained by simultaneously updating the discriminative distribution (');
    await M('D');
    await T(', blue, dashed line) so that it discriminates between samples from the data generating distribution (black, dotted line) ');
    await M(r`p_{x}`);
    await T(' from those of the generative distribution ');
    await M(r`p_{g}`);
    await T(' (');
    await M('G');
    await T(') (green, solid line). The lower horizontal line is the domain from which ');
    await M('z');
    await T(' is sampled, in this case uniformly. The horizontal line above is part of the domain of ');
    await M('x');
    await T('. The upward arrows show how the mapping ');
    await M('x=G(z)');
    await T(' imposes the non-uniform distribution ');
    await M(r`p_{g}`);
    await T(' on transformed samples. ');
    await M('G');
    await T(' contracts in regions of high density and expands in regions of low density of ');
    await M(r`p_{g}`);
    await T('. (a) Consider an adversarial pair near convergence: ');
    await M(r`p_{g}`);
    await T(' is similar to ');
    await M(r`p_{data}`);
    await T(' and ');
    await M('D');
    await T(' is a partially accurate classifier. (b) In the inner loop of the algorithm ');
    await M('D');
    await T(' is trained to discriminate samples from data, converging to ');
    await M(r`D^{*}(x)=\frac{p_{data}(x)}{p_{data}(x)+p_{g}(x)}`);
    await T('. (c) After an update to ');
    await M('G');
    await T(', gradient of ');
    await M('D');
    await T(' has guided ');
    await M('G(z)');
    await T(' to flow to regions that are more likely to be classified as data. (d) After several steps of training, if ');
    await M('G');
    await T(' and ');
    await M('D');
    await T(' have enough capacity, they will reach a point at which both cannot improve because ');
    await M(r`p_{g}=p_{data}`);
    await T('. The discriminator is unable to differentiate between the two distributions, i.e. ');
    await M(r`D(x)=\frac{1}{2}`);
    await T('.');
  }, 'fig:overview');
  await leaveFloat(page);

  /* --- 4 Theoretical Results ------------------------------------------------------ */
  await section('Theoretical Results', 'sec:theory');
  await T('The generator ');
  await M('G');
  await T(' implicitly defines a probability distribution ');
  await M(r`p_{g}`);
  await T(' as the distribution of the samples ');
  await M('G(z)');
  await T(' obtained when ');
  await M(r`z\sim p_{z}`);
  await T('. Therefore, we would like Algorithm ');
  await insertRef(page, 'alg:gan');
  await T(' to converge to a good estimator of ');
  await M(r`p_{data}`);
  await T(', if given enough capacity and training time. The results of this section are done in a non-parametric setting, e.g. we represent a model with infinite capacity by studying convergence in the space of probability density functions.');
  await P();
  await T('We will show in section ');
  await insertRef(page, 'sec:global');
  await T(' that this minimax game has a global optimum for ');
  await M(r`p_{g}=p_{data}`);
  await T('. We will then show in section ');
  await insertRef(page, 'sec:convergence');
  await T(' that Algorithm ');
  await insertRef(page, 'alg:gan');
  await T(' optimizes Eq ');
  await insertRef(page, 'eq:minimax');
  await T(', thus obtaining the desired result.');

  // Algorithm 1: an algorithm float, the loops as nested bullet lists with the two gradient formulas inside the steps
  await P();
  await insertFloat(page, 'Algorithm');
  await T('for number of training iterations do');
  await P();
  await setLayout(page, 'i');
  await T('for ');
  await M('k');
  await T(' steps do');
  await P();
  await page.keyboard.press('Alt+Shift+ArrowRight'); await page.waitForTimeout(100);   // one level deeper
  await T('Sample minibatch of ');
  await M('m');
  await T(' noise samples ');
  await M(r`\lbrace z^{(1)},\ldots,z^{(m)}\rbrace`);
  await T(' from noise prior ');
  await M(r`p_{g}(z)`);
  await T('.');
  await P();
  await T('Sample minibatch of ');
  await M('m');
  await T(' examples ');
  await M(r`\lbrace x^{(1)},\ldots,x^{(m)}\rbrace`);
  await T(' from data generating distribution ');
  await M(r`p_{data}(x)`);
  await T('.');
  await P();
  await T('Update the discriminator by ascending its stochastic gradient:');
  await displayHere(r`\nabla_{\theta_{d}}\frac{1}{m}\sum_{i=1}^{m}\left[\log D\left(x^{(i)}\right)+\log\left(1-D\left(G\left(z^{(i)}\right)\right)\right)\right].`);
  await P();
  await page.keyboard.press('Alt+Shift+ArrowLeft'); await page.waitForTimeout(100);
  await T('end for');
  await P();
  await T('Sample minibatch of ');
  await M('m');
  await T(' noise samples ');
  await M(r`\lbrace z^{(1)},\ldots,z^{(m)}\rbrace`);
  await T(' from noise prior ');
  await M(r`p_{g}(z)`);
  await T('.');
  await P();
  await T('Update the generator by descending its stochastic gradient:');
  await displayHere(r`\nabla_{\theta_{g}}\frac{1}{m}\sum_{i=1}^{m}\log\left(1-D\left(G\left(z^{(i)}\right)\right)\right).`);
  await P();
  await setLayout(page, 's');
  await T('end for');
  await P();
  await T('The gradient-based updates can use any standard gradient-based learning rule. We used momentum in our experiments.');
  await page.keyboard.press('ArrowDown');   // into the caption
  await page.waitForTimeout(100);
  await typeCaption(page, async () => {
    await T('Minibatch stochastic gradient descent training of generative adversarial nets. The number of steps to apply to the discriminator, ');
    await M('k');
    await T(', is a hyperparameter. We used ');
    await M('k=1');
    await T(', the least expensive option, in our experiments.');
  }, 'alg:gan');
  await leaveFloat(page);

  // 4.1
  await subsection(async () => { await T('Global Optimality of '); await M(r`p_{g}=p_{data}`); }, 'sec:global');
  await T('We first consider the optimal discriminator ');
  await M('D');
  await T(' for any given generator ');
  await M('G');
  await T('.');
  await P();
  await selectLayout(page, 'Proposition');
  await T('For ');
  await M('G');
  await T(' fixed, the optimal discriminator ');
  await M('D');
  await T(' is');
  await displayLatex(page, r`D_{G}^{*}(x)=\frac{p_{data}(x)}{p_{data}(x)+p_{g}(x)}`, { numbered: true, label: 'eq:optd' });
  await P();
  await selectLayout(page, 'Proof');
  await T('The training criterion for the discriminator ');
  await M('D');
  await T(', given any generator ');
  await M('G');
  await T(', is to maximize the quantity ');
  await M('V(G,D)');
  await displayLatex(page, r`V(G,D) & =\int_{x}p_{data}(x)\log(D(x))dx+\int_{z}p_{z}(z)\log(1-D(g(z)))dz\\ & =\int_{x}p_{data}(x)\log(D(x))+p_{g}(x)\log(1-D(x))dx`, { label: 'eq:vgd' });
  await P();
  await T('For any ');
  await M(r`(a,b)\in\mathbb{R}^{2}\setminus\lbrace0,0\rbrace`);
  await T(', the function ');
  await M(r`y\to a\log(y)+b\log(1-y)`);
  await T(' achieves its maximum in ');
  await M('[0,1]');
  await T(' at ');
  await M(r`\frac{a}{a+b}`);
  await T('. The discriminator does not need to be defined outside of ');
  await M(r`\mathrm{Supp}(p_{data})\cup\mathrm{Supp}(p_{g})`);
  await T(', concluding the proof.');
  await P();
  await setLayout(page, 's');
  await T('Note that the training objective for ');
  await M('D');
  await T(' can be interpreted as maximizing the log-likelihood for estimating the conditional probability ');
  await M('P(Y=y|x)');
  await T(', where ');
  await M('Y');
  await T(' indicates whether ');
  await M('x');
  await T(' comes from ');
  await M(r`p_{data}`);
  await T(' (with ');
  await M('y=1');
  await T(') or from ');
  await M(r`p_{g}`);
  await T(' (with ');
  await M('y=0');
  await T('). The minimax game in Eq. ');
  await insertRef(page, 'eq:minimax');
  await T(' can now be reformulated as:');
  await displayLatex(page, r`C(G) & =\max_{D}V(G,D)\\ & =\mathbb{E}_{x\sim p_{data}}[\log D_{G}^{*}(x)]+\mathbb{E}_{z\sim p_{z}}[\log(1-D_{G}^{*}(G(z)))]\\ & =\mathbb{E}_{x\sim p_{data}}[\log D_{G}^{*}(x)]+\mathbb{E}_{x\sim p_{g}}[\log(1-D_{G}^{*}(x))]\\ & =\mathbb{E}_{x\sim p_{data}}\left[\log\frac{p_{data}(x)}{p_{data}(x)+p_{g}(x)}\right]+\mathbb{E}_{x\sim p_{g}}\left[\log\frac{p_{g}(x)}{p_{data}(x)+p_{g}(x)}\right]`, { label: 'eq:cg' });
  await P();
  await selectLayout(page, 'Theorem');
  await T('The global minimum of the virtual training criterion ');
  await M('C(G)');
  await T(' is achieved if and only if ');
  await M(r`p_{g}=p_{data}`);
  await T('. At that point, ');
  await M('C(G)');
  await T(' achieves the value ');
  await M(r`-\log4`);
  await T('.');
  await insertLabel(page, 'thm:global');
  await P();
  await selectLayout(page, 'Proof');
  await T('For ');
  await M(r`p_{g}=p_{data}`);
  await T(', ');
  await M(r`D_{G}^{*}(x)=\frac{1}{2}`);
  await T(', (consider Eq. ');
  await insertRef(page, 'eq:optd');
  await T('). Hence, by inspecting Eq. ');
  await insertRef(page, 'eq:cg');
  await T(' at ');
  await M(r`D_{G}^{*}(x)=\frac{1}{2}`);
  await T(', we find ');
  await M(r`C(G)=\log\frac{1}{2}+\log\frac{1}{2}=-\log4`);
  await T('. To see that this is the best possible value of ');
  await M('C(G)');
  await T(', reached only for ');
  await M(r`p_{g}=p_{data}`);
  await T(', observe that');
  await displayLatex(page, r`\mathbb{E}_{x\sim p_{data}}[-\log2]+\mathbb{E}_{x\sim p_{g}}[-\log2]=-\log4`);
  await P();
  await T('and that by subtracting this expression from ');
  await M(r`C(G)=V(D_{G}^{*},G)`);
  await T(', we obtain:');
  await displayLatex(page, r`C(G)=-\log(4)+KL\left(p_{data}\Vert\frac{p_{data}+p_{g}}{2}\right)+KL\left(p_{g}\Vert\frac{p_{data}+p_{g}}{2}\right)`, { numbered: true, label: 'eq:kl' });
  await P();
  await T("where KL is the Kullback-Leibler divergence. We recognize in the previous expression the Jensen-Shannon divergence between the model's distribution and the data generating process:");
  await displayLatex(page, r`C(G)=-\log(4)+2\cdot JSD\left(p_{data}\Vert p_{g}\right)`, { numbered: true, label: 'eq:jsd' });
  await P();
  await T('Since the Jensen-Shannon divergence between two distributions is always non-negative and zero only when they are equal, we have shown that ');
  await M(r`C^{*}=-\log(4)`);
  await T(' is the global minimum of ');
  await M('C(G)');
  await T(' and that the only solution is ');
  await M(r`p_{g}=p_{data}`);
  await T(', i.e., the generative model perfectly replicating the data generating process.');

  // 4.2
  await subsection('Convergence of Algorithm 1', 'sec:convergence');
  await selectLayout(page, 'Proposition');
  await T('If ');
  await M('G');
  await T(' and ');
  await M('D');
  await T(' have enough capacity, and at each step of Algorithm ');
  await insertRef(page, 'alg:gan');
  await T(', the discriminator is allowed to reach its optimum given ');
  await M('G');
  await T(', and ');
  await M(r`p_{g}`);
  await T(' is updated so as to improve the criterion');
  await displayLatex(page, r`\mathbb{E}_{x\sim p_{data}}[\log D_{G}^{*}(x)]+\mathbb{E}_{x\sim p_{g}}[\log(1-D_{G}^{*}(x))]`);
  await P();
  await T('then ');
  await M(r`p_{g}`);
  await T(' converges to ');
  await M(r`p_{data}`);
  await P();
  await selectLayout(page, 'Proof');
  await T('Consider ');
  await M(r`V(G,D)=U(p_{g},D)`);
  await T(' as a function of ');
  await M(r`p_{g}`);
  await T(' as done in the above criterion. Note that ');
  await M(r`U(p_{g},D)`);
  await T(' is convex in ');
  await M(r`p_{g}`);
  await T('. The subderivatives of a supremum of convex functions include the derivative of the function at the point where the maximum is attained. In other words, if ');
  await M(r`f(x)=\sup_{\alpha\in\mathcal{A}}f_{\alpha}(x)`);
  await T(' and ');
  await M(r`f_{\alpha}(x)`);
  await T(' is convex in ');
  await M('x');
  await T(' for every ');
  await M(r`\alpha`);
  await T(', then ');
  await M(r`\partial f_{\beta}(x)\in\partial f`);
  await T(' if ');
  await M(r`\beta=\arg\sup_{\alpha\in\mathcal{A}}f_{\alpha}(x)`);
  await T('. This is equivalent to computing a gradient descent update for ');
  await M(r`p_{g}`);
  await T(' at the optimal ');
  await M('D');
  await T(' given the corresponding ');
  await M('G');
  await T('. ');
  await M(r`\sup_{D}U(p_{g},D)`);
  await T(' is convex in ');
  await M(r`p_{g}`);
  await T(' with a unique global optima as proven in Thm ');
  await insertRef(page, 'thm:global');
  await T(', therefore with sufficiently small updates of ');
  await M(r`p_{g}`);
  await T(', ');
  await M(r`p_{g}`);
  await T(' converges to ');
  await M(r`p_{x}`);
  await T(', concluding the proof.');
  await P();
  await setLayout(page, 's');
  await T('In practice, adversarial nets represent a limited family of ');
  await M(r`p_{g}`);
  await T(' distributions via the function ');
  await M(r`G(z;\theta_{g})`);
  await T(', and we optimize ');
  await M(r`\theta_{g}`);
  await T(' rather than ');
  await M(r`p_{g}`);
  await T(' itself. Using a multilayer perceptron to define ');
  await M('G');
  await T(' introduces multiple critical points in parameter space. However, the excellent performance of multilayer perceptrons in practice suggests that they are a reasonable model to use despite their lack of theoretical guarantees.');

  /* --- 5 Experiments -------------------------------------------------------------- */
  await section('Experiments', 'sec:experiments');
  await T('We trained adversarial nets an a range of datasets including MNIST');
  await cite('lecun1998');
  await T(', the Toronto Face Database (TFD) ');
  await cite('susskind2010');
  await T(', and CIFAR-10 ');
  await cite('krizhevsky2009');
  await T('. The generator nets used a mixture of rectifier linear activations ');
  await cite('jarrett2009', 'glorot2011');
  await T(' and sigmoid activations, while the discriminator net used maxout ');
  await cite('goodfellow2013maxout');
  await T(' activations. Dropout ');
  await cite('hinton2012improving');
  await T(' was applied in training the discriminator net. While our theoretical framework permits the use of dropout and other noise at intermediate layers of the generator, we used noise as the input to only the bottommost layer of the generator network.');
  await P();
  await T('We estimate probability of the test set data under ');
  await M(r`p_{g}`);
  await T(' by fitting a Gaussian Parzen window to the samples generated with ');
  await M('G');
  await T(' and reporting the log-likelihood under this distribution. The ');
  await M(r`\sigma`);
  await T(' parameter of the Gaussians was obtained by cross validation on the validation set. This procedure was introduced in Breuleux et al. ');
  await cite('breuleux2011');
  await T(' and used for various generative models for which the exact likelihood is not tractable ');
  await cite('bengio2013better', 'bengio2014deep');
  await T('. Results are reported in Table ');
  await insertRef(page, 'tab:parzen');
  await T('. This method of estimating the likelihood has somewhat high variance and does not perform well in high dimensional spaces but it is the best method available to our knowledge. Advances in generative models that can sample but not estimate likelihood directly motivate further research into how to evaluate such models.');

  // Table 1: Parzen window estimates — cells with $\pm$ formulas and citations
  await P();
  await insertFloat(page, 'Table');
  await typeCaption(page, async () => {
    await T('Parzen window-based log-likelihood estimates. The reported numbers on MNIST are the mean log-likelihood of samples on test set, with the standard error of the mean computed across examples. On TFD, we computed the standard error across folds of the dataset, with a different ');
    await M(r`\sigma`);
    await T(' chosen using the validation set of each fold. On TFD, ');
    await M(r`\sigma`);
    await T(' was cross validated on each fold and mean log-likelihood on each fold were computed. For MNIST we compare against other models of the real-valued (rather than binary) version of dataset.');
  }, 'tab:parzen');
  await page.keyboard.press('Escape');   // out of the caption, into the float's second paragraph
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(100);
  await page.keyboard.press('Control+Alt+t');
  const tableDialog = page.locator('.dialog');
  await expect(tableDialog).toContainText('Insert Table');
  await tableDialog.locator('.row', { hasText: 'Rows' }).locator('input').fill('5');
  await tableDialog.locator('.row', { hasText: 'Columns' }).locator('input').fill('3');
  await tableDialog.locator('.btn.primary').click();
  await expect(page.locator('.lyx-tabular td')).toHaveCount(15);
  const parzen: (string | (() => Promise<void>))[] = [
    'Model', 'MNIST', 'TFD',
    async () => { await T('DBN '); await cite('bengio2013better'); }, () => M(r`138\pm2`), () => M(r`1909\pm66`),
    async () => { await T('Stacked CAE '); await cite('bengio2013better'); }, () => M(r`121\pm1.6`), () => M(r`2110\pm50`),
    async () => { await T('Deep GSN '); await cite('bengio2014deep'); }, () => M(r`214\pm1.1`), () => M(r`1890\pm29`),
    'Adversarial nets', () => M(r`225\pm2`), () => M(r`2057\pm26`),
  ];
  for (let i = 0; i < parzen.length; i++) {
    const c = parzen[i];
    if (typeof c === 'string') await T(c); else await c();
    if (i < parzen.length - 1) { await page.keyboard.press('Tab'); await page.waitForTimeout(40); }
  }
  await expect(page.locator('.lyx-tabular td').nth(14).locator('.lm-static, .lm-field')).toHaveCount(1);
  await leaveFloat(page, 3);   // cell, table paragraph, float

  await P();
  await T('In Figures ');
  await insertRef(page, 'fig:samples');
  await T(' and ');
  await insertRef(page, 'fig:interpolation');
  await T(' we show samples drawn from the generator net after training. While we make no claim that these samples are better than samples generated by existing methods, we believe that these samples are at least competitive with the better generative models in the literature and highlight the potential of the adversarial framework.');

  await P();
  await insertFloat(page, 'Figure');
  await uploadGraphics(page, `${FIGS}/gan-samples.png`);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(100);
  await typeCaption(page, 'Visualization of samples from the model. Rightmost column shows the nearest training example of the neighboring sample, in order to demonstrate that the model has not memorized the training set. Samples are fair random draws, not cherry-picked. Unlike most other visualizations of deep generative models, these images show actual samples from the model distributions, not conditional means given samples of hidden units. Moreover, these samples are uncorrelated because the sampling process does not depend on Markov chain mixing. a) MNIST b) TFD c) CIFAR-10 (fully connected model) d) CIFAR-10 (convolutional discriminator and "deconvolutional" generator)', 'fig:samples');
  await leaveFloat(page);
  await P();
  await insertFloat(page, 'Figure');
  await uploadGraphics(page, `${FIGS}/gan-interpolation.png`);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(100);
  await typeCaption(page, async () => {
    await T('Digits obtained by linearly interpolating between coordinates in ');
    await M('z');
    await T(' space of the full model.');
  }, 'fig:interpolation');
  await leaveFloat(page);

  // Table 2: the challenges table (text cells; 6 rows x 5 columns)
  await P();
  await insertFloat(page, 'Table');
  await typeCaption(page, 'Challenges in generative modeling: a summary of the difficulties encountered by different approaches to deep generative modeling for each of the major operations involving a model.', 'tab:challenges');
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(100);
  await page.keyboard.press('Control+Alt+t');
  await expect(tableDialog).toContainText('Insert Table');
  await tableDialog.locator('.row', { hasText: 'Rows' }).locator('input').fill('6');
  await tableDialog.locator('.row', { hasText: 'Columns' }).locator('input').fill('5');
  await tableDialog.locator('.btn.primary').click();
  await expect(page.locator('.lyx-tabular').last().locator('td')).toHaveCount(30);
  const challenges = [
    '', 'Deep directed graphical models', 'Deep undirected graphical models', 'Generative autoencoders', 'Adversarial models',
    'Training', 'Inference needed during training.', 'Inference needed during training. MCMC needed to approximate partition function gradient.', 'Enforced tradeoff between mixing and power of reconstruction generation', 'Synchronizing the discriminator with the generator. Helvetica.',
    'Inference', 'Learned approximate inference', 'Variational inference', 'MCMC-based inference', 'Learned approximate inference',
    'Sampling', 'No difficulties', 'Requires Markov chain', 'Requires Markov chain', 'No difficulties',
    'Evaluating p(x)', 'Intractable, may be approximated with AIS', 'Intractable, may be approximated with AIS', 'Not explicitly represented, may be approximated with Parzen density estimation', 'Not explicitly represented, may be approximated with Parzen density estimation',
    'Model design', 'Nearly all models incur extreme difficulty', 'Careful design needed to ensure multiple properties', 'Any differentiable function is theoretically permitted', 'Any differentiable function is theoretically permitted',
  ];
  for (let i = 0; i < challenges.length; i++) {
    if (challenges[i]) await T(challenges[i]);
    if (i < challenges.length - 1) { await page.keyboard.press('Tab'); await page.waitForTimeout(30); }
  }
  await expect(page.locator('.lyx-tabular').last().locator('td').nth(29)).toContainText('theoretically permitted');
  await leaveFloat(page, 3);

  /* --- 6 Advantages and disadvantages --------------------------------------------- */
  await section('Advantages and disadvantages');
  await T('This new framework comes with advantages and disadvantages relative to previous modeling frameworks. The disadvantages are primarily that there is no explicit representation of ');
  await M(r`p_{g}(x)`);
  await T(', and that ');
  await M('D');
  await T(' must be synchronized well with ');
  await M('G');
  await T(' during training (in particular, ');
  await M('G');
  await T(' must not be trained too much without updating ');
  await M('D');
  await T(', in order to avoid "the Helvetica scenario" in which ');
  await M('G');
  await T(' collapses too many values of ');
  await M('z');
  await T(' to the same value of ');
  await M('x');
  await T(' to have enough diversity to model ');
  await M(r`p_{data}`);
  await T('), much as the negative chains of a Boltzmann machine must be kept up to date between learning steps. The advantages are that Markov chains are never needed, only backprop is used to obtain gradients, no inference is needed during learning, and a wide variety of functions can be incorporated into the model. Table ');
  await insertRef(page, 'tab:challenges');
  await T(' summarizes the comparison of generative adversarial nets with other generative modeling approaches.');
  await P();
  await T("The aforementioned advantages are primarily computational. Adversarial models may also gain some statistical advantage from the generator network not being updated directly with data examples, but only with gradients flowing through the discriminator. This means that components of the input are not copied directly into the generator's parameters. Another advantage of adversarial networks is that they can represent very sharp, even degenerate distributions, while methods based on Markov chains require that the distribution be somewhat blurry in order for the chains to be able to mix between modes.");

  /* --- 7 Conclusions and future work ---------------------------------------------- */
  await section('Conclusions and future work');
  await T('This framework admits many straightforward extensions:');
  await P();
  await setLayout(page, 'e');
  await T('A conditional generative model ');
  await M('p(x|c)');
  await T(' can be obtained by adding ');
  await M('c');
  await T(' as input to both ');
  await M('G');
  await T(' and ');
  await M('D');
  await T('.');
  await P();
  await T('Learned approximate inference can be performed by training an auxiliary network to predict ');
  await M('z');
  await T(' given ');
  await M('x');
  await T('. This is similar to the inference net trained by the wake-sleep algorithm ');
  await cite('hinton1995');
  await T(' but with the advantage that the inference net may be trained for a fixed generator net after the generator net has finished training.');
  await P();
  await T('One can approximately model all conditionals ');
  await M(r`p(x_{S}|x_{\not S})`);
  await T(' where ');
  await M('S');
  await T(' is a subset of the indices of ');
  await M('x');
  await T(' by training a family of conditional models that share parameters. Essentially, one can use adversarial nets to implement a stochastic extension of the deterministic MP-DBM ');
  await cite('goodfellow2013multi');
  await T('.');
  await P();
  await T('Semi-supervised learning: features from the discriminator or inference net could improve performance of classifiers when limited labeled data is available.');
  await P();
  await T('Efficiency improvements: training could be accelerated greatly by divising better methods for coordinating ');
  await M('G');
  await T(' and ');
  await M('D');
  await T(' or determining better distributions to sample ');
  await M('z');
  await T(' from during training.');
  await expect(page.locator('.lyx-layout-enumerate')).toHaveCount(5);
  expect(await page.locator('.lyx-layout-enumerate').evaluateAll(els => els.map(e => e.getAttribute('data-label')))).toEqual(['1.', '2.', '3.', '4.', '5.']);
  await P();
  await setLayout(page, 's');
  await T('This paper has demonstrated the viability of the adversarial modeling framework, suggesting that these research directions could prove useful.');

  /* --- Acknowledgments (unnumbered) and the bibliography --------------------------- */
  await P();
  await page.keyboard.press('Alt+p'); await page.waitForTimeout(80); await page.keyboard.press('*'); await page.waitForTimeout(80); await page.keyboard.press('2'); await page.waitForTimeout(150);   // Section*
  await T('Acknowledgments');
  await P();
  await T('We would like to acknowledge Patrice Marcotte, Olivier Delalleau, Kyunghyun Cho, Guillaume Alain and Jason Yosinski for helpful discussions. Yann Dauphin shared his Parzen window evaluation code with us. We would like to thank the developers of Pylearn2 ');
  await cite('goodfellow2013pylearn2');
  await T(' and Theano ');
  await cite('bergstra2010theano', 'bastien2012theano');
  await T(', particularly Frederic Bastien who rushed a Theano feature specifically to benefit this project. Arnaud Bergeron provided much-needed support with LaTeX typesetting. We would also like to thank CIFAR, and Canada Research Chairs for funding, and Compute Canada, and Calcul Quebec for providing computational resources. Ian Goodfellow is supported by the 2013 Google Fellowship in Deep Learning. Finally, we would like to thank Les Trois Brasseurs for stimulating our creativity.');
  await P();
  await insertBibliography(page, 'cited', 'plain');

  /* --- what the file holds ------------------------------------------------------- */
  await expect.poll(() => fileText().includes('\\bibliography{cited}'), { timeout: 20000 }).toBe(true);
  await page.waitForTimeout(2500);
  const text = fileText();
  const c = canonMath(text);
  const has = (latex: string) => expect(c, `expected the formula ${latex}`).toContain(canonMath(latex));
  // structure
  expect(text).toMatch(/overlyx-settings: \{"textclass":"article","modules":\["theorems-ams"\]\}/);
  expect(text).toContain('\\usepackage{amsthm}');
  expect(text.indexOf('\\newtheorem{thm}')).toBeGreaterThan(-1);
  expect(text.indexOf('\\newtheorem{prop}[thm]')).toBeGreaterThan(text.indexOf('\\newtheorem{thm}'));   // the counter it shares must exist first
  expect(text).toMatch(/\\newfloat\{algorithm\}/);
  expect(text).toMatch(/\\begin\{abstract\}[\s\S]*D equal to \$\\frac\{1\}\{2\}\$ everywhere[\s\S]*\\end\{abstract\}/);
  for (const s of ['\\section{Introduction}', '\\section{Related work}', '\\section{Adversarial nets}\\label{sec:adversarial}', '\\section{Theoretical Results}\\label{sec:theory}',
    '\\subsection{Global Optimality of $p_{g}=p_{data}$}\\label{sec:global}', '\\subsection{Convergence of Algorithm 1}\\label{sec:convergence}', '\\section{Experiments}\\label{sec:experiments}',
    '\\section{Advantages and disadvantages}', '\\section{Conclusions and future work}', '\\section*{Acknowledgments}']) expect(text).toContain(s);
  const order = ['\\section{Introduction}', '\\section{Related work}', '\\label{sec:adversarial}', '\\label{sec:theory}', '\\label{sec:global}', '\\label{sec:convergence}', '\\label{sec:experiments}', '\\section{Advantages', '\\section{Conclusions', '\\section*{Acknowledgments}', '\\bibliography{cited}'].map(s => text.indexOf(s));
  expect(order.every(i => i >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  // citations: single, multi-key, footnote, re-cited keys
  expect(text).toMatch(new RegExp(`hierarchical models \\\\citep?\\{${keys.bengio2009}\\} that represent`));
  expect(text).toMatch(new RegExp(`class label \\\\citep?\\{${keys.hinton2012deep},${keys.krizhevsky2012}\\}\\.`));
  expect(text).toMatch(new RegExp(`piecewise linear units \\\\citep?\\{${keys.jarrett2009},${keys.glorot2011},${keys.goodfellow2013maxout}\\}`));
  expect((text.match(new RegExp(`\\\\citep?\\{${keys.jarrett2009},${keys.glorot2011},${keys.goodfellow2013maxout}\\}`, 'g')) ?? []).length).toBe(2);   // cited again in Related work, from the project list
  expect(text).toMatch(/these difficulties\.\\footnote\{All code and hyperparameters available at http:\/\/www\.github\.com\/goodfeli\/adversarial\}/);
  expect(text).toMatch(/special case as \\emph\{adversarial nets\}\./);
  expect(Object.keys(keys).length).toBe(29);
  const bib = readFileSync(`${DIR}/cited.bib`, 'utf8');
  for (const k of Object.values(keys)) expect(bib).toContain(`{${k},`);
  // the formulas of section 3 and 4 (typed as LaTeX, saved as LaTeX)
  has(r`$G(z;\theta_{g})$`);
  has(r`\begin{equation}\min_{G}\max_{D}V(D,G)=\mathbb{E}_{x\sim p_{data}(x)}[\log D(x)]+\mathbb{E}_{z\sim p_{z}(z)}[\log(1-D(G(z)))].\label{eq:minimax}\end{equation}`);
  expect(text).toMatch(/See Figure \\ref\{fig:overview\} for a less formal/);
  expect(text).toMatch(/presented in Algorithm \\ref\{alg:gan\}\./);
  expect(text).toMatch(/In practice, equation \\ref\{eq:minimax\} may not/);
  expect(text).toMatch(/show in section \\ref\{sec:global\} that this minimax game[\s\S]*section \\ref\{sec:convergence\} that Algorithm \\ref\{alg:gan\} optimizes Eq \\ref\{eq:minimax\}/);
  // Figure 1: uploaded image, caption with formulas, label
  expect(existsSync(`${DIR}/figures/gan-overview.png`)).toBe(true);
  expect(text).toMatch(/\\begin\{figure\}\n\\begin\{centering\}\n\\includegraphics\[width=1\\columnwidth\]\{figures\/gan-overview\.png\}\n\\par\\end\{centering\}\n\\caption\{Generative adversarial nets are trained[\s\S]*\$D\^\{\*\}\(x\)=\\frac\{p_\{data\}\(x\)\}\{p_\{data\}\(x\)\+p_\{g\}\(x\)\}\$[\s\S]*i\.e\. \$D\(x\)=\\frac\{1\}\{2\}\$\.\}\\label\{fig:overview\}\n\\end\{figure\}/);
  // Algorithm 1: nested lists with the gradient formulas in the steps
  expect(text).toMatch(/\\begin\{algorithm\}\nfor number of training iterations do\n\\begin\{itemize\}\n\\item for \$k\$ steps do\n\\begin\{itemize\}\n\\item Sample minibatch of \$m\$ noise samples \$\\lbrace z\^\{\(1\)\},\\ldots,z\^\{\(m\)\}\\rbrace\$ from noise prior \$p_\{g\}\(z\)\$\.\n\\item Sample minibatch[\s\S]*\\item Update the discriminator by ascending its stochastic gradient:\n\\\[\n[\s\S]*\\\]\n\\end\{itemize\}\n\\item end for\n\\item Sample minibatch[\s\S]*\\item Update the generator by descending its stochastic gradient:\n\\\[\n[\s\S]*\\\]\n\\end\{itemize\}\nend for\n\nThe gradient-based updates[\s\S]*\\caption\{Minibatch stochastic gradient descent training[\s\S]*\$k=1\$, the least expensive option, in our experiments\.\}\\label\{alg:gan\}\n\\end\{algorithm\}/);
  has(r`\[\nabla_{\theta_{d}}\frac{1}{m}\sum_{i=1}^{m}\left[\log D\left(x^{(i)}\right)+\log\left(1-D\left(G\left(z^{(i)}\right)\right)\right)\right].\]`);
  has(r`\[\nabla_{\theta_{g}}\frac{1}{m}\sum_{i=1}^{m}\log\left(1-D\left(G\left(z^{(i)}\right)\right)\right).\]`);
  // theorem environments
  expect(text).toMatch(/\\begin\{prop\}\nFor \$G\$ fixed, the optimal discriminator \$D\$ is\n\n\\begin\{equation\}\n[^\n]*\\label\{eq:optd\}\n\\end\{equation\}\n\\end\{prop\}\n\n\\begin\{proof\}\nThe training criterion/);
  has(r`\begin{equation}D_{G}^{*}(x)=\frac{p_{data}(x)}{p_{data}(x)+p_{g}(x)}\label{eq:optd}\end{equation}`);
  has(r`\begin{align}V(G,D) & =\int_{x}p_{data}(x)\log(D(x))dx+\int_{z}p_{z}(z)\log(1-D(g(z)))dz\\ & =\int_{x}p_{data}(x)\log(D(x))+p_{g}(x)\log(1-D(x))dx\label{eq:vgd}\end{align}`);
  has(r`$(a,b)\in\mathbb{R}^{2}\setminus\lbrace0,0\rbrace$`);
  has(r`$\mathrm{Supp}(p_{data})\cup\mathrm{Supp}(p_{g})$`);
  expect(text).toMatch(/concluding the proof\.\n\\end\{proof\}/);
  has(r`\begin{align}C(G) & =\max_{D}V(G,D)\\ & =\mathbb{E}_{x\sim p_{data}}[\log D_{G}^{*}(x)]+\mathbb{E}_{z\sim p_{z}}[\log(1-D_{G}^{*}(G(z)))]\\ & =\mathbb{E}_{x\sim p_{data}}[\log D_{G}^{*}(x)]+\mathbb{E}_{x\sim p_{g}}[\log(1-D_{G}^{*}(x))]\\ & =\mathbb{E}_{x\sim p_{data}}\left[\log\frac{p_{data}(x)}{p_{data}(x)+p_{g}(x)}\right]+\mathbb{E}_{x\sim p_{g}}\left[\log\frac{p_{g}(x)}{p_{data}(x)+p_{g}(x)}\right]\label{eq:cg}\end{align}`);
  expect(text).toMatch(/\\begin\{thm\}\nThe global minimum of the virtual training criterion \$C\(G\)\$ is achieved if and only if \$p_\{g\}=p_\{data\}\$\. At that point, \$C\(G\)\$ achieves the value \$-\\log4\$\.\\label\{thm:global\}\n\\end\{thm\}/);
  expect(text).toMatch(/\(consider Eq\. \\ref\{eq:optd\}\)\. Hence, by inspecting Eq\. \\ref\{eq:cg\} at/);
  has(r`\begin{equation}C(G)=-\log(4)+KL\left(p_{data}\Vert\frac{p_{data}+p_{g}}{2}\right)+KL\left(p_{g}\Vert\frac{p_{data}+p_{g}}{2}\right)\label{eq:kl}\end{equation}`);
  has(r`\begin{equation}C(G)=-\log(4)+2\cdot JSD\left(p_{data}\Vert p_{g}\right)\label{eq:jsd}\end{equation}`);
  has(r`$\beta=\arg\sup_{\alpha\in\mathcal{A}}f_{\alpha}(x)$`);
  expect(text).toMatch(/as proven in Thm \\ref\{thm:global\}, therefore/);
  expect((text.match(/\\begin\{prop\}/g) ?? []).length).toBe(2);
  expect((text.match(/\\begin\{proof\}/g) ?? []).length).toBe(3);
  // Table 1: formulas and citations inside cells
  expect(text).toMatch(new RegExp(`\\\\begin\\{table\\}\\n\\\\caption\\{Parzen window-based log-likelihood estimates[\\s\\S]*\\}\\\\label\\{tab:parzen\\}\\n\\n\\\\centering\\{\\}%\\n\\\\begin\\{tabular\\}\\{\\|c\\|c\\|c\\|\\}\\n\\\\hline \\nModel & MNIST & TFD\\\\tabularnewline\\n\\\\hline \\nDBN \\\\citep?\\{${keys.bengio2013better}\\} & \\$138\\\\pm2\\$ & \\$1909\\\\pm66\\$\\\\tabularnewline[\\s\\S]*Adversarial nets & \\$225\\\\pm2\\$ & \\$2057\\\\pm26\\$\\\\tabularnewline\\n\\\\hline \\n\\\\end\\{tabular\\}\\n\\\\end\\{table\\}`));
  expect(text).toMatch(/In Figures \\ref\{fig:samples\} and \\ref\{fig:interpolation\} we show/);
  expect(text).toMatch(/\\includegraphics\[width=1\\columnwidth\]\{figures\/gan-samples\.png\}[\s\S]*\\caption\{Visualization of samples from the model\.[\s\S]*\}\\label\{fig:samples\}/);
  expect(text).toMatch(/\\includegraphics\[width=1\\columnwidth\]\{figures\/gan-interpolation\.png\}[\s\S]*\\caption\{Digits obtained by linearly interpolating between coordinates in \$z\$ space of the full model\.\}\\label\{fig:interpolation\}/);
  expect(text).toMatch(/\\caption\{Challenges in generative modeling[\s\S]*\}\\label\{tab:challenges\}\n\n\\centering\{\}%\n\\begin\{tabular\}\{\|c\|c\|c\|c\|c\|\}\n\\hline \n & Deep directed graphical models & Deep undirected graphical models & Generative autoencoders & Adversarial models\\tabularnewline\n\\hline \nTraining & /);
  expect(text).toMatch(/Model design & Nearly all models incur extreme difficulty & Careful design needed to ensure multiple properties & Any differentiable function is theoretically permitted & Any differentiable function is theoretically permitted\\tabularnewline\n\\hline \n\\end\{tabular\}/);
  expect(text).toMatch(/Table \\ref\{tab:challenges\} summarizes/);
  // conclusions: the enumerate, the remaining citations, the unnumbered section, the bibliography
  expect(text).toMatch(new RegExp(`\\\\begin\\{enumerate\\}\\n\\\\item A conditional generative model \\$p\\(x\\|c\\)\\$ can be obtained[\\s\\S]*\\n\\\\item Learned approximate inference[\\s\\S]*wake-sleep algorithm \\\\citep?\\{${keys.hinton1995}\\} but[\\s\\S]*\\n\\\\item One can approximately model all conditionals \\$p\\(x_\\{S\\}\\|x_\\{\\\\not S\\}\\)\\$[\\s\\S]*MP-DBM \\\\citep?\\{${keys.goodfellow2013multi}\\}\\.\\n\\\\item Semi-supervised learning[\\s\\S]*\\n\\\\item Efficiency improvements[\\s\\S]*during training\\.\\n\\\\end\\{enumerate\\}`));
  expect(text).toMatch(new RegExp(`Pylearn2 \\\\citep?\\{${keys.goodfellow2013pylearn2}\\} and Theano \\\\citep?\\{${keys.bergstra2010theano},${keys.bastien2012theano}\\}, particularly`));
  expect(text).toMatch(/\\bibliographystyle\{plain\}\s*\\bibliography\{cited\}/);
  await expect(page.locator('.katex-error')).toHaveCount(0);
  expect(noErrors(errors)).toEqual([]);
  writeFileSync(`${DIR}/.complete`, 'gan');
});

test('the GAN paper survives a reload byte-identically and its PDF has the numbered theorems, equations, floats and references', async ({ page }) => {
  test.skip(!existsSync(`${DIR}/.complete`), 'the paper was not typed completely');
  test.setTimeout(600000);
  const errors = collectErrors(page);
  await openPaper(page, PROJECT, 'gan.tex');
  await expect(page.locator('.lyx-editor .lyx-command-citation').first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.lyx-editor .lyx-inset-float')).toHaveCount(6);   // 3 figures, 2 tables, 1 algorithm
  // theorems-ams: one counter shared by all theorem-like environments, one number per environment (not per paragraph)
  await expect(page.locator('.lyx-editor .lyx-par[data-label="Proposition 1."]')).toHaveCount(1);
  await expect(page.locator('.lyx-editor .lyx-par[data-label="Theorem 2."]')).toHaveCount(1);
  await expect(page.locator('.lyx-editor .lyx-par[data-label="Proposition 3."]')).toHaveCount(1);
  await expect(page.locator('.lyx-editor .lyx-par[data-label="Proof."]')).toHaveCount(3);
  const before = fileText();
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 0, null, { timeout: 30000 });
  await page.waitForTimeout(2500);
  expect(fileText()).toBe(before);
  // the outline lists every heading in the paper's order
  if (await page.locator('.outline-text').count() === 0) await page.keyboard.press('Control+Alt+o');
  await expect(page.locator('.outline-text')).toHaveCount(11 + 6, { timeout: 5000 });   // the headings and the six floats
  const outline = (await page.locator('.outline-text').allInnerTexts()).filter(t => !/^(figure|table|algorithm):/.test(t.trim()));
  expect(outline).toHaveLength(11);
  const headings = ['Generative Adversarial Nets', 'Introduction', 'Related work', 'Adversarial nets', 'Theoretical Results', 'Global Optimality of', 'Convergence of Algorithm 1', 'Experiments', 'Advantages and disadvantages', 'Conclusions and future work', 'Acknowledgments'];
  headings.forEach((h, i) => expect(outline[i]).toContain(h));

  await page.locator('.tb-btn[title^="View PDF"]').click();
  await expect(page.locator('.pdf-panel .build-progress')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.pdf-panel .build-progress')).toHaveCount(0, { timeout: 400000 });
  await expect(page.locator('.pdf-panel .bar span')).toContainText('built');
  const res = await page.request.get(`/api/docs/${encodeURIComponent(`${PROJECT}/gan.tex`)}/pdf`);
  expect(res.ok()).toBe(true);
  const pdf = `${TMP}/e2e-gan-full.pdf`;
  writeFileSync(pdf, await res.body());
  const pdfText = execFileSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8' }).replace(/\s+/g, ' ');
  expect(pdfText).toContain('Generative Adversarial Nets');
  for (const s of ['1 Introduction', '2 Related work', '3 Adversarial nets', '4 Theoretical Results', '4.1 Global Optimality of pg = pdata', '4.2 Convergence of Algorithm 1', '5 Experiments', '6 Advantages and disadvantages', '7 Conclusions and future work', 'Acknowledgments', 'References']) expect(pdfText).toContain(s);
  expect(pdfText).toMatch(/Proposition 1\. For G fixed, the optimal discriminator D is/);
  expect(pdfText).toMatch(/Proof\. The training criterion for the discriminator D/);
  expect(pdfText).toMatch(/Theorem 2\. The global minimum of the virtual training criterion C\(G\)/);   // theorems-ams shares one counter
  expect(pdfText).toMatch(/Proposition 3\. If G and D have enough capacity/);
  expect(pdfText).toMatch(/as proven in Thm 2, therefore/);
  expect(pdfText).toMatch(/\(consider Eq\. 2\)\. Hence, by inspecting(?: 2)? Eq\. 8 at/);   // (-layout may interleave a fraction's digits)   // (1) minimax, (2) optd, (3)-(4) the V(G,D) align, (5)-(8) the C(G) align (its label sits on the last row), (9) kl, (10) jsd
  expect(pdfText).toMatch(/In practice, equation 1 may not provide/);
  expect(pdfText).toMatch(/See Figure 1 for a less formal/);
  expect(pdfText).toMatch(/presented in Algorithm 1\./);
  expect(pdfText).toMatch(/show in section 4\.1 that this minimax game.*section 4\.2 that Algorithm 1 optimizes Eq 1/);
  expect(pdfText).toMatch(/Algorithm 1 Minibatch stochastic gradient descent training/);
  expect(pdfText).toMatch(/Figure 1: Generative adversarial nets are trained/);
  expect(pdfText).toMatch(/Table 1: Parzen window-based log-likelihood estimates/);
  expect(pdfText).toMatch(/Figure 2: Visualization of samples/);
  expect(pdfText).toMatch(/Figure 3: Digits obtained/);
  expect(pdfText).toMatch(/Table 2: Challenges in generative modeling/);
  expect(pdfText).toMatch(/Results are reported in Table 1\./);
  expect(pdfText).toMatch(/In Figures 2 and 3 we show/);
  expect(pdfText).toMatch(/Table 2 summarizes/);
  expect(pdfText).toMatch(/hierarchical models \[\d+\] that represent/);
  expect(pdfText).toMatch(/class label \[\d+, \d+\]\./);
  expect(pdfText).toMatch(/piecewise linear units \[\d+, \d+, \d+\]/);
  expect(pdfText).toMatch(/References.*\[1\].*\[29\]/);   // all 29 references printed
  expect(pdfText).toMatch(/Yoshua Bengio\. Learning deep architectures for ai\./i);
  expect(noErrors(errors)).toEqual([]);
});
