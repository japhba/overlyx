/**
 * The whole main body of "Adam: A Method for Stochastic Optimization" (arXiv 1412.6980, ICLR 2015)
 * written from a blank document through the editor UI, section by section, the text lifted
 * verbatim from the paper — including the appendix with the convergence proof, typed in a third
 * session after the bibliography (Document ▸ Start Appendix Here, Definition / Lemma / Theorem /
 * Proof environments, the induction proof and the long inequality chains as multi-row aligns). Beyond what the GAN
 * paper (paperwriting-gan.spec.ts) needs, this one exercises:
 *  - two algorithm floats holding pseudo-code as paragraphs and bullet lists with a dozen inline
 *    formulas each, and captions that carry formulas;
 *  - the update rules as a five-row align with \eqref to it, the bias-correction derivation as a
 *    three-row align, AdaMax's limit derivation as a four-row align (\lim, \left( … \right)^{1/p},
 *    \max, \ldots), the regret bound of Theorem 4.1 (\Vert, nested fractions, \sqrt, \infty
 *    subscripts) as one display formula inside a Theorem paragraph, a Corollary;
 *  - Description paragraphs (RMSProp: / AdaGrad:) with formulas, forward references to sections
 *    and figures, four figure floats with uploaded images, \odot, \triangleq, \lesssim, \not;
 *  - 23 references pasted as BibTeX (some cited many times, from the project's bibliography);
 *  - the reload byte-identity check, the outline, and a full latexmk build whose text is checked
 *    (theorem numbers, equation numbers of the aligns, algorithm and figure captions, references).
 * Runs against an isolated instance (README "Testing"); OVERLYX_E2E_KEEP=1 keeps the project.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { login, collectErrors, PROJECTS_DIR } from './helpers';
import {
  openPaper, afterAuthor, setLayout, newParagraph, inlineLatex, displayLatex, canonMath, setModules, selectLayout,
  insertFloat, uploadGraphics, insertLabel, typeCaption, leaveFloat, citeExisting, citeFromPastedBibtexMany, insertRef, insertBibliography,
  freshPaper, placeholderPng,
} from './papertyping';

const PROJECT = 'e2e-paper-adam';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;
const TMP = process.env.CLAUDE_JOB_DIR ? `${process.env.CLAUDE_JOB_DIR}/tmp` : '/tmp';
const FIGS = `${TMP}/e2e-adam-figs`;
const r = String.raw;

test.afterAll(() => { if (!process.env.OVERLYX_E2E_KEEP) rmSync(DIR, { recursive: true, force: true }); });

const fileText = () => readFileSync(`${DIR}/adam.tex`, 'utf8');
const noErrors = (errors: string[]) => errors.filter(e => !/favicon|ResizeObserver/.test(e));

const BIB: Record<string, { bibtex: string; surname: string }> = {
  deng2013: { surname: 'Deng', bibtex: `@inproceedings{deng2013recent,\n  title={Recent advances in deep learning for speech research at Microsoft},\n  author={Deng, Li and Li, Jinyu and Huang, Jui-Ting and Yao, Kaisheng and Yu, Dong and Seide, Frank and Seltzer, Michael and Zweig, Geoff and He, Xiaodong and Williams, Jason and others},\n  booktitle={ICASSP},\n  year={2013}\n}` },
  krizhevsky2012: { surname: 'Krizhevsky', bibtex: `@inproceedings{krizhevsky2012imagenet,\n  title={ImageNet classification with deep convolutional neural networks},\n  author={Krizhevsky, Alex and Sutskever, Ilya and Hinton, Geoffrey E.},\n  booktitle={Advances in Neural Information Processing Systems},\n  pages={1097--1105},\n  year={2012}\n}` },
  hinton2006reducing: { surname: 'Hinton', bibtex: `@article{hinton2006reducing,\n  title={Reducing the dimensionality of data with neural networks},\n  author={Hinton, Geoffrey E. and Salakhutdinov, Ruslan R.},\n  journal={Science},\n  volume={313},\n  number={5786},\n  pages={504--507},\n  year={2006}\n}` },
  hinton2012deep: { surname: 'Hinton', bibtex: `@article{hinton2012deep,\n  title={Deep neural networks for acoustic modeling in speech recognition: The shared views of four research groups},\n  author={Hinton, Geoffrey and Deng, Li and Yu, Dong and Dahl, George E. and Mohamed, Abdel-rahman and Jaitly, Navdeep and Senior, Andrew and Vanhoucke, Vincent and Nguyen, Patrick and Sainath, Tara N. and Kingsbury, Brian},\n  journal={IEEE Signal Processing Magazine},\n  volume={29},\n  number={6},\n  pages={82--97},\n  year={2012}\n}` },
  graves2013speech: { surname: 'Graves', bibtex: `@inproceedings{graves2013speech,\n  title={Speech recognition with deep recurrent neural networks},\n  author={Graves, Alex and Mohamed, Abdel-rahman and Hinton, Geoffrey},\n  booktitle={ICASSP},\n  pages={6645--6649},\n  year={2013}\n}` },
  hinton2012improving: { surname: 'Hinton', bibtex: `@techreport{hinton2012improving,\n  title={Improving neural networks by preventing co-adaptation of feature detectors},\n  author={Hinton, Geoffrey E. and Srivastava, Nitish and Krizhevsky, Alex and Sutskever, Ilya and Salakhutdinov, Ruslan R.},\n  institution={arXiv:1207.0580},\n  year={2012}\n}` },
  duchi2011: { surname: 'Duchi', bibtex: `@article{duchi2011adaptive,\n  title={Adaptive subgradient methods for online learning and stochastic optimization},\n  author={Duchi, John and Hazan, Elad and Singer, Yoram},\n  journal={Journal of Machine Learning Research},\n  volume={12},\n  pages={2121--2159},\n  year={2011}\n}` },
  tieleman2012: { surname: 'Tieleman', bibtex: `@misc{tieleman2012lecture,\n  title={Lecture 6.5-rmsprop: Divide the gradient by a running average of its recent magnitude},\n  author={Tieleman, Tijmen and Hinton, Geoffrey},\n  howpublished={COURSERA: Neural Networks for Machine Learning},\n  year={2012}\n}` },
  zinkevich2003: { surname: 'Zinkevich', bibtex: `@inproceedings{zinkevich2003online,\n  title={Online convex programming and generalized infinitesimal gradient ascent},\n  author={Zinkevich, Martin},\n  booktitle={ICML},\n  year={2003}\n}` },
  sutskever2013: { surname: 'Sutskever', bibtex: `@inproceedings{sutskever2013importance,\n  title={On the importance of initialization and momentum in deep learning},\n  author={Sutskever, Ilya and Martens, James and Dahl, George and Hinton, Geoffrey},\n  booktitle={ICML},\n  pages={1139--1147},\n  year={2013}\n}` },
  graves2013generating: { surname: 'Graves', bibtex: `@techreport{graves2013generating,\n  title={Generating sequences with recurrent neural networks},\n  author={Graves, Alex},\n  institution={arXiv:1308.0850},\n  year={2013}\n}` },
  schaul2012: { surname: 'Schaul', bibtex: `@techreport{schaul2012no,\n  title={No more pesky learning rates},\n  author={Schaul, Tom and Zhang, Sixin and LeCun, Yann},\n  institution={arXiv:1206.1106},\n  year={2012}\n}` },
  zeiler2012: { surname: 'Zeiler', bibtex: `@techreport{zeiler2012adadelta,\n  title={ADADELTA: An adaptive learning rate method},\n  author={Zeiler, Matthew D.},\n  institution={arXiv:1212.5701},\n  year={2012}\n}` },
  roux2010: { surname: 'Roux', bibtex: `@inproceedings{roux2010fast,\n  title={A fast natural Newton method},\n  author={Roux, Nicolas L. and Fitzgibbon, Andrew W.},\n  booktitle={ICML},\n  pages={623--630},\n  year={2010}\n}` },
  sohl2014: { surname: 'Sohl', bibtex: `@inproceedings{sohl2014fast,\n  title={Fast large-scale optimization by unifying stochastic gradient and quasi-Newton methods},\n  author={Sohl-Dickstein, Jascha and Poole, Ben and Ganguli, Surya},\n  booktitle={ICML},\n  pages={604--612},\n  year={2014}\n}` },
  amari1998: { surname: 'Amari', bibtex: `@article{amari1998natural,\n  title={Natural gradient works efficiently in learning},\n  author={Amari, Shun-Ichi},\n  journal={Neural Computation},\n  volume={10},\n  number={2},\n  pages={251--276},\n  year={1998}\n}` },
  pascanu2013: { surname: 'Pascanu', bibtex: `@techreport{pascanu2013revisiting,\n  title={Revisiting natural gradient for deep networks},\n  author={Pascanu, Razvan and Bengio, Yoshua},\n  institution={arXiv:1301.3584},\n  year={2013}\n}` },
  maas2011: { surname: 'Maas', bibtex: `@inproceedings{maas2011learning,\n  title={Learning word vectors for sentiment analysis},\n  author={Maas, Andrew L. and Daly, Raymond E. and Pham, Peter T. and Huang, Dan and Ng, Andrew Y. and Potts, Christopher},\n  booktitle={Proceedings of the 49th Annual Meeting of the Association for Computational Linguistics},\n  pages={142--150},\n  year={2011}\n}` },
  wang2013: { surname: 'Wang', bibtex: `@inproceedings{wang2013fast,\n  title={Fast dropout training},\n  author={Wang, Sida and Manning, Christopher},\n  booktitle={ICML},\n  pages={118--126},\n  year={2013}\n}` },
  kingma2013: { surname: 'Kingma', bibtex: `@techreport{kingma2013auto,\n  title={Auto-encoding variational Bayes},\n  author={Kingma, Diederik P. and Welling, Max},\n  institution={arXiv:1312.6114},\n  year={2013}\n}` },
  moulines2011: { surname: 'Moulines', bibtex: `@inproceedings{moulines2011non,\n  title={Non-asymptotic analysis of stochastic approximation algorithms for machine learning},\n  author={Moulines, Eric and Bach, Francis R.},\n  booktitle={Advances in Neural Information Processing Systems},\n  pages={451--459},\n  year={2011}\n}` },
  polyak1992: { surname: 'Polyak', bibtex: `@article{polyak1992acceleration,\n  title={Acceleration of stochastic approximation by averaging},\n  author={Polyak, Boris T. and Juditsky, Anatoli B.},\n  journal={SIAM Journal on Control and Optimization},\n  volume={30},\n  number={4},\n  pages={838--855},\n  year={1992}\n}` },
  ruppert1988: { surname: 'Ruppert', bibtex: `@techreport{ruppert1988efficient,\n  title={Efficient estimations from a slowly convergent Robbins-Monro process},\n  author={Ruppert, David},\n  institution={Cornell University Operations Research and Industrial Engineering},\n  year={1988}\n}` },
};

/** The shorthands the two writing sessions share; `keys` maps a BIB name to the key the server gave it (persisted between the sessions). */
function tools(page: Page, keys: Record<string, string>) {
  const T = (text: string) => page.keyboard.type(text);
  const M = (latex: string) => inlineLatex(page, latex);
  const P = () => newParagraph(page);
  const section = async (title: string, label?: string) => { await P(); await setLayout(page, '2'); await T(title); if (label) await insertLabel(page, label); await P(); };
  const subsection = async (title: string, label?: string) => { await P(); await setLayout(page, '3'); await T(title); if (label) await insertLabel(page, label); await P(); };
  const bold = async (text: string) => { await page.keyboard.press('Control+b'); await T(text); await page.keyboard.press('Control+b'); };
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
  const figure = async (png: string, caption: () => Promise<void>, label: string) => {
    await P();
    await insertFloat(page, 'Figure');
    await uploadGraphics(page, png);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(100);
    await typeCaption(page, caption, label);
    await leaveFloat(page);
  };
  /** a pseudo-code line of an algorithm float: "lhs <- rhs (comment)" with the formula typed as LaTeX */
  const step = async (latex: string, comment: string) => { await M(latex); await T(` (${comment})`); };
  return { T, M, P, section, subsection, bold, cite, figure, step };
}

test.beforeEach(async ({ page }) => { await login(page); });

const KEYS_FILE = `${DIR}/.keys.json`;

test('writing "Adam: A Method for Stochastic Optimization" from a blank document, sections 1-5', async ({ page }) => {
  test.setTimeout(1200000);
  const errors = collectErrors(page);
  const keys: Record<string, string> = {};
  await freshPaper(page, PROJECT, 'adam.tex', 'Adam: A Method for Stochastic Optimization', { resetBib: true });
  for (const f of [KEYS_FILE, `${DIR}/.complete`, `${DIR}/.appendix`]) rmSync(f, { force: true });   // markers of an earlier run
  rmSync(`${DIR}/figures`, { recursive: true, force: true });   // a new paper has no figures yet
  mkdirSync(FIGS, { recursive: true });
  placeholderPng(`${FIGS}/adam-logreg.png`, 640, 260, [70, 130, 180]);
  placeholderPng(`${FIGS}/adam-mlp.png`, 640, 260, [60, 160, 90]);
  placeholderPng(`${FIGS}/adam-cnn.png`, 640, 260, [170, 90, 60]);
  placeholderPng(`${FIGS}/adam-bias.png`, 640, 300, [120, 100, 170]);
  await openPaper(page, PROJECT, 'adam.tex');

  const { T, M, P, section, subsection, bold, cite, figure, step } = tools(page, keys);

  /* --- front matter --------------------------------------------------------------- */
  await setModules(page, 'theorems-ams', 'Theorem');
  await afterAuthor(page);
  await setLayout(page, 'a');
  await T('We introduce Adam, an algorithm for first-order gradient-based optimization of stochastic objective functions, based on adaptive estimates of lower-order moments. The method is straightforward to implement, is computationally efficient, has little memory requirements, is invariant to diagonal rescaling of the gradients, and is well suited for problems that are large in terms of data and/or parameters. The method is also appropriate for non-stationary objectives and problems with very noisy and/or sparse gradients. The hyper-parameters have intuitive interpretations and typically require little tuning. Some connections to related algorithms, on which Adam was inspired, are discussed. We also analyze the theoretical convergence properties of the algorithm and provide a regret bound on the convergence rate that is comparable to the best known results under the online convex optimization framework. Empirical results demonstrate that Adam works well in practice and compares favorably to other stochastic optimization methods. Finally, we discuss AdaMax, a variant of Adam based on the infinity norm.');
  await expect(page.locator('.lyx-layout-abstract')).toContainText('lower-order moments');

  /* --- 1 Introduction ------------------------------------------------------------- */
  await section('Introduction');
  await T('Stochastic gradient-based optimization is of core practical importance in many fields of science and engineering. Many problems in these fields can be cast as the optimization of some scalar parameterized objective function requiring maximization or minimization with respect to its parameters. If the function is differentiable w.r.t. its parameters, gradient descent is a relatively efficient optimization method, since the computation of first-order partial derivatives w.r.t. all the parameters is of the same computational complexity as just evaluating the function. Often, objective functions are stochastic. For example, many objective functions are composed of a sum of subfunctions evaluated at different subsamples of data; in this case optimization can be made more efficient by taking gradient steps w.r.t. individual subfunctions, i.e. stochastic gradient descent (SGD) or ascent. SGD proved itself as an efficient and effective optimization method that was central in many machine learning success stories, such as recent advances in deep learning ');
  await cite('deng2013', 'krizhevsky2012', 'hinton2006reducing', 'hinton2012deep', 'graves2013speech');
  await T('. Objectives may also have other sources of noise than data subsampling, such as dropout ');
  await cite('hinton2012improving');
  await T(' regularization. For all such noisy objectives, efficient stochastic optimization techniques are required. The focus of this paper is on the optimization of stochastic objectives with high-dimensional parameters spaces. In these cases, higher-order optimization methods are ill-suited, and discussion in this paper will be restricted to first-order methods.');
  await P();
  await T('We propose Adam, a method for efficient stochastic optimization that only requires first-order gradients with little memory requirement. The method computes individual adaptive learning rates for different parameters from estimates of first and second moments of the gradients; the name Adam is derived from adaptive moment estimation. Our method is designed to combine the advantages of two recently popular methods: AdaGrad ');
  await cite('duchi2011');
  await T(', which works well with sparse gradients, and RMSProp ');
  await cite('tieleman2012');
  await T(', which works well in on-line and non-stationary settings; important connections to these and other stochastic optimization methods are clarified in section ');
  await insertRef(page, 'sec:related');
  await T(". Some of Adam's advantages are that the magnitudes of parameter updates are invariant to rescaling of the gradient, its stepsizes are approximately bounded by the stepsize hyperparameter, it does not require a stationary objective, it works with sparse gradients, and it naturally performs a form of step size annealing.");

  // Algorithm 1
  await P();
  await insertFloat(page, 'Algorithm');
  await bold('Require: ');
  await M(r`\alpha`);
  await T(': Stepsize');
  await P();
  await bold('Require: ');
  await M(r`\beta_{1},\beta_{2}\in[0,1)`);
  await T(': Exponential decay rates for the moment estimates');
  await P();
  await bold('Require: ');
  await M(r`f(\theta)`);
  await T(': Stochastic objective function with parameters ');
  await M(r`\theta`);
  await P();
  await bold('Require: ');
  await M(r`\theta_{0}`);
  await T(': Initial parameter vector');
  await P();
  await step(r`m_{0}\leftarrow0`, 'Initialize 1st moment vector');
  await P();
  await step(r`v_{0}\leftarrow0`, 'Initialize 2nd moment vector');
  await P();
  await step(r`t\leftarrow0`, 'Initialize timestep');
  await P();
  await bold('while ');
  await M(r`\theta_{t}`);
  await T(' not converged ');
  await bold('do');
  await P();
  await setLayout(page, 'i');
  await M(r`t\leftarrow t+1`);
  await P();
  await step(r`g_{t}\leftarrow\nabla_{\theta}f_{t}(\theta_{t-1})`, 'Get gradients w.r.t. stochastic objective at timestep t');
  await P();
  await step(r`m_{t}\leftarrow\beta_{1}\cdot m_{t-1}+(1-\beta_{1})\cdot g_{t}`, 'Update biased first moment estimate');
  await P();
  await step(r`v_{t}\leftarrow\beta_{2}\cdot v_{t-1}+(1-\beta_{2})\cdot g_{t}^{2}`, 'Update biased second raw moment estimate');
  await P();
  await step(r`\hat{m}_{t}\leftarrow m_{t}/(1-\beta_{1}^{t})`, 'Compute bias-corrected first moment estimate');
  await P();
  await step(r`\hat{v}_{t}\leftarrow v_{t}/(1-\beta_{2}^{t})`, 'Compute bias-corrected second raw moment estimate');
  await P();
  await step(r`\theta_{t}\leftarrow\theta_{t-1}-\alpha\cdot\hat{m}_{t}/(\sqrt{\hat{v}_{t}}+\epsilon)`, 'Update parameters');
  await P();
  await setLayout(page, 's');
  await bold('end while');
  await P();
  await bold('return ');
  await M(r`\theta_{t}`);
  await T(' (Resulting parameters)');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(100);
  await typeCaption(page, async () => {
    await T('Adam, our proposed algorithm for stochastic optimization. See section ');
    await insertRef(page, 'sec:algorithm');
    await T(' for details, and for a slightly more efficient (but less clear) order of computation. ');
    await M(r`g_{t}^{2}`);
    await T(' indicates the elementwise square ');
    await M(r`g_{t}\odot g_{t}`);
    await T('. Good default settings for the tested machine learning problems are ');
    await M(r`\alpha=0.001`);
    await T(', ');
    await M(r`\beta_{1}=0.9`);
    await T(', ');
    await M(r`\beta_{2}=0.999`);
    await T(' and ');
    await M(r`\epsilon=10^{-8}`);
    await T('. All operations on vectors are element-wise. With ');
    await M(r`\beta_{1}^{t}`);
    await T(' and ');
    await M(r`\beta_{2}^{t}`);
    await T(' we denote ');
    await M(r`\beta_{1}`);
    await T(' and ');
    await M(r`\beta_{2}`);
    await T(' to the power ');
    await M('t');
    await T('.');
  }, 'alg:adam');
  await leaveFloat(page);
  await P();
  await T('In section ');
  await insertRef(page, 'sec:algorithm');
  await T(' we describe the algorithm and the properties of its update rule. Section ');
  await insertRef(page, 'sec:bias');
  await T(' explains our initialization bias correction technique, and section ');
  await insertRef(page, 'sec:convergence');
  await T(" provides a theoretical analysis of Adam's convergence in online convex programming. Empirically, our method consistently outperforms other methods for a variety of models and datasets, as shown in section ");
  await insertRef(page, 'sec:experiments');
  await T('. Overall, we show that Adam is a versatile algorithm that scales to large-scale high-dimensional machine learning problems.');

  /* --- 2 Algorithm ---------------------------------------------------------------- */
  await section('Algorithm', 'sec:algorithm');
  await T('See algorithm ');
  await insertRef(page, 'alg:adam');
  await T(' for pseudo-code of our proposed algorithm Adam. Let ');
  await M(r`f(\theta)`);
  await T(' be a noisy objective function: a stochastic scalar function that is differentiable w.r.t. parameters ');
  await M(r`\theta`);
  await T('. We are interested in minimizing the expected value of this function, ');
  await M(r`\mathbb{E}[f(\theta)]`);
  await T(' w.r.t. its parameters ');
  await M(r`\theta`);
  await T('. With ');
  await M(r`f_{1}(\theta),\ldots,f_{T}(\theta)`);
  await T(' we denote the realisations of the stochastic function at subsequent timesteps ');
  await M(r`1,\ldots,T`);
  await T('. The stochasticity might come from the evaluation at random subsamples (minibatches) of datapoints, or arise from inherent function noise. With ');
  await M(r`g_{t}=\nabla_{\theta}f_{t}(\theta)`);
  await T(' we denote the gradient, i.e. the vector of partial derivatives of ');
  await M(r`f_{t}`);
  await T(', w.r.t ');
  await M(r`\theta`);
  await T(' evaluated at timestep ');
  await M('t');
  await T('.');
  await P();
  await T('The algorithm updates exponential moving averages of the gradient (');
  await M(r`m_{t}`);
  await T(') and the squared gradient (');
  await M(r`v_{t}`);
  await T(') where the hyper-parameters ');
  await M(r`\beta_{1},\beta_{2}\in[0,1)`);
  await T(' control the exponential decay rates of these moving averages:');
  await displayLatex(page, r`m_{t} & \leftarrow\beta_{1}\cdot m_{t-1}+(1-\beta_{1})\cdot g_{t}\\ v_{t} & \leftarrow\beta_{2}\cdot v_{t-1}+(1-\beta_{2})\cdot g_{t}^{2}\\ \hat{m}_{t} & \leftarrow m_{t}/(1-\beta_{1}^{t})\\ \hat{v}_{t} & \leftarrow v_{t}/(1-\beta_{2}^{t})\\ \theta_{t} & \leftarrow\theta_{t-1}-\alpha\cdot\hat{m}_{t}/(\sqrt{\hat{v}_{t}}+\epsilon)`, { label: 'eq:adam' });
  await P();
  await T('The moving averages themselves are estimates of the 1st moment (the mean) and the 2nd raw moment (the uncentered variance) of the gradient. However, these moving averages are initialized as (vectors of) 0\'s, leading to moment estimates that are biased towards zero, especially during the initial timesteps, and especially when the decay rates are small (i.e. the ');
  await M(r`\beta`);
  await T('s are close to 1). The good news is that this initialization bias can be easily counteracted, resulting in bias-corrected estimates ');
  await M(r`\hat{m}_{t}`);
  await T(' and ');
  await M(r`\hat{v}_{t}`);
  await T('. See section ');
  await insertRef(page, 'sec:bias');
  await T(' for more details.');
  await P();
  await T('Note that the efficiency of algorithm ');
  await insertRef(page, 'alg:adam');
  await T(' can, at the expense of clarity, be improved upon by changing the order of computation, e.g. by replacing the last three lines in the loop with the following lines: ');
  await M(r`\alpha_{t}=\alpha\cdot\sqrt{1-\beta_{2}^{t}}/(1-\beta_{1}^{t})`);
  await T(' and ');
  await M(r`\theta_{t}\leftarrow\theta_{t-1}-\alpha_{t}\cdot m_{t}/(\sqrt{v_{t}}+\hat{\epsilon})`);
  await T('.');

  await subsection("Adam's update rule", 'sec:update');
  await T("An important property of Adam's update rule is its careful choice of stepsizes. Assuming ");
  await M(r`\epsilon=0`);
  await T(', the effective step taken in parameter space at timestep ');
  await M('t');
  await T(' is ');
  await M(r`\Delta_{t}=\alpha\cdot\hat{m}_{t}/\sqrt{\hat{v}_{t}}`);
  await T('. The effective stepsize has two upper bounds: ');
  await M(r`|\Delta_{t}|\leq\alpha\cdot(1-\beta_{1})/\sqrt{1-\beta_{2}}`);
  await T(' in the case ');
  await M(r`(1-\beta_{1})>\sqrt{1-\beta_{2}}`);
  await T(', and ');
  await M(r`|\Delta_{t}|\leq\alpha`);
  await T(' otherwise. The first case only happens in the most severe case of sparsity: when a gradient has been zero at all timesteps except at the current timestep. For less sparse cases, the effective stepsize will be smaller. When ');
  await M(r`(1-\beta_{1})=\sqrt{1-\beta_{2}}`);
  await T(' we have that ');
  await M(r`|\hat{m}_{t}/\sqrt{\hat{v}_{t}}|<1`);
  await T(' therefore ');
  await M(r`|\Delta_{t}|<\alpha`);
  await T('. In more common scenarios, we will have that ');
  await M(r`\hat{m}_{t}/\sqrt{\hat{v}_{t}}\approx\pm1`);
  await T(' since ');
  await M(r`|\mathbb{E}[g]/\sqrt{\mathbb{E}[g^{2}]}|\leq1`);
  await T('. The effective magnitude of the steps taken in parameter space at each timestep are approximately bounded by the stepsize setting ');
  await M(r`\alpha`);
  await T(', i.e., ');
  await M(r`|\Delta_{t}|\lesssim\alpha`);
  await T('. This can be understood as establishing a trust region around the current parameter value, beyond which the current gradient estimate does not provide sufficient information. This typically makes it relatively easy to know the right scale of ');
  await M(r`\alpha`);
  await T(' in advance. For many machine learning models, for instance, we often know in advance that good optima are with high probability within some set region in parameter space; it is not uncommon, for example, to have a prior distribution over the parameters. Since ');
  await M(r`\alpha`);
  await T(' sets (an upper bound of) the magnitude of steps in parameter space, we can often deduce the right order of magnitude of ');
  await M(r`\alpha`);
  await T(' such that optima can be reached from ');
  await M(r`\theta_{0}`);
  await T(' within some number of iterations. With a slight abuse of terminology, we will call the ratio ');
  await M(r`\hat{m}_{t}/\sqrt{\hat{v}_{t}}`);
  await T(' the signal-to-noise ratio (SNR). With a smaller SNR the effective stepsize ');
  await M(r`\Delta_{t}`);
  await T(' will be closer to zero. This is a desirable property, since a smaller SNR means that there is greater uncertainty about whether the direction of ');
  await M(r`\hat{m}_{t}`);
  await T(' corresponds to the direction of the true gradient. For example, the SNR value typically becomes closer to 0 towards an optimum, leading to smaller effective steps in parameter space: a form of automatic annealing. The effective stepsize ');
  await M(r`\Delta_{t}`);
  await T(' is also invariant to the scale of the gradients; rescaling the gradients ');
  await M('g');
  await T(' with factor ');
  await M('c');
  await T(' will scale ');
  await M(r`\hat{m}_{t}`);
  await T(' with a factor ');
  await M('c');
  await T(' and ');
  await M(r`\hat{v}_{t}`);
  await T(' with a factor ');
  await M(r`c^{2}`);
  await T(', which cancel out: ');
  await M(r`(c\cdot\hat{m}_{t})/(\sqrt{c^{2}\cdot\hat{v}_{t}})=\hat{m}_{t}/\sqrt{\hat{v}_{t}}`);
  await T('.');

  /* --- 3 Initialization bias correction ------------------------------------------- */
  await section('Initialization bias correction', 'sec:bias');
  await T('As explained in section ');
  await insertRef(page, 'sec:algorithm');
  await T(', Adam utilizes initialization bias correction terms. We will here derive the term for the second moment estimate; the derivation for the first moment estimate is completely analogous. Let ');
  await M('g');
  await T(' be the gradient of the stochastic objective ');
  await M('f');
  await T(', and we wish to estimate its second raw moment (uncentered variance) using an exponential moving average of the squared gradient, with decay rate ');
  await M(r`\beta_{2}`);
  await T('. Let ');
  await M(r`g_{1},\ldots,g_{T}`);
  await T(' be the gradients at subsequent timesteps, each a draw from an underlying gradient distribution ');
  await M(r`g_{t}\sim p(g_{t})`);
  await T('. Let us initialize the exponential moving average as ');
  await M(r`v_{0}=0`);
  await T(' (a vector of zeros). First note that the update at timestep ');
  await M('t');
  await T(' of the exponential moving average ');
  await M(r`v_{t}=\beta_{2}\cdot v_{t-1}+(1-\beta_{2})\cdot g_{t}^{2}`);
  await T(' (where ');
  await M(r`g_{t}^{2}`);
  await T(' indicates the elementwise square ');
  await M(r`g_{t}\odot g_{t}`);
  await T(') can be written as a function of the gradients at all previous timesteps:');
  await displayLatex(page, r`v_{t}=(1-\beta_{2})\sum_{i=1}^{t}\beta_{2}^{t-i}\cdot g_{i}^{2}`, { numbered: true, label: 'eq:vt' });
  await P();
  await T('We wish to know how ');
  await M(r`\mathbb{E}[v_{t}]`);
  await T(', the expected value of the exponential moving average at timestep ');
  await M('t');
  await T(', relates to the true second moment ');
  await M(r`\mathbb{E}[g_{t}^{2}]`);
  await T(', so we can correct for the discrepancy between the two. Taking expectations of the left-hand and right-hand sides of eq. ');
  await insertRef(page, 'eq:vt', 'eqref');
  await T(':');
  await displayLatex(page, r`\mathbb{E}[v_{t}] & =\mathbb{E}\left[(1-\beta_{2})\sum_{i=1}^{t}\beta_{2}^{t-i}\cdot g_{i}^{2}\right]\\ & =\mathbb{E}[g_{t}^{2}]\cdot(1-\beta_{2})\sum_{i=1}^{t}\beta_{2}^{t-i}+\zeta\\ & =\mathbb{E}[g_{t}^{2}]\cdot(1-\beta_{2}^{t})+\zeta`, { label: 'eq:ev' });
  await P();
  await T('where ');
  await M(r`\zeta=0`);
  await T(' if the true second moment ');
  await M(r`\mathbb{E}[g_{i}^{2}]`);
  await T(' is stationary; otherwise ');
  await M(r`\zeta`);
  await T(' can be kept small since the exponential decay rate ');
  await M(r`\beta_{1}`);
  await T(' can (and should) be chosen such that the exponential moving average assigns small weights to gradients too far in the past. What is left is the term ');
  await M(r`(1-\beta_{2}^{t})`);
  await T(' which is caused by initializing the running average with zeros. In algorithm ');
  await insertRef(page, 'alg:adam');
  await T(' we therefore divide by this term to correct the initialization bias.');
  await P();
  await T('In case of sparse gradients, for a reliable estimate of the second moment one needs to average over many gradients by chosing a small value of ');
  await M(r`\beta_{2}`);
  await T('; however it is exactly this case of small ');
  await M(r`\beta_{2}`);
  await T(' where a lack of initialisation bias correction would lead to initial steps that are much larger.');

  /* --- 4 Convergence analysis ----------------------------------------------------- */
  await section('Convergence analysis', 'sec:convergence');
  await T('We analyze the convergence of Adam using the online learning framework proposed in ');
  await cite('zinkevich2003');
  await T('. Given an arbitrary, unknown sequence of convex cost functions ');
  await M(r`f_{1}(\theta),f_{2}(\theta),\ldots,f_{T}(\theta)`);
  await T('. At each time ');
  await M('t');
  await T(', our goal is to predict the parameter ');
  await M(r`\theta_{t}`);
  await T(' and evaluate it on a previously unknown cost function ');
  await M(r`f_{t}`);
  await T('. Since the nature of the sequence is unknown in advance, we evaluate our algorithm using the regret, that is the sum of all the previous difference between the online prediction ');
  await M(r`f_{t}(\theta_{t})`);
  await T(' and the best fixed point parameter ');
  await M(r`f_{t}(\theta^{*})`);
  await T(' from a feasible set ');
  await M(r`\mathcal{X}`);
  await T(' for all the previous steps. Concretely, the regret is defined as:');
  await displayLatex(page, r`R(T)=\sum_{t=1}^{T}[f_{t}(\theta_{t})-f_{t}(\theta^{*})]`, { numbered: true, label: 'eq:regret' });
  await P();
  await T('where ');
  await M(r`\theta^{*}=\arg\min_{\theta\in\mathcal{X}}\sum_{t=1}^{T}f_{t}(\theta)`);
  await T('. We show Adam has ');
  await M(r`O(\sqrt{T})`);
  await T(' regret bound and a proof is given in the appendix. Our result is comparable to the best known bound for this general convex online learning problem. We also use some definitions simplify our notation, where ');
  await M(r`g_{t}\triangleq\nabla f_{t}(\theta_{t})`);
  await T(' and ');
  await M(r`g_{t,i}`);
  await T(' as the ');
  await M(r`i^{th}`);
  await T(' element. We define ');
  await M(r`g_{1:t,i}\in\mathbb{R}^{t}`);
  await T(' as a vector that contains the ');
  await M(r`i^{th}`);
  await T(' dimension of the gradients over all iterations till ');
  await M('t');
  await T(', ');
  await M(r`g_{1:t,i}=[g_{1,i},g_{2,i},\cdots,g_{t,i}]`);
  await T('. Also, we define ');
  await M(r`\gamma\triangleq\frac{\beta_{1}^{2}}{\sqrt{\beta_{2}}}`);
  await T('. Our following theorem holds when the learning rate ');
  await M(r`\alpha_{t}`);
  await T(' is decaying at a rate of ');
  await M(r`t^{-\frac{1}{2}}`);
  await T(' and first moment running average coefficient ');
  await M(r`\beta_{1,t}`);
  await T(' decay exponentially with ');
  await M(r`\lambda`);
  await T(', that is typically close to 1, e.g. ');
  await M(r`1-10^{-8}`);
  await T('.');
  await P();
  await selectLayout(page, 'Theorem');
  await T('Assume that the function ');
  await M(r`f_{t}`);
  await T(' has bounded gradients, ');
  await M(r`\Vert\nabla f_{t}(\theta)\Vert_{2}\leq G`);
  await T(', ');
  await M(r`\Vert\nabla f_{t}(\theta)\Vert_{\infty}\leq G_{\infty}`);
  await T(' for all ');
  await M(r`\theta\in\mathbb{R}^{d}`);
  await T(' and distance between any ');
  await M(r`\theta_{t}`);
  await T(' generated by Adam is bounded, ');
  await M(r`\Vert\theta_{n}-\theta_{m}\Vert_{2}\leq D`);
  await T(', ');
  await M(r`\Vert\theta_{m}-\theta_{n}\Vert_{\infty}\leq D_{\infty}`);
  await T(' for any ');
  await M(r`m,n\in\lbrace1,\ldots,T\rbrace`);
  await T(', and ');
  await M(r`\beta_{1},\beta_{2}\in[0,1)`);
  await T(' satisfy ');
  await M(r`\frac{\beta_{1}^{2}}{\sqrt{\beta_{2}}}<1`);
  await T('. Let ');
  await M(r`\alpha_{t}=\frac{\alpha}{\sqrt{t}}`);
  await T(' and ');
  await M(r`\beta_{1,t}=\beta_{1}\lambda^{t-1},\lambda\in(0,1)`);
  await T('. Adam achieves the following guarantee, for all ');
  await M(r`T\geq1`);
  await T('.');
  await insertLabel(page, 'thm:regret');
  await displayLatex(page, r`R(T)\leq\frac{D^{2}}{2\alpha(1-\beta_{1})}\sum_{i=1}^{d}\sqrt{T\hat{v}_{T,i}}+\frac{\alpha(1+\beta_{1})G_{\infty}}{(1-\beta_{1})\sqrt{1-\beta_{2}}(1-\gamma)^{2}}\sum_{i=1}^{d}\Vert g_{1:T,i}\Vert_{2}+\sum_{i=1}^{d}\frac{D_{\infty}^{2}G_{\infty}\sqrt{1-\beta_{2}}}{2\alpha(1-\beta_{1})(1-\lambda)^{2}}`);
  await P();
  await setLayout(page, 's');
  await T('Our Theorem ');
  await insertRef(page, 'thm:regret');
  await T(' implies when the data features are sparse and bounded gradients, the summation term can be much smaller than its upper bound ');
  await M(r`\sum_{i=1}^{d}\Vert g_{1:T,i}\Vert_{2}<<dG_{\infty}\sqrt{T}`);
  await T(' and ');
  await M(r`\sum_{i=1}^{d}\sqrt{T\hat{v}_{T,i}}<<dG_{\infty}\sqrt{T}`);
  await T(', in particular if the class of function and data features are in the form of section 1.2 in ');
  await cite('duchi2011');
  await T('. Their results for the expected value ');
  await M(r`\mathbb{E}[\sum_{i=1}^{d}\Vert g_{1:T,i}\Vert_{2}]`);
  await T(' also apply to Adam. In particular, the adaptive method, such as Adam and Adagrad, can achieve ');
  await M(r`O(\log d\sqrt{T})`);
  await T(', an improvement over ');
  await M(r`O(\sqrt{dT})`);
  await T(' for the non-adaptive method. Decaying ');
  await M(r`\beta_{1,t}`);
  await T(' towards zero is important in our theoretical analysis and also matches previous empirical findings, e.g. ');
  await cite('sutskever2013');
  await T(' suggests reducing the momentum coefficient in the end of training can improve convergence.');
  await P();
  await T('Finally, we can show the average regret of Adam converges,');
  await P();
  await selectLayout(page, 'Corollary');
  await T('Assume that the function ');
  await M(r`f_{t}`);
  await T(' has bounded gradients, ');
  await M(r`\Vert\nabla f_{t}(\theta)\Vert_{2}\leq G`);
  await T(', ');
  await M(r`\Vert\nabla f_{t}(\theta)\Vert_{\infty}\leq G_{\infty}`);
  await T(' for all ');
  await M(r`\theta\in\mathbb{R}^{d}`);
  await T(' and distance between any ');
  await M(r`\theta_{t}`);
  await T(' generated by Adam is bounded, ');
  await M(r`\Vert\theta_{n}-\theta_{m}\Vert_{2}\leq D`);
  await T(', ');
  await M(r`\Vert\theta_{m}-\theta_{n}\Vert_{\infty}\leq D_{\infty}`);
  await T(' for any ');
  await M(r`m,n\in\lbrace1,\ldots,T\rbrace`);
  await T('. Adam achieves the following guarantee, for all ');
  await M(r`T\geq1`);
  await T('.');
  await insertLabel(page, 'cor:average');
  await displayLatex(page, r`\frac{R(T)}{T}=O\left(\frac{1}{\sqrt{T}}\right)`);
  await P();
  await setLayout(page, 's');
  await T('This result can be obtained by using Theorem ');
  await insertRef(page, 'thm:regret');
  await T(' and ');
  await M(r`\sum_{i=1}^{d}\Vert g_{1:T,i}\Vert_{2}\leq dG_{\infty}\sqrt{T}`);
  await T('. Thus, ');
  await M(r`\lim_{T\to\infty}\frac{R(T)}{T}=0`);
  await T('.');

  /* --- 5 Related work ------------------------------------------------------------- */
  await section('Related work', 'sec:related');
  await T('Optimization methods bearing a direct relation to Adam are RMSProp ');
  await cite('tieleman2012');
  await T(' ');
  await cite('graves2013generating');
  await T(' and AdaGrad ');
  await cite('duchi2011');
  await T('; these relationships are discussed below. Other stochastic optimization methods include vSGD ');
  await cite('schaul2012');
  await T(', AdaDelta ');
  await cite('zeiler2012');
  await T(' and the natural Newton method from ');
  await cite('roux2010');
  await T(', all setting stepsizes by estimating curvature from first-order information. The Sum-of-Functions Optimizer (SFO) ');
  await cite('sohl2014');
  await T(' is a quasi-Newton method based on minibatches, but (unlike Adam) has memory requirements linear in the number of minibatch partitions of a dataset, which is often infeasible on memory-constrained systems such as a GPU. Like natural gradient descent (NGD) ');
  await cite('amari1998');
  await T(', Adam employs a preconditioner that adapts to the geometry of the data, since ');
  await M(r`\hat{v}_{t}`);
  await T(' is an approximation to the diagonal of the Fisher information matrix ');
  await cite('pascanu2013');
  await T("; however, Adam's preconditioner (like AdaGrad's) is more conservative in its adaption than vanilla NGD by preconditioning with the square root of the inverse of the diagonal Fisher information matrix approximation.");
  await P();
  await setLayout(page, 'd');
  await T('RMSProp: An optimization method closely related to Adam is RMSProp ');
  await cite('tieleman2012');
  await T('. A version with momentum has sometimes been used ');
  await cite('graves2013generating');
  await T('. There are a few important differences between RMSProp with momentum and Adam: RMSProp with momentum generates its parameter updates using a momentum on the rescaled gradient, whereas Adam updates are directly estimated using a running average of first and second moment of the gradient. RMSProp also lacks a bias-correction term; this matters most in case of a value of ');
  await M(r`\beta_{2}`);
  await T(' close to 1 (required in case of sparse gradients), since in that case not correcting the bias leads to very large stepsizes and often divergence, as we also empirically demonstrate in section ');
  await insertRef(page, 'sec:biasexp');
  await T('.');
  await P();
  await T('AdaGrad: An algorithm that works well for sparse gradients is AdaGrad ');
  await cite('duchi2011');
  await T('. Its basic version updates parameters as ');
  await M(r`\theta_{t+1}=\theta_{t}-\alpha\cdot g_{t}/\sqrt{\sum_{i=1}^{t}g_{t}^{2}}`);
  await T('. Note that if we choose ');
  await M(r`\beta_{2}`);
  await T(' to be infinitesimally close to 1 from below, then ');
  await M(r`\lim_{\beta_{2}\to1}\hat{v}_{t}=t^{-1}\cdot\sum_{i=1}^{t}g_{t}^{2}`);
  await T('. AdaGrad corresponds to a version of Adam with ');
  await M(r`\beta_{1}=0`);
  await T(', infinitesimal ');
  await M(r`(1-\beta_{2})`);
  await T(' and a replacement of ');
  await M(r`\alpha`);
  await T(' by an annealed version ');
  await M(r`\alpha_{t}=\alpha\cdot t^{-1/2}`);
  await T(', namely ');
  await M(r`\theta_{t}-\alpha\cdot t^{-1/2}\cdot\hat{m}_{t}/\sqrt{\lim_{\beta_{2}\to1}\hat{v}_{t}}=\theta_{t}-\alpha\cdot t^{-1/2}\cdot g_{t}/\sqrt{t^{-1}\cdot\sum_{i=1}^{t}g_{t}^{2}}=\theta_{t}-\alpha\cdot g_{t}/\sqrt{\sum_{i=1}^{t}g_{t}^{2}}`);
  await T('. Note that this direct correspondence between Adam and Adagrad does not hold when removing the bias-correction terms; without bias correction, like in RMSProp, a ');
  await M(r`\beta_{2}`);
  await T(' infinitesimally close to 1 would lead to infinitely large bias, and infinitely large parameter updates.');
  await expect(page.locator('.lyx-layout-description')).toHaveCount(2);

  await expect.poll(() => fileText().includes('infinitely large parameter updates.'), { timeout: 20000 }).toBe(true);
  await expect(page.locator('.katex-error')).toHaveCount(0);
  expect(noErrors(errors)).toEqual([]);
  writeFileSync(KEYS_FILE, JSON.stringify(keys));   // the citation keys, for the second session
});

/** The second session: the author comes back, opens the document and continues at its end (a fresh page — a browser tab does not live through a whole paper). */
test('writing "Adam", sections 6-8, acknowledgments and the bibliography', async ({ page }) => {
  test.skip(!existsSync(KEYS_FILE), 'the first sections were not typed');
  test.setTimeout(1200000);
  const errors = collectErrors(page);
  const keys: Record<string, string> = JSON.parse(readFileSync(KEYS_FILE, 'utf8'));
  const { T, M, P, section, subsection, cite, figure, step, bold } = tools(page, keys);
  await openPaper(page, PROJECT, 'adam.tex');
  await expect(page.locator('.lyx-layout-description')).toHaveCount(2, { timeout: 15000 });
  await page.locator('.lyx-editor > .lyx-par').last().click();
  await page.keyboard.press('Control+End');   // the end of the document — End alone stops at the end of the clicked line of this long paragraph

  /* --- 6 Experiments -------------------------------------------------------------- */
  await section('Experiments', 'sec:experiments');
  await T('To empirically evaluate the proposed method, we investigated different popular machine learning models, including logistic regression, multilayer fully connected neural networks and deep convolutional neural networks. Using large models and datasets, we demonstrate Adam can efficiently solve practical deep learning problems.');
  await P();
  await T('We use the same parameter initialization when comparing different optimization algorithms. The hyper-parameters, such as learning rate and momentum, are searched over a dense grid and the results are reported using the best hyper-parameter setting.');

  await subsection('Experiment: Logistic Regression', 'sec:logreg');
  await T('We evaluate our proposed method on ');
  await M(r`L_{2}`);
  await T('-regularized multi-class logistic regression using the MNIST dataset. Logistic regression has a well-studied convex objective, making it suitable for comparison of different optimizers without worrying about local minimum issues. The stepsize ');
  await M(r`\alpha`);
  await T(' in our logistic regression experiments is adjusted by ');
  await M(r`1/\sqrt{t}`);
  await T(' decay, namely ');
  await M(r`\alpha_{t}=\frac{\alpha}{\sqrt{t}}`);
  await T(' that matches with our theoratical prediction from section ');
  await insertRef(page, 'sec:convergence');
  await T('. The logistic regression classifies the class label directly on the 784 dimension image vectors. We compare Adam to accelerated SGD with Nesterov momentum and Adagrad using minibatch size of 128. According to Figure ');
  await insertRef(page, 'fig:logreg');
  await T(', we found that the Adam yields similar convergence as SGD with momentum and both converge faster than Adagrad.');
  await P();
  await T('As discussed in ');
  await cite('duchi2011');
  await T(', Adagrad can efficiently deal with sparse features and gradients as one of its main theoretical results whereas SGD is low at learning rare features. Adam with ');
  await M(r`1/\sqrt{t}`);
  await T(' decay on its stepsize should theoratically match the performance of Adagrad. We examine the sparse feature problem using IMDB movie review dataset from ');
  await cite('maas2011');
  await T('. We pre-process the IMDB movie reviews into bag-of-words (BoW) feature vectors including the first 10,000 most frequent words. The 10,000 dimension BoW feature vector for each review is highly sparse. As suggested in ');
  await cite('wang2013');
  await T(', 50% dropout noise can be applied to the BoW features during training to prevent over-fitting. In figure ');
  await insertRef(page, 'fig:logreg');
  await T(', Adagrad outperforms SGD with Nesterov momentum by a large margin both with and without dropout noise. Adam converges as fast as Adagrad. The empirical performance of Adam is consistent with our theoretical findings in sections ');
  await insertRef(page, 'sec:algorithm');
  await T(' and ');
  await insertRef(page, 'sec:convergence');
  await T('. Similar to Adagrad, Adam can take advantage of sparse features and obtain faster convergence rate than normal SGD with momentum.');
  await figure(`${FIGS}/adam-logreg.png`, async () => { await T('Logistic regression training negative log likelihood on MNIST images and IMDB movie reviews with 10,000 bag-of-words (BoW) feature vectors.'); }, 'fig:logreg');

  await subsection('Experiment: Multi-layer Neural Networks', 'sec:mlp');
  await T('Multi-layer neural network are powerful models with non-convex objective functions. Although our convergence analysis does not apply to non-convex problems, we empirically found that Adam often outperforms other methods in such cases. In our experiments, we made model choices that are consistent with previous publications in the area; a neural network model with two fully connected hidden layers with 1000 hidden units each and ReLU activation are used for this experiment with minibatch size of 128.');
  await P();
  await T('First, we study different optimizers using the standard deterministic cross-entropy objective function with ');
  await M(r`L_{2}`);
  await T(' weight decay on the parameters to prevent over-fitting. The sum-of-functions (SFO) method ');
  await cite('sohl2014');
  await T(' is a recently proposed quasi-Newton method that works with minibatches of data and has shown good performance on optimization of multi-layer neural networks. We used their implementation and compared with Adam to train such models. Figure ');
  await insertRef(page, 'fig:mlp');
  await T(' shows that Adam makes faster progress in terms of both the number of iterations and wall-clock time. Due to the cost of updating curvature information, SFO is 5-10x slower per iteration compared to Adam, and has a memory requirement that is linear in the number minibatches.');
  await P();
  await T('Stochastic regularization methods, such as dropout, are an effective way to prevent over-fitting and often used in practice due to their simplicity. SFO assumes deterministic subfunctions, and indeed failed to converge on cost functions with stochastic regularization. We compare the effectiveness of Adam to other stochastic first order methods on multi-layer neural networks trained with dropout noise. Figure ');
  await insertRef(page, 'fig:mlp');
  await T(' shows our results; Adam shows better convergence than other methods.');
  await figure(`${FIGS}/adam-mlp.png`, async () => {
    await T('Training of multilayer neural networks on MNIST images. (a) Neural networks using dropout stochastic regularization. (b) Neural networks with deterministic cost function. We compare with the sum-of-functions (SFO) optimizer ');
    await cite('sohl2014');
  }, 'fig:mlp');

  await subsection('Experiment: Convolutional Neural Networks', 'sec:cnn');
  await T("Convolutional neural networks (CNNs) with several layers of convolution, pooling and non-linear units have shown considerable success in computer vision tasks. Unlike most fully connected neural nets, weight sharing in CNNs results in vastly different gradients in different layers. A smaller learning rate for the convolution layers is often used in practice when applying SGD. We show the effectiveness of Adam in deep CNNs. Our CNN architecture has three alternating stages of 5x5 convolution filters and 3x3 max pooling with stride of 2 that are followed by a fully connected layer of 1000 rectified linear hidden units (ReLU's). The input image are pre-processed by whitening, and dropout noise is applied to the input layer and fully connected layer. The minibatch size is also set to 128 similar to previous experiments.");
  await P();
  await T('Interestingly, although both Adam and Adagrad make rapid progress lowering the cost in the initial stage of the training, shown in Figure ');
  await insertRef(page, 'fig:cnn');
  await T(' (left), Adam and SGD eventually converge considerably faster than Adagrad for CNNs shown in Figure ');
  await insertRef(page, 'fig:cnn');
  await T(' (right). We notice the second moment estimate ');
  await M(r`\hat{v}_{t}`);
  await T(' vanishes to zeros after a few epochs and is dominated by the ');
  await M(r`\epsilon`);
  await T(' in algorithm ');
  await insertRef(page, 'alg:adam');
  await T('. The second moment estimate is therefore a poor approximation to the geometry of the cost function in CNNs comparing to fully connected network from Section ');
  await insertRef(page, 'sec:mlp');
  await T('. Whereas, reducing the minibatch variance through the first moment is more important in CNNs and contributes to the speed-up. As a result, Adagrad converges much slower than others in this particular experiment. Though Adam shows marginal improvement over SGD with momentum, it adapts learning rate scale for different layers instead of hand picking manually as in SGD.');
  await figure(`${FIGS}/adam-cnn.png`, async () => { await T('Convolutional neural networks training cost. (left) Training cost for the first three epochs. (right) Training cost over 45 epochs. CIFAR-10 with c64-c64-c128-1000 architecture.'); }, 'fig:cnn');

  await subsection('Experiment: bias-correction term', 'sec:biasexp');
  await T('We also empirically evaluate the effect of the bias correction terms explained in sections ');
  await insertRef(page, 'sec:algorithm');
  await T(' and ');
  await insertRef(page, 'sec:bias');
  await T('. Discussed in section ');
  await insertRef(page, 'sec:related');
  await T(', removal of the bias correction terms results in a version of RMSProp ');
  await cite('tieleman2012');
  await T(' with momentum. We vary the ');
  await M(r`\beta_{1}`);
  await T(' and ');
  await M(r`\beta_{2}`);
  await T(' when training a variational auto-encoder (VAE) with the same architecture as in ');
  await cite('kingma2013');
  await T(' with a single hidden layer with 500 hidden units with softplus nonlinearities and a 50-dimensional spherical Gaussian latent variable. We iterated over a broad range of hyper-parameter choices, i.e. ');
  await M(r`\beta_{1}\in[0,0.9]`);
  await T(' and ');
  await M(r`\beta_{2}\in[0.99,0.999,0.9999]`);
  await T(', and ');
  await M(r`\log_{10}(\alpha)\in[-5,\ldots,-1]`);
  await T('. Values of ');
  await M(r`\beta_{2}`);
  await T(' close to 1, required for robustness to sparse gradients, results in larger initialization bias; therefore we expect the bias correction term is important in such cases of slow decay, preventing an adverse effect on optimization.');
  await P();
  await T('In Figure ');
  await insertRef(page, 'fig:bias');
  await T(', values ');
  await M(r`\beta_{2}`);
  await T(' close to 1 indeed lead to instabilities in training when no bias correction term was present, especially at first few epochs of the training. The best results were achieved with small values of ');
  await M(r`(1-\beta_{2})`);
  await T(' and bias correction; this was more apparent towards the end of optimization when gradients tends to become sparser as hidden units specialize to specific patterns. In summary, Adam performed equal or better than RMSProp, regardless of hyper-parameter setting.');
  await figure(`${FIGS}/adam-bias.png`, async () => {
    await T('Effect of bias-correction terms (red line) versus no bias correction terms (green line) after 10 epochs (left) and 100 epochs (right) on the loss (y-axes) when learning a Variational Auto-Encoder (VAE) ');
    await cite('kingma2013');
    await T(', for different settings of stepsize ');
    await M(r`\alpha`);
    await T(' (x-axes) and hyper-parameters ');
    await M(r`\beta_{1}`);
    await T(' and ');
    await M(r`\beta_{2}`);
    await T('.');
  }, 'fig:bias');

  /* --- 7 Extensions --------------------------------------------------------------- */
  await section('Extensions');
  await subsection('AdaMax', 'sec:adamax');
  await T('In Adam, the update rule for individual weights is to scale their gradients inversely proportional to a (scaled) ');
  await M(r`L^{2}`);
  await T(' norm of their individual current and past gradients. We can generalize the ');
  await M(r`L^{2}`);
  await T(' norm based update rule to a ');
  await M(r`L^{p}`);
  await T(' norm based update rule. Such variants become numerically unstable for large ');
  await M('p');
  await T('. However, in the special case where we let ');
  await M(r`p\to\infty`);
  await T(', a surprisingly simple and stable algorithm emerges; see algorithm ');
  await insertRef(page, 'alg:adamax');
  await T(". We'll now derive the algorithm. Let, in case of the ");
  await M(r`L^{p}`);
  await T(' norm, the stepsize at time ');
  await M('t');
  await T(' be inversely proportional to ');
  await M(r`v_{t}^{1/p}`);
  await T(', where:');
  await displayLatex(page, r`v_{t} & =\beta_{2}^{p}v_{t-1}+(1-\beta_{2}^{p})|g_{t}|^{p}\\ & =(1-\beta_{2}^{p})\sum_{i=1}^{t}\beta_{2}^{p(t-i)}\cdot|g_{i}|^{p}`, { label: 'eq:vtp' });
  await P();
  await T('Note that the decay term is here equivalently parameterised as ');
  await M(r`\beta_{2}^{p}`);
  await T(' instead of ');
  await M(r`\beta_{2}`);
  await T('. Now let ');
  await M(r`p\to\infty`);
  await T(', and define ');
  await M(r`u_{t}=\lim_{p\to\infty}(v_{t})^{1/p}`);
  await T(', then:');
  await displayLatex(page, r`u_{t}=\lim_{p\to\infty}(v_{t})^{1/p} & =\lim_{p\to\infty}\left((1-\beta_{2}^{p})\sum_{i=1}^{t}\beta_{2}^{p(t-i)}\cdot|g_{i}|^{p}\right)^{1/p}\\ & =\lim_{p\to\infty}(1-\beta_{2}^{p})^{1/p}\left(\sum_{i=1}^{t}\beta_{2}^{p(t-i)}\cdot|g_{i}|^{p}\right)^{1/p}\\ & =\lim_{p\to\infty}\left(\sum_{i=1}^{t}\left(\beta_{2}^{(t-i)}\cdot|g_{i}|\right)^{p}\right)^{1/p}\\ & =\max\left(\beta_{2}^{t-1}|g_{1}|,\beta_{2}^{t-2}|g_{2}|,\ldots,\beta_{2}|g_{t-1}|,|g_{t}|\right)`, { label: 'eq:ut' });
  await P();
  await T('Which corresponds to the remarkably simple recursive formula:');
  await displayLatex(page, r`u_{t}=\max(\beta_{2}\cdot u_{t-1},|g_{t}|)`, { numbered: true, label: 'eq:umax' });
  await P();
  await T('with initial value ');
  await M(r`u_{0}=0`);
  await T(". Note that, conveniently enough, we don't need to correct for initialization bias in this case. Also note that the magnitude of parameter updates has a simpler bound with AdaMax than Adam, namely: ");
  await M(r`|\Delta_{t}|\leq\alpha`);
  await T('.');

  // Algorithm 2
  await P();
  await insertFloat(page, 'Algorithm');
  await bold('Require: ');
  await M(r`\alpha`);
  await T(': Stepsize');
  await P();
  await bold('Require: ');
  await M(r`\beta_{1},\beta_{2}\in[0,1)`);
  await T(': Exponential decay rates');
  await P();
  await bold('Require: ');
  await M(r`f(\theta)`);
  await T(': Stochastic objective function with parameters ');
  await M(r`\theta`);
  await P();
  await bold('Require: ');
  await M(r`\theta_{0}`);
  await T(': Initial parameter vector');
  await P();
  await step(r`m_{0}\leftarrow0`, 'Initialize 1st moment vector');
  await P();
  await step(r`u_{0}\leftarrow0`, 'Initialize the exponentially weighted infinity norm');
  await P();
  await step(r`t\leftarrow0`, 'Initialize timestep');
  await P();
  await bold('while ');
  await M(r`\theta_{t}`);
  await T(' not converged ');
  await bold('do');
  await P();
  await setLayout(page, 'i');
  await M(r`t\leftarrow t+1`);
  await P();
  await step(r`g_{t}\leftarrow\nabla_{\theta}f_{t}(\theta_{t-1})`, 'Get gradients w.r.t. stochastic objective at timestep t');
  await P();
  await step(r`m_{t}\leftarrow\beta_{1}\cdot m_{t-1}+(1-\beta_{1})\cdot g_{t}`, 'Update biased first moment estimate');
  await P();
  await step(r`u_{t}\leftarrow\max(\beta_{2}\cdot u_{t-1},|g_{t}|)`, 'Update the exponentially weighted infinity norm');
  await P();
  await step(r`\theta_{t}\leftarrow\theta_{t-1}-(\alpha/(1-\beta_{1}^{t}))\cdot m_{t}/u_{t}`, 'Update parameters');
  await P();
  await setLayout(page, 's');
  await bold('end while');
  await P();
  await bold('return ');
  await M(r`\theta_{t}`);
  await T(' (Resulting parameters)');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(100);
  await typeCaption(page, async () => {
    await T('AdaMax, a variant of Adam based on the infinity norm. See section ');
    await insertRef(page, 'sec:adamax');
    await T(' for details. Good default settings for the tested machine learning problems are ');
    await M(r`\alpha=0.002`);
    await T(', ');
    await M(r`\beta_{1}=0.9`);
    await T(' and ');
    await M(r`\beta_{2}=0.999`);
    await T('. With ');
    await M(r`\beta_{1}^{t}`);
    await T(' we denote ');
    await M(r`\beta_{1}`);
    await T(' to the power ');
    await M('t');
    await T('. Here, ');
    await M(r`(\alpha/(1-\beta_{1}^{t}))`);
    await T(' is the learning rate with the bias-correction term for the first moment. All operations on vectors are element-wise.');
  }, 'alg:adamax');
  await leaveFloat(page);

  await subsection('Temporal averaging', 'sec:averaging');
  await T('Since the last iterate is noisy due to stochastic approximation, better generalization performance is often achieved by averaging. Previously in ');
  await cite('moulines2011');
  await T(', Polyak-Ruppert averaging ');
  await cite('polyak1992', 'ruppert1988');
  await T(' has been shown to improve the convergence of standard SGD, where ');
  await M(r`\bar{\theta}_{t}=\frac{1}{t}\sum_{k=1}^{n}\theta_{k}`);
  await T('. Alternatively, an exponential moving average over the parameters can be used, giving higher weight to more recent parameter values. This can be trivially implemented by adding one line to the inner loop of algorithms ');
  await insertRef(page, 'alg:adam');
  await T(' and ');
  await insertRef(page, 'alg:adamax');
  await T(': ');
  await M(r`\bar{\theta}_{t}\leftarrow\beta_{2}\cdot\bar{\theta}_{t-1}+(1-\beta_{2})\theta_{t}`);
  await T(', with ');
  await M(r`\bar{\theta}_{0}=0`);
  await T('. Initalization bias can again be corrected by the estimator ');
  await M(r`\hat{\theta}_{t}=\bar{\theta}_{t}/(1-\beta_{2}^{t})`);
  await T('.');

  /* --- 8 Conclusion, acknowledgments, bibliography -------------------------------- */
  await section('Conclusion');
  await T('We have introduced a simple and computationally efficient algorithm for gradient-based optimization of stochastic objective functions. Our method is aimed towards machine learning problems with large datasets and/or high-dimensional parameter spaces. The method combines the advantages of two recently popular optimization methods: the ability of AdaGrad to deal with sparse gradients, and the ability of RMSProp to deal with non-stationary objectives. The method is straightforward to implement and requires little memory. The experiments confirm the analysis on the rate of convergence in convex problems. Overall, we found Adam to be robust and well-suited to a wide range of non-convex optimization problems in the field machine learning.');
  await P();
  await page.keyboard.press('Alt+p'); await page.waitForTimeout(80); await page.keyboard.press('*'); await page.waitForTimeout(80); await page.keyboard.press('2'); await page.waitForTimeout(150);
  await T('Acknowledgments');
  await P();
  await T('This paper would probably not have existed without the support of Google Deepmind. We would like to give special thanks to Ivo Danihelka, and Tom Schaul for coining the name Adam. Thanks to Kai Fan from Duke University for spotting an error in the original AdaMax derivation. Experiments in this work were partly carried out on the Dutch national e-infrastructure with the support of SURF Foundation. Diederik Kingma is supported by the Google European Doctorate Fellowship in Deep Learning.');
  await P();
  await insertBibliography(page, 'cited', 'plain');

  /* --- what the file holds ------------------------------------------------------- */
  await expect.poll(() => fileText().includes('\\bibliography{cited}'), { timeout: 20000 }).toBe(true);
  await page.waitForTimeout(2500);
  const text = fileText();
  const c = canonMath(text);
  const has = (latex: string) => expect(c, `expected the formula ${latex}`).toContain(canonMath(latex));
  expect(text).toMatch(/\\begin\{abstract\}[\s\S]*AdaMax[\s\S]*\\end\{abstract\}/);
  for (const s of ['\\section{Introduction}', '\\section{Algorithm}\\label{sec:algorithm}', "\\subsection{Adam's update rule}\\label{sec:update}", '\\section{Initialization bias correction}\\label{sec:bias}',
    '\\section{Convergence analysis}\\label{sec:convergence}', '\\section{Related work}\\label{sec:related}', '\\section{Experiments}\\label{sec:experiments}', '\\subsection{Experiment: Logistic Regression}\\label{sec:logreg}',
    '\\subsection{Experiment: Multi-layer Neural Networks}\\label{sec:mlp}', '\\subsection{Experiment: Convolutional Neural Networks}\\label{sec:cnn}', '\\subsection{Experiment: bias-correction term}\\label{sec:biasexp}',
    '\\section{Extensions}', '\\subsection{AdaMax}\\label{sec:adamax}', '\\subsection{Temporal averaging}\\label{sec:averaging}', '\\section{Conclusion}', '\\section*{Acknowledgments}']) expect(text).toContain(s);
  // headings in the paper's order (anchored on the labels — the forward \ref{}s in the introduction come earlier in the file)
  const order = ['\\section{Introduction}', '\\label{sec:algorithm}', '\\label{sec:update}', '\\label{sec:bias}', '\\label{sec:convergence}', '\\label{sec:related}', '\\label{sec:experiments}', '\\label{sec:logreg}', '\\label{sec:mlp}', '\\label{sec:cnn}', '\\label{sec:biasexp}', '\\section{Extensions}', '\\label{sec:adamax}', '\\label{sec:averaging}', '\\section{Conclusion}', '\\section*{Acknowledgments}', '\\bibliography{cited}'].map(s => text.indexOf(s));
  expect(order.every(i => i >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  // citations
  expect(Object.keys(keys).length).toBe(23);
  expect(text).toMatch(new RegExp(`deep learning \\\\citep?\\{${keys.deng2013},${keys.krizhevsky2012},${keys.hinton2006reducing},${keys.hinton2012deep},${keys.graves2013speech}\\}\\. Objectives`));
  expect(text).toMatch(new RegExp(`AdaGrad \\\\citep?\\{${keys.duchi2011}\\}, which works well with sparse gradients, and RMSProp \\\\citep?\\{${keys.tieleman2012}\\}, which`));
  expect((text.match(new RegExp(`\\\\citep?\\{${keys.duchi2011}\\}`, 'g')) ?? []).length).toBe(5);   // cited five times, four of them from the project's list
  expect(text).toMatch(new RegExp(`Polyak-Ruppert averaging \\\\citep?\\{${keys.polyak1992},${keys.ruppert1988}\\} has been`));
  const bib = readFileSync(`${DIR}/cited.bib`, 'utf8');
  for (const k of Object.values(keys)) expect(bib).toContain(`{${k},`);
  // forward references to sections and floats, \eqref
  expect(text).toMatch(/clarified in section \\ref\{sec:related\}\./);
  expect(text).toMatch(/In section \\ref\{sec:algorithm\} we describe[\s\S]*Section \\ref\{sec:bias\} explains[\s\S]*section \\ref\{sec:convergence\} provides[\s\S]*shown in section \\ref\{sec:experiments\}\./);
  expect(text).toMatch(/sides of eq\. \\eqref\{eq:vt\}:/);
  expect(text).toMatch(/According to Figure \\ref\{fig:logreg\}, we found/);
  expect(text).toMatch(/see algorithm \\ref\{alg:adamax\}\. We'll now derive/);
  // Algorithm 1: bold keywords, formulas in every line, the loop as a list, the caption with formulas
  expect(text).toMatch(/\\begin\{algorithm\}\n\\textbf\{Require: \}\$\\alpha\$: Stepsize\n\n\\textbf\{Require: \}\$\\beta_\{1\},\\beta_\{2\}\\in\[0,1\)\$: Exponential decay rates for the moment estimates\n\n\\textbf\{Require: \}\$f\(\\theta\)\$: Stochastic objective function with parameters \$\\theta\$\n\n\\textbf\{Require: \}\$\\theta_\{0\}\$: Initial parameter vector\n\n\$m_\{0\}\\leftarrow0\$ \(Initialize 1st moment vector\)\n\n\$v_\{0\}\\leftarrow0\$ \(Initialize 2nd moment vector\)\n\n\$t\\leftarrow0\$ \(Initialize timestep\)\n\n\\textbf\{while \}\$\\theta_\{t\}\$ not converged \\textbf\{do\}\n\\begin\{itemize\}\n\\item \$t\\leftarrow t\+1\$\n\\item \$g_\{t\}\\leftarrow\\nabla_\{\\theta\}f_\{t\}\(\\theta_\{t-1\}\)\$ \(Get gradients[\s\S]*\\item \$\\theta_\{t\}\\leftarrow\\theta_\{t-1\}-\\alpha\\cdot\\hat\{m\}_\{t\}\/\(\\sqrt\{\\hat\{v\}_\{t\}\}\+\\epsilon\)\$ \(Update parameters\)\n\\end\{itemize\}\n\\textbf\{end while\}\n\n\\textbf\{return \}\$\\theta_\{t\}\$ \(Resulting parameters\)\n\\caption\{Adam, our proposed algorithm for stochastic optimization\. See section (?:\\protect)?\\ref\{sec:algorithm\} for details[\s\S]*\$g_\{t\}\\odot g_\{t\}\$[\s\S]*\$\\epsilon=10\^\{-8\}\$[\s\S]*to the power \$t\$\.\}\\label\{alg:adam\}\n\\end\{algorithm\}/);
  expect(text).toMatch(/\\item \$u_\{t\}\\leftarrow\\max\(\\beta_\{2\}\\cdot u_\{t-1\},\|g_\{t\}\|\)\$ \(Update the exponentially weighted infinity norm\)\n\\item \$\\theta_\{t\}\\leftarrow\\theta_\{t-1\}-\(\\alpha\/\(1-\\beta(?:_\{1\}\^\{t\}|\^\{t\}_\{1\})\)\)\\cdot m_\{t\}\/u_\{t\}\$ \(Update parameters\)\n\\end\{itemize\}[\s\S]*\\caption\{AdaMax, a variant of Adam based on the infinity norm\. See section (?:\\protect)?\\ref\{sec:adamax\} for details[\s\S]*\}\\label\{alg:adamax\}\n\\end\{algorithm\}/);
  // the aligns and equations
  has(r`\begin{align}m_{t} & \leftarrow\beta_{1}\cdot m_{t-1}+(1-\beta_{1})\cdot g_{t}\\ v_{t} & \leftarrow\beta_{2}\cdot v_{t-1}+(1-\beta_{2})\cdot g_{t}^{2}\\ \hat{m}_{t} & \leftarrow m_{t}/(1-\beta_{1}^{t})\\ \hat{v}_{t} & \leftarrow v_{t}/(1-\beta_{2}^{t})\\ \theta_{t} & \leftarrow\theta_{t-1}-\alpha\cdot\hat{m}_{t}/(\sqrt{\hat{v}_{t}}+\epsilon)\label{eq:adam}\end{align}`);
  has(r`$\alpha_{t}=\alpha\cdot\sqrt{1-\beta_{2}^{t}}/(1-\beta_{1}^{t})$ and $\theta_{t}\leftarrow\theta_{t-1}-\alpha_{t}\cdot m_{t}/(\sqrt{v_{t}}+\hat{\epsilon})$.`);
  has(r`$|\Delta_{t}|\leq\alpha\cdot(1-\beta_{1})/\sqrt{1-\beta_{2}}$`);
  has(r`$|\Delta_{t}|\lesssim\alpha$`);
  has(r`$(c\cdot\hat{m}_{t})/(\sqrt{c^{2}\cdot\hat{v}_{t}})=\hat{m}_{t}/\sqrt{\hat{v}_{t}}$`);
  has(r`\begin{equation}v_{t}=(1-\beta_{2})\sum_{i=1}^{t}\beta_{2}^{t-i}\cdot g_{i}^{2}\label{eq:vt}\end{equation}`);
  has(r`\begin{align}\mathbb{E}[v_{t}] & =\mathbb{E}\left[(1-\beta_{2})\sum_{i=1}^{t}\beta_{2}^{t-i}\cdot g_{i}^{2}\right]\\ & =\mathbb{E}[g_{t}^{2}]\cdot(1-\beta_{2})\sum_{i=1}^{t}\beta_{2}^{t-i}+\zeta\\ & =\mathbb{E}[g_{t}^{2}]\cdot(1-\beta_{2}^{t})+\zeta\label{eq:ev}\end{align}`);
  has(r`\begin{equation}R(T)=\sum_{t=1}^{T}[f_{t}(\theta_{t})-f_{t}(\theta^{*})]\label{eq:regret}\end{equation}`);
  has(r`$\theta^{*}=\arg\min_{\theta\in\mathcal{X}}\sum_{t=1}^{T}f_{t}(\theta)$`);
  has(r`$g_{t}\triangleq\nabla f_{t}(\theta_{t})$`);
  has(r`$\gamma\triangleq\frac{\beta_{1}^{2}}{\sqrt{\beta_{2}}}$`);
  expect(text).toMatch(/\\begin\{thm\}\nAssume that the function \$f_\{t\}\$ has bounded gradients, \$\\Vert\\nabla f_\{t\}\(\\theta\)\\Vert_\{2\}\\leq G\$[\s\S]*for all \$T\\geq1\$\.\\label\{thm:regret\}\n\n\\\[\n[\s\S]*\n\\\]\n\\end\{thm\}/);
  has(r`\[R(T)\leq\frac{D^{2}}{2\alpha(1-\beta_{1})}\sum_{i=1}^{d}\sqrt{T\hat{v}_{T,i}}+\frac{\alpha(1+\beta_{1})G_{\infty}}{(1-\beta_{1})\sqrt{1-\beta_{2}}(1-\gamma)^{2}}\sum_{i=1}^{d}\Vert g_{1:T,i}\Vert_{2}+\sum_{i=1}^{d}\frac{D_{\infty}^{2}G_{\infty}\sqrt{1-\beta_{2}}}{2\alpha(1-\beta_{1})(1-\lambda)^{2}}\]`);
  expect(text).toMatch(/Our Theorem \\ref\{thm:regret\} implies/);
  expect(text).toMatch(/\\begin\{cor\}\nAssume that the function[\s\S]*for all \$T\\geq1\$\.\\label\{cor:average\}\n\n\\\[\n\\frac\{R\(T\)\}\{T\}=O\\left\(\\frac\{1\}\{\\sqrt\{T\}\}\\right\)\n\\\]\n\\end\{cor\}/);
  has(r`$\lim_{T\to\infty}\frac{R(T)}{T}=0$`);
  // related work: description items with formulas
  expect(text).toMatch(new RegExp(`\\\\begin\\{description\\}\\n\\\\item \\[\\{RMSProp:\\}\\] An optimization method closely related to Adam is RMSProp \\\\citep?\\{${keys.tieleman2012}\\}\\.[\\s\\S]*section \\\\ref\\{sec:biasexp\\}\\.\\n\\\\item \\[\\{AdaGrad:\\}\\] An algorithm that works well for sparse gradients is AdaGrad \\\\citep?\\{${keys.duchi2011}\\}\\. Its basic version updates parameters as \\$`));
  has(r`$\theta_{t+1}=\theta_{t}-\alpha\cdot g_{t}/\sqrt{\sum_{i=1}^{t}g_{t}^{2}}$`);
  has(r`$\lim_{\beta_{2}\to1}\hat{v}_{t}=t^{-1}\cdot\sum_{i=1}^{t}g_{t}^{2}$`);
  expect(text).toMatch(/infinitely large parameter updates\.\n\\end\{description\}/);
  // figures
  for (const f of ['adam-logreg', 'adam-mlp', 'adam-cnn', 'adam-bias']) {
    expect(existsSync(`${DIR}/figures/${f}.png`)).toBe(true);
    expect(text).toContain(`\\includegraphics[width=1\\columnwidth]{figures/${f}.png}`);
  }
  expect(text).toMatch(/\\caption\{Logistic regression training negative log likelihood on MNIST images and IMDB movie reviews with 10,000 bag-of-words \(BoW\) feature vectors\.\}\\label\{fig:logreg\}/);
  expect(text).toMatch(new RegExp(`\\\\caption\\{Training of multilayer neural networks on MNIST images\\.[\\s\\S]*optimizer (?:\\\\protect)?\\\\citep?\\{${keys.sohl2014}\\}\\}\\\\label\\{fig:mlp\\}`));
  expect(text).toMatch(/\\caption\{Convolutional neural networks training cost\.[\s\S]*architecture\.\}\\label\{fig:cnn\}/);
  expect(text).toMatch(new RegExp(`\\\\caption\\{Effect of bias-correction terms[\\s\\S]*\\(VAE\\) (?:\\\\protect)?\\\\citep?\\{${keys.kingma2013}\\}, for different settings of stepsize \\$\\\\alpha\\$ \\(x-axes\\) and hyper-parameters \\$\\\\beta_\\{1\\}\\$ and \\$\\\\beta_\\{2\\}\\$\\.\\}\\\\label\\{fig:bias\\}`));
  expect(text).toMatch(/shown in Figure \\ref\{fig:cnn\} \(left\)[\s\S]*shown in Figure \\ref\{fig:cnn\} \(right\)/);
  // AdaMax
  has(r`\begin{align}v_{t} & =\beta_{2}^{p}v_{t-1}+(1-\beta_{2}^{p})|g_{t}|^{p}\\ & =(1-\beta_{2}^{p})\sum_{i=1}^{t}\beta_{2}^{p(t-i)}\cdot|g_{i}|^{p}\label{eq:vtp}\end{align}`);
  has(r`\begin{align}u_{t}=\lim_{p\to\infty}(v_{t})^{1/p} & =\lim_{p\to\infty}\left((1-\beta_{2}^{p})\sum_{i=1}^{t}\beta_{2}^{p(t-i)}\cdot|g_{i}|^{p}\right)^{1/p}\\ & =\lim_{p\to\infty}(1-\beta_{2}^{p})^{1/p}\left(\sum_{i=1}^{t}\beta_{2}^{p(t-i)}\cdot|g_{i}|^{p}\right)^{1/p}\\ & =\lim_{p\to\infty}\left(\sum_{i=1}^{t}\left(\beta_{2}^{(t-i)}\cdot|g_{i}|\right)^{p}\right)^{1/p}\\ & =\max\left(\beta_{2}^{t-1}|g_{1}|,\beta_{2}^{t-2}|g_{2}|,\ldots,\beta_{2}|g_{t-1}|,|g_{t}|\right)\label{eq:ut}\end{align}`);
  has(r`\begin{equation}u_{t}=\max(\beta_{2}\cdot u_{t-1},|g_{t}|)\label{eq:umax}\end{equation}`);
  has(r`$\bar{\theta}_{t}=\frac{1}{t}\sum_{k=1}^{n}\theta_{k}$`);
  has(r`$\hat{\theta}_{t}=\bar{\theta}_{t}/(1-\beta_{2}^{t})$`);
  expect(text).toMatch(/\\bibliographystyle\{plain\}\s*\\bibliography\{cited\}/);
  await expect(page.locator('.katex-error')).toHaveCount(0);
  expect(noErrors(errors)).toEqual([]);
  writeFileSync(`${DIR}/.complete`, 'adam');
});

/** The third session: the appendix with the convergence proof (Definition, Lemmas with proofs, the theorem again and its proof) after the bibliography — Document ▸ Start Appendix Here makes the headings lettered. */
test('writing "Adam", the appendix: the convergence proof', async ({ page }) => {
  test.skip(!existsSync(`${DIR}/.complete`), 'the main body was not typed');
  test.setTimeout(1200000);
  const errors = collectErrors(page);
  const keys: Record<string, string> = JSON.parse(readFileSync(KEYS_FILE, 'utf8'));
  const { T, M, P, section } = tools(page, keys);
  const D = (latex: string, opts: { numbered?: boolean; label?: string } = {}) => displayLatex(page, latex, opts);
  await openPaper(page, PROJECT, 'adam.tex');
  await expect(page.locator('.lyx-editor .lyx-command-bibtex')).toHaveCount(1, { timeout: 15000 });
  await page.locator('.lyx-editor > .lyx-par').last().click();
  await page.keyboard.press('Control+End');
  await P();
  await page.locator('.menubar .menu button', { hasText: 'Document' }).first().click();
  await page.locator('.menu-list .menu-item', { hasText: 'Start Appendix Here' }).click();
  await setLayout(page, '2');
  await T('Convergence proof');
  await insertLabel(page, 'sec:proof');
  await P();
  await selectLayout(page, 'Definition');
  await T('A function ');
  await M(r`f:\mathbb{R}^{d}\to\mathbb{R}`);
  await T(' is convex if for all ');
  await M(r`x,y\in\mathbb{R}^{d}`);
  await T(', for all ');
  await M(r`\lambda\in[0,1]`);
  await T(',');
  await D(r`\lambda f(x)+(1-\lambda)f(y)\geq f(\lambda x+(1-\lambda)y)`);
  await P();
  await setLayout(page, 's');
  await T('Also, notice that a convex function can be lower bounded by a hyperplane at its tangent.');
  await P();
  await selectLayout(page, 'Lemma');
  await T('If a function ');
  await M(r`f:\mathbb{R}^{d}\to\mathbb{R}`);
  await T(' is convex, then for all ');
  await M(r`x,y\in\mathbb{R}^{d}`);
  await T(',');
  await insertLabel(page, 'lem:convex');
  await D(r`f(y)\geq f(x)+\nabla f(x)^{T}(y-x)`);
  await P();
  await setLayout(page, 's');
  await T('The above lemma can be used to upper bound the regret and our proof for the main theorem is constructed by substituting the hyperplane with the Adam update rules.');
  await P();
  await T('The following two lemmas are used to support our main theorem. We also use some definitions simplify our notation, where ');
  await M(r`g_{t}\triangleq\nabla f_{t}(\theta_{t})`);
  await T(' and ');
  await M(r`g_{t,i}`);
  await T(' as the ');
  await M(r`i^{th}`);
  await T(' element. We define ');
  await M(r`g_{1:t,i}\in\mathbb{R}^{t}`);
  await T(' as a vector that contains the ');
  await M(r`i^{th}`);
  await T(' dimension of the gradients over all iterations till ');
  await M('t');
  await T(', ');
  await M(r`g_{1:t,i}=[g_{1,i},g_{2,i},\cdots,g_{t,i}]`);
  await P();
  await selectLayout(page, 'Lemma');
  await T('Let ');
  await M(r`g_{t}=\nabla f_{t}(\theta_{t})`);
  await T(' and ');
  await M(r`g_{1:t}`);
  await T(' be defined as above and bounded, ');
  await M(r`\Vert g_{t}\Vert_{2}\leq G`);
  await T(', ');
  await M(r`\Vert g_{t}\Vert_{\infty}\leq G_{\infty}`);
  await T('. Then,');
  await insertLabel(page, 'lem:sum');
  await D(r`\sum_{t=1}^{T}\sqrt{\frac{g_{t,i}^{2}}{t}}\leq2G_{\infty}\Vert g_{1:T,i}\Vert_{2}`);
  await P();
  await selectLayout(page, 'Proof');
  await T('We will prove the inequality using induction over T.');
  await P();
  await T('The base case for ');
  await M('T=1');
  await T(', we have ');
  await M(r`\sqrt{g_{1,i}^{2}}\leq2G_{\infty}\Vert g_{1,i}\Vert_{2}`);
  await T('.');
  await P();
  await T('For the inductive step,');
  await D(r`\sum_{t=1}^{T}\sqrt{\frac{g_{t,i}^{2}}{t}} & =\sum_{t=1}^{T-1}\sqrt{\frac{g_{t,i}^{2}}{t}}+\sqrt{\frac{g_{T,i}^{2}}{T}}\\ & \leq2G_{\infty}\Vert g_{1:T-1,i}\Vert_{2}+\sqrt{\frac{g_{T,i}^{2}}{T}}\\ & =2G_{\infty}\sqrt{\Vert g_{1:T,i}\Vert_{2}^{2}-g_{T}^{2}}+\sqrt{\frac{g_{T,i}^{2}}{T}}`);
  await P();
  await T('From, ');
  await M(r`\Vert g_{1:T,i}\Vert_{2}^{2}-g_{T,i}^{2}+\frac{g_{T,i}^{4}}{4\Vert g_{1:T,i}\Vert_{2}^{2}}\geq\Vert g_{1:T,i}\Vert_{2}^{2}-g_{T,i}^{2}`);
  await T(', we can take square root of both side and have,');
  await D(r`\sqrt{\Vert g_{1:T,i}\Vert_{2}^{2}-g_{T,i}^{2}} & \leq\Vert g_{1:T,i}\Vert_{2}-\frac{g_{T,i}^{2}}{2\Vert g_{1:T,i}\Vert_{2}}\\ & \leq\Vert g_{1:T,i}\Vert_{2}-\frac{g_{T,i}^{2}}{2\sqrt{TG_{\infty}^{2}}}`);
  await P();
  await T('Rearrange the inequality and substitute the ');
  await M(r`\sqrt{\Vert g_{1:T,i}\Vert_{2}^{2}-g_{T,i}^{2}}`);
  await T(' term,');
  await D(r`G_{\infty}\sqrt{\Vert g_{1:T,i}\Vert_{2}^{2}-g_{T}^{2}}+\sqrt{\frac{g_{T,i}^{2}}{T}}\leq2G_{\infty}\Vert g_{1:T,i}\Vert_{2}`);
  await P();
  await selectLayout(page, 'Lemma');
  await T('Let ');
  await M(r`\gamma\triangleq\frac{\beta_{1}^{2}}{\sqrt{\beta_{2}}}`);
  await T('. For ');
  await M(r`\beta_{1},\beta_{2}\in[0,1)`);
  await T(' that satisfy ');
  await M(r`\frac{\beta_{1}^{2}}{\sqrt{\beta_{2}}}<1`);
  await T(' and bounded ');
  await M(r`g_{t}`);
  await T(', ');
  await M(r`\Vert g_{t}\Vert_{2}\leq G`);
  await T(', ');
  await M(r`\Vert g_{t}\Vert_{\infty}\leq G_{\infty}`);
  await T(', the following inequality holds');
  await insertLabel(page, 'lem:mhat');
  await D(r`\sum_{t=1}^{T}\frac{\hat{m}_{t,i}^{2}}{\sqrt{t\hat{v}_{t,i}}}\leq\frac{2}{1-\gamma}\frac{1}{\sqrt{1-\beta_{2}}}\Vert g_{1:T,i}\Vert_{2}`);
  await P();
  await selectLayout(page, 'Proof');
  await T('Under the assumption, ');
  await M(r`\frac{\sqrt{1-\beta_{2}^{t}}}{(1-\beta_{1}^{t})^{2}}\leq\frac{1}{(1-\beta_{1})^{2}}`);
  await T('. We can expand the last term in the summation using the update rules in Algorithm ');
  await insertRef(page, 'alg:adam');
  await T(',');
  await D(r`\sum_{t=1}^{T}\frac{\hat{m}_{t,i}^{2}}{\sqrt{t\hat{v}_{t,i}}} & =\sum_{t=1}^{T-1}\frac{\hat{m}_{t,i}^{2}}{\sqrt{t\hat{v}_{t,i}}}+\frac{\sqrt{1-\beta_{2}^{T}}}{(1-\beta_{1}^{T})^{2}}\frac{(\sum_{k=1}^{T}(1-\beta_{1})\beta_{1}^{T-k}g_{k,i})^{2}}{\sqrt{T\sum_{j=1}^{T}(1-\beta_{2})\beta_{2}^{T-j}g_{j,i}^{2}}}\\ & \leq\sum_{t=1}^{T-1}\frac{\hat{m}_{t,i}^{2}}{\sqrt{t\hat{v}_{t,i}}}+\frac{\sqrt{1-\beta_{2}^{T}}}{(1-\beta_{1}^{T})^{2}}\sum_{k=1}^{T}\frac{T((1-\beta_{1})\beta_{1}^{T-k}g_{k,i})^{2}}{\sqrt{T\sum_{j=1}^{T}(1-\beta_{2})\beta_{2}^{T-j}g_{j,i}^{2}}}\\ & \leq\sum_{t=1}^{T-1}\frac{\hat{m}_{t,i}^{2}}{\sqrt{t\hat{v}_{t,i}}}+\frac{\sqrt{1-\beta_{2}^{T}}}{(1-\beta_{1}^{T})^{2}}\sum_{k=1}^{T}\frac{T((1-\beta_{1})\beta_{1}^{T-k}g_{k,i})^{2}}{\sqrt{T(1-\beta_{2})\beta_{2}^{T-k}g_{k,i}^{2}}}\\ & \leq\sum_{t=1}^{T-1}\frac{\hat{m}_{t,i}^{2}}{\sqrt{t\hat{v}_{t,i}}}+\frac{\sqrt{1-\beta_{2}^{T}}(1-\beta_{1})^{2}}{(1-\beta_{1}^{T})^{2}\sqrt{T(1-\beta_{2})}}\sum_{k=1}^{T}T\left(\frac{\beta_{1}^{2}}{\sqrt{\beta_{2}}}\right)^{T-k}\Vert g_{k,i}\Vert_{2}\\ & \leq\sum_{t=1}^{T-1}\frac{\hat{m}_{t,i}^{2}}{\sqrt{t\hat{v}_{t,i}}}+\frac{T}{\sqrt{T(1-\beta_{2})}}\sum_{k=1}^{T}\gamma^{T-k}\Vert g_{k,i}\Vert_{2}`);
  await P();
  await T('Similarly, we can upper bound the rest of the terms in the summation.');
  await D(r`\sum_{t=1}^{T}\frac{\hat{m}_{t,i}^{2}}{\sqrt{t\hat{v}_{t,i}}} & \leq\sum_{t=1}^{T}\frac{\Vert g_{t,i}\Vert_{2}}{\sqrt{t(1-\beta_{2})}}\sum_{j=0}^{T-t}t\gamma^{j}\\ & \leq\sum_{t=1}^{T}\frac{\Vert g_{t,i}\Vert_{2}}{\sqrt{t(1-\beta_{2})}}\sum_{j=0}^{T}t\gamma^{j}`);
  await P();
  await T('For ');
  await M(r`\gamma<1`);
  await T(', using the upper bound on the arithmetic-geometric series, ');
  await M(r`\sum_{t}t\gamma^{t}<\frac{1}{(1-\gamma)^{2}}`);
  await T(':');
  await D(r`\sum_{t=1}^{T}\frac{\Vert g_{t,i}\Vert_{2}}{\sqrt{t(1-\beta_{2})}}\sum_{j=0}^{T}t\gamma^{j}\leq\frac{1}{(1-\gamma)^{2}\sqrt{1-\beta_{2}}}\sum_{t=1}^{T}\frac{\Vert g_{t,i}\Vert_{2}}{\sqrt{t}}`);
  await P();
  await T('Apply Lemma ');
  await insertRef(page, 'lem:sum');
  await T(',');
  await D(r`\sum_{t=1}^{T}\frac{\hat{m}_{t,i}^{2}}{\sqrt{t\hat{v}_{t,i}}}\leq\frac{2G_{\infty}}{(1-\gamma)^{2}\sqrt{1-\beta_{2}}}\Vert g_{1:T,i}\Vert_{2}`);
  await P();
  await setLayout(page, 's');
  await T('To simplify the notation, we define ');
  await M(r`\gamma\triangleq\frac{\beta_{1}^{2}}{\sqrt{\beta_{2}}}`);
  await T('. Intuitively, our following theorem holds when the learning rate ');
  await M(r`\alpha_{t}`);
  await T(' is decaying at a rate of ');
  await M(r`t^{-\frac{1}{2}}`);
  await T(' and first moment running average coefficient ');
  await M(r`\beta_{1,t}`);
  await T(' decay exponentially with ');
  await M(r`\lambda`);
  await T(', that is typically close to 1, e.g. ');
  await M(r`1-10^{-8}`);
  await T('.');
  await P();
  await selectLayout(page, 'Theorem');
  await T('Assume that the function ');
  await M(r`f_{t}`);
  await T(' has bounded gradients, ');
  await M(r`\Vert\nabla f_{t}(\theta)\Vert_{2}\leq G`);
  await T(', ');
  await M(r`\Vert\nabla f_{t}(\theta)\Vert_{\infty}\leq G_{\infty}`);
  await T(' for all ');
  await M(r`\theta\in\mathbb{R}^{d}`);
  await T(' and distance between any ');
  await M(r`\theta_{t}`);
  await T(' generated by Adam is bounded, ');
  await M(r`\Vert\theta_{n}-\theta_{m}\Vert_{2}\leq D`);
  await T(', ');
  await M(r`\Vert\theta_{m}-\theta_{n}\Vert_{\infty}\leq D_{\infty}`);
  await T(' for any ');
  await M(r`m,n\in\lbrace1,\ldots,T\rbrace`);
  await T(', and ');
  await M(r`\beta_{1},\beta_{2}\in[0,1)`);
  await T(' satisfy ');
  await M(r`\frac{\beta_{1}^{2}}{\sqrt{\beta_{2}}}<1`);
  await T('. Let ');
  await M(r`\alpha_{t}=\frac{\alpha}{\sqrt{t}}`);
  await T(' and ');
  await M(r`\beta_{1,t}=\beta_{1}\lambda^{t-1},\lambda\in(0,1)`);
  await T('. Adam achieves the following guarantee, for all ');
  await M(r`T\geq1`);
  await T('.');
  await insertLabel(page, 'thm:proof');
  await D(r`R(T)\leq\frac{D^{2}}{2\alpha(1-\beta_{1})}\sum_{i=1}^{d}\sqrt{T\hat{v}_{T,i}}+\frac{\alpha(\beta_{1}+1)G_{\infty}}{(1-\beta_{1})\sqrt{1-\beta_{2}}(1-\gamma)^{2}}\sum_{i=1}^{d}\Vert g_{1:T,i}\Vert_{2}+\sum_{i=1}^{d}\frac{D_{\infty}^{2}G_{\infty}\sqrt{1-\beta_{2}}}{2\alpha(1-\beta_{1})(1-\lambda)^{2}}`);
  await P();
  await selectLayout(page, 'Proof');
  await T('Using Lemma ');
  await insertRef(page, 'lem:convex');
  await T(', we have,');
  await D(r`f_{t}(\theta_{t})-f_{t}(\theta^{*})\leq g_{t}^{T}(\theta_{t}-\theta^{*})=\sum_{i=1}^{d}g_{t,i}(\theta_{t,i}-\theta_{,i}^{*})`);
  await P();
  await T('From the update rules presented in algorithm ');
  await insertRef(page, 'alg:adam');
  await T(',');
  await D(r`\theta_{t+1} & =\theta_{t}-\alpha_{t}\hat{m}_{t}/\sqrt{\hat{v}_{t}}\\ & =\theta_{t}-\frac{\alpha_{t}}{1-\beta_{1}^{t}}\left(\frac{\beta_{1,t}}{\sqrt{\hat{v}_{t}}}m_{t-1}+\frac{(1-\beta_{1,t})}{\sqrt{\hat{v}_{t}}}g_{t}\right)`);
  await P();
  await T('We focus on the ');
  await M(r`i^{th}`);
  await T(' dimension of the parameter vector ');
  await M(r`\theta_{t}\in\mathbb{R}^{d}`);
  await T('. Subtract the scalar ');
  await M(r`\theta_{,i}^{*}`);
  await T(' and square both sides of the above update rule, we have,');
  await D(r`(\theta_{t+1,i}-\theta_{,i}^{*})^{2}=(\theta_{t,i}-\theta_{,i}^{*})^{2}-\frac{2\alpha_{t}}{1-\beta_{1}^{t}}\left(\frac{\beta_{1,t}}{\sqrt{\hat{v}_{t,i}}}m_{t-1,i}+\frac{(1-\beta_{1,t})}{\sqrt{\hat{v}_{t,i}}}g_{t,i}\right)(\theta_{t,i}-\theta_{,i}^{*})+\alpha_{t}^{2}\left(\frac{\hat{m}_{t,i}}{\sqrt{\hat{v}_{t,i}}}\right)^{2}`);
  await P();
  await T("We can rearrange the above equation and use Young's inequality, ");
  await M(r`ab\leq a^{2}/2+b^{2}/2`);
  await T('. Also, it can be shown that ');
  await M(r`\sqrt{\hat{v}_{t,i}}=\sqrt{\sum_{j=1}^{t}(1-\beta_{2})\beta_{2}^{t-j}g_{j,i}^{2}}/\sqrt{1-\beta_{2}^{t}}\leq\Vert g_{1:t,i}\Vert_{2}`);
  await T(' and ');
  await M(r`\beta_{1,t}\leq\beta_{1}`);
  await T('. Then');
  await D(r`g_{t,i}(\theta_{t,i}-\theta_{,i}^{*}) & =\frac{(1-\beta_{1}^{t})\sqrt{\hat{v}_{t,i}}}{2\alpha_{t}(1-\beta_{1,t})}\left((\theta_{t,i}-\theta_{,i}^{*})^{2}-(\theta_{t+1,i}-\theta_{,i}^{*})^{2}\right)+\frac{\beta_{1,t}}{(1-\beta_{1,t})}\frac{\hat{v}_{t-1,i}^{\frac{1}{4}}}{\sqrt{\alpha_{t-1}}}(\theta_{,i}^{*}-\theta_{t,i})\sqrt{\alpha_{t-1}}\frac{m_{t-1,i}}{\hat{v}_{t-1,i}^{\frac{1}{4}}}+\frac{\alpha_{t}(1-\beta_{1}^{t})\sqrt{\hat{v}_{t,i}}}{2(1-\beta_{1,t})}\left(\frac{\hat{m}_{t,i}}{\sqrt{\hat{v}_{t,i}}}\right)^{2}\\ & \leq\frac{1}{2\alpha_{t}(1-\beta_{1})}\left((\theta_{t,i}-\theta_{,i}^{*})^{2}-(\theta_{t+1,i}-\theta_{,i}^{*})^{2}\right)\sqrt{\hat{v}_{t,i}}+\frac{\beta_{1,t}}{2\alpha_{t-1}(1-\beta_{1,t})}(\theta_{,i}^{*}-\theta_{t,i})^{2}\sqrt{\hat{v}_{t-1,i}}+\frac{\beta_{1}\alpha_{t-1}m_{t-1,i}^{2}}{2(1-\beta_{1})\sqrt{\hat{v}_{t-1,i}}}+\frac{\alpha_{t}\hat{m}_{t,i}^{2}}{2(1-\beta_{1})\sqrt{\hat{v}_{t,i}}}`);
  await P();
  await T('We apply Lemma ');
  await insertRef(page, 'lem:mhat');
  await T(' to the above inequality and derive the regret bound by summing across all the dimensions for ');
  await M(r`i\in1,\ldots,d`);
  await T(' in the upper bound of ');
  await M(r`f_{t}(\theta_{t})-f_{t}(\theta^{*})`);
  await T(' and the sequence of convex functions for ');
  await M(r`t\in1,\ldots,T`);
  await T(':');
  await D(r`R(T) & \leq\sum_{i=1}^{d}\frac{1}{2\alpha_{1}(1-\beta_{1})}(\theta_{1,i}-\theta_{,i}^{*})^{2}\sqrt{\hat{v}_{1,i}}+\sum_{i=1}^{d}\sum_{t=2}^{T}\frac{1}{2(1-\beta_{1})}(\theta_{t,i}-\theta_{,i}^{*})^{2}\left(\frac{\sqrt{\hat{v}_{t,i}}}{\alpha_{t}}-\frac{\sqrt{\hat{v}_{t-1,i}}}{\alpha_{t-1}}\right)\\ & +\frac{\beta_{1}\alpha G_{\infty}}{(1-\beta_{1})\sqrt{1-\beta_{2}}(1-\gamma)^{2}}\sum_{i=1}^{d}\Vert g_{1:T,i}\Vert_{2}+\frac{\alpha G_{\infty}}{(1-\beta_{1})\sqrt{1-\beta_{2}}(1-\gamma)^{2}}\sum_{i=1}^{d}\Vert g_{1:T,i}\Vert_{2}\\ & +\sum_{i=1}^{d}\sum_{t=1}^{T}\frac{\beta_{1,t}}{2\alpha_{t}(1-\beta_{1,t})}(\theta_{,i}^{*}-\theta_{t,i})^{2}\sqrt{\hat{v}_{t,i}}`);
  await P();
  await T('From the assumption, ');
  await M(r`\Vert\theta_{t}-\theta^{*}\Vert_{2}\leq D`);
  await T(', ');
  await M(r`\Vert\theta_{m}-\theta_{n}\Vert_{\infty}\leq D_{\infty}`);
  await T(', we have:');
  await D(r`R(T) & \leq\frac{D^{2}}{2\alpha(1-\beta_{1})}\sum_{i=1}^{d}\sqrt{T\hat{v}_{T,i}}+\frac{\alpha(1+\beta_{1})G_{\infty}}{(1-\beta_{1})\sqrt{1-\beta_{2}}(1-\gamma)^{2}}\sum_{i=1}^{d}\Vert g_{1:T,i}\Vert_{2}+\frac{D_{\infty}^{2}}{2\alpha}\sum_{i=1}^{d}\sum_{t=1}^{T}\frac{\beta_{1,t}}{(1-\beta_{1,t})}\sqrt{t\hat{v}_{t,i}}\\ & \leq\frac{D^{2}}{2\alpha(1-\beta_{1})}\sum_{i=1}^{d}\sqrt{T\hat{v}_{T,i}}+\frac{\alpha(1+\beta_{1})G_{\infty}}{(1-\beta_{1})\sqrt{1-\beta_{2}}(1-\gamma)^{2}}\sum_{i=1}^{d}\Vert g_{1:T,i}\Vert_{2}+\frac{D_{\infty}^{2}G_{\infty}\sqrt{1-\beta_{2}}}{2\alpha}\sum_{i=1}^{d}\sum_{t=1}^{T}\frac{\beta_{1,t}}{(1-\beta_{1,t})}\sqrt{t}`);
  await P();
  await T('We can use arithmetic geometric series upper bound for the last term:');
  await D(r`\sum_{t=1}^{T}\frac{\beta_{1,t}}{(1-\beta_{1,t})}\sqrt{t} & \leq\sum_{t=1}^{T}\frac{1}{(1-\beta_{1})}\lambda^{t-1}\sqrt{t}\\ & \leq\frac{1}{(1-\beta_{1})(1-\lambda)^{2}}`);
  await P();
  await T('Therefore, we have the following regret bound:');
  await D(r`R(T)\leq\frac{D^{2}}{2\alpha(1-\beta_{1})}\sum_{i=1}^{d}\sqrt{T\hat{v}_{T,i}}+\frac{\alpha(1+\beta_{1})G_{\infty}}{(1-\beta_{1})\sqrt{1-\beta_{2}}(1-\gamma)^{2}}\sum_{i=1}^{d}\Vert g_{1:T,i}\Vert_{2}+\sum_{i=1}^{d}\frac{D_{\infty}^{2}G_{\infty}\sqrt{1-\beta_{2}}}{2\alpha(1-\beta_{1})(1-\lambda)^{2}}`);

  await expect.poll(() => fileText().includes('(1-\\lambda)^{2}}\n\\]\n\\end{proof}'), { timeout: 20000 }).toBe(true);
  await page.waitForTimeout(2500);
  const text = fileText();
  const c = canonMath(text);
  const has = (latex: string) => expect(c, `expected the formula ${latex}`).toContain(canonMath(latex));
  expect(text).toMatch(/\\bibliography\{cited\}\n+\\appendix\n+\\section\{Convergence proof\}\\label\{sec:proof\}\n+\\begin\{defn\}\nA function \$f:\\mathbb\{R\}\^\{d\}\\to\\mathbb\{R\}\$ is convex/);
  expect((text.match(/\\appendix/g) ?? []).length).toBe(1);   // one marker, not one per paragraph
  expect(text).toMatch(/\\begin\{lem\}\nIf a function[\s\S]*\\label\{lem:convex\}\n\n\\\[\nf\(y\)\\geq f\(x\)\+\\nabla f\(x\)\^\{T\}\(y-x\)\n\\\]\n\\end\{lem\}/);
  expect(text).toMatch(/\\begin\{lem\}\nLet \$g_\{t\}=\\nabla f_\{t\}\(\\theta_\{t\}\)\$[\s\S]*\\label\{lem:sum\}\n\n\\\[/);
  has(r`\[\sum_{t=1}^{T}\sqrt{\frac{g_{t,i}^{2}}{t}}\leq2G_{\infty}\Vert g_{1:T,i}\Vert_{2}\]`);
  expect(text).toMatch(/\\begin\{proof\}\nWe will prove the inequality using induction over T\.\n\nThe base case for \$T=1\$/);
  has(r`\begin{align}\sum_{t=1}^{T}\sqrt{\frac{g_{t,i}^{2}}{t}} & =\sum_{t=1}^{T-1}\sqrt{\frac{g_{t,i}^{2}}{t}}+\sqrt{\frac{g_{T,i}^{2}}{T}}\\ & \leq2G_{\infty}\Vert g_{1:T-1,i}\Vert_{2}+\sqrt{\frac{g_{T,i}^{2}}{T}}\\ & =2G_{\infty}\sqrt{\Vert g_{1:T,i}\Vert_{2}^{2}-g_{T}^{2}}+\sqrt{\frac{g_{T,i}^{2}}{T}}\end{align}`);
  expect(text).toMatch(/\\begin\{lem\}\nLet \$\\gamma\\triangleq\\frac\{\\beta(?:_\{1\}\^\{2\}|\^\{2\}_\{1\})\}\{\\sqrt\{\\beta_\{2\}\}\}\$\. For[\s\S]*\\label\{lem:mhat\}/);
  has(r`\[\sum_{t=1}^{T}\frac{\hat{m}_{t,i}^{2}}{\sqrt{t\hat{v}_{t,i}}}\leq\frac{2}{1-\gamma}\frac{1}{\sqrt{1-\beta_{2}}}\Vert g_{1:T,i}\Vert_{2}\]`);
  expect(text).toMatch(/using the update rules in Algorithm \\ref\{alg:adam\},/);
  has(r`& \leq\sum_{t=1}^{T-1}\frac{\hat{m}_{t,i}^{2}}{\sqrt{t\hat{v}_{t,i}}}+\frac{T}{\sqrt{T(1-\beta_{2})}}\sum_{k=1}^{T}\gamma^{T-k}\Vert g_{k,i}\Vert_{2}\end{align}`);
  expect((text.match(/\\begin\{align\}/g) ?? []).length).toBeGreaterThanOrEqual(12);   // 5 in the body, 7 in the appendix
  expect(text).toMatch(/Apply Lemma \\ref\{lem:sum\},/);
  expect(text).toMatch(/\\begin\{thm\}\nAssume that the function[\s\S]*\\label\{thm:proof\}\n\n\\\[\nR\(T\)\\leq/);
  expect(text).toMatch(/\\begin\{proof\}\nUsing Lemma \\ref\{lem:convex\}, we have,/);
  has(r`\[f_{t}(\theta_{t})-f_{t}(\theta^{*})\leq g_{t}^{T}(\theta_{t}-\theta^{*})=\sum_{i=1}^{d}g_{t,i}(\theta_{t,i}-\theta_{,i}^{*})\]`);
  has(r`\hat{v}_{t-1,i}^{\frac{1}{4}}`);
  expect(text).toMatch(/We apply Lemma \\ref\{lem:mhat\} to the above inequality/);
  has(r`\begin{align}\sum_{t=1}^{T}\frac{\beta_{1,t}}{(1-\beta_{1,t})}\sqrt{t} & \leq\sum_{t=1}^{T}\frac{1}{(1-\beta_{1})}\lambda^{t-1}\sqrt{t}\\ & \leq\frac{1}{(1-\beta_{1})(1-\lambda)^{2}}\end{align}`);
  expect(text).toMatch(/Therefore, we have the following regret bound:\n\n\\\[\nR\(T\)\\leq[\s\S]*\n\\\]\n\\end\{proof\}\n\n\\end\{document\}/);
  expect((text.match(/\\begin\{lem\}/g) ?? []).length).toBe(3);
  expect((text.match(/\\begin\{proof\}/g) ?? []).length).toBe(3);
  await expect(page.locator('.katex-error')).toHaveCount(0);
  expect(noErrors(errors)).toEqual([]);
  writeFileSync(`${DIR}/.appendix`, 'adam');
});

test('the Adam paper survives a reload byte-identically and its PDF has the theorem, the numbered aligns, both algorithms, four figures and the references', async ({ page }) => {
  test.skip(!existsSync(`${DIR}/.complete`) || !existsSync(`${DIR}/.appendix`), 'the paper was not typed completely');
  test.setTimeout(600000);
  const errors = collectErrors(page);
  await openPaper(page, PROJECT, 'adam.tex');
  await expect(page.locator('.lyx-editor .lyx-command-citation').first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.lyx-editor .lyx-inset-float')).toHaveCount(6);   // 4 figures, 2 algorithms
  await expect(page.locator('.lyx-editor .lyx-par[data-label="Theorem 1."]')).toHaveCount(1);
  await expect(page.locator('.lyx-editor .lyx-par[data-label="Corollary 2."]')).toHaveCount(1);   // theorems-ams: one counter for all theorem-like environments
  await expect(page.locator('.lyx-editor .lyx-par[data-label="Definition 3."]')).toHaveCount(1);
  await expect(page.locator('.lyx-editor .lyx-par[data-label="Lemma 6."]')).toHaveCount(1);
  await expect(page.locator('.lyx-editor .lyx-par[data-label="Theorem 7."]')).toHaveCount(1);
  await expect(page.locator('.lyx-editor .lyx-par[data-label="Proof."]')).toHaveCount(3);
  const before = fileText();
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 0, null, { timeout: 30000 });
  await page.waitForTimeout(2500);
  expect(fileText()).toBe(before);
  if (await page.locator('.outline-text').count() === 0) await page.keyboard.press('Control+Alt+o');
  await expect(page.locator('.outline-text')).toHaveCount(18 + 6, { timeout: 5000 });   // the headings (the appendix's included) and the six floats
  const outline = (await page.locator('.outline-text').allInnerTexts()).filter(t => !/^(figure|table|algorithm):/.test(t.trim()));
  expect(outline).toHaveLength(18);
  const headings = ['Adam: A Method for Stochastic Optimization', 'Introduction', 'Algorithm', "Adam's update rule", 'Initialization bias correction', 'Convergence analysis', 'Related work', 'Experiments',
    'Experiment: Logistic Regression', 'Experiment: Multi-layer Neural Networks', 'Experiment: Convolutional Neural Networks', 'Experiment: bias-correction term', 'Extensions', 'AdaMax', 'Temporal averaging', 'Conclusion', 'Acknowledgments', 'Convergence proof'];
  headings.forEach((h, i) => expect(outline[i]).toContain(h));
  expect(outline[17]).toMatch(/^\s*A\s*Convergence proof/);   // lettered after \appendix

  await page.locator('.tb-btn[title^="View PDF"]').click();
  await expect(page.locator('.pdf-panel .build-progress')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.pdf-panel .build-progress')).toHaveCount(0, { timeout: 400000 });
  await expect(page.locator('.pdf-panel .bar span')).toContainText('built');
  const res = await page.request.get(`/api/docs/${encodeURIComponent(`${PROJECT}/adam.tex`)}/pdf`);
  expect(res.ok()).toBe(true);
  const pdf = `${TMP}/e2e-adam-full.pdf`;
  writeFileSync(pdf, await res.body());
  const pdfText = execFileSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8' }).replace(/\s+/g, ' ');
  expect(pdfText).toContain('Adam: A Method for Stochastic Optimization');
  for (const s of ['1 Introduction', '2 Algorithm', '2.1 Adam\u2019s update rule', '3 Initialization bias correction', '4 Convergence analysis', '5 Related work', '6 Experiments', '6.1 Experiment: Logistic Regression',
    '6.4 Experiment: bias-correction term', '7 Extensions', '7.1 AdaMax', '7.2 Temporal averaging', '8 Conclusion', 'Acknowledgments', 'References']) expect(pdfText).toContain(s);
  // equation numbers: (1)-(5) the update rules align, (6) v_t, (7)-(9) the expectation align, (10) the regret, (11)-(12) v_t^p, (13)-(16) u_t, (17) the recursion
  expect(pdfText).toMatch(/sides of eq\. \(6\):/);
  expect(pdfText).toMatch(/Theorem 1\. Assume that the function ft has bounded gradients/);
  expect(pdfText).toMatch(/Our Theorem 1 implies/);
  expect(pdfText).toMatch(/Corollary 2\. Assume that the function/);
  expect(pdfText).toMatch(/obtained by using Theorem 1 and/);
  expect(pdfText).toMatch(/Algorithm 1 Adam, our proposed algorithm for stochastic optimization\. See section 2 for details/);
  expect(pdfText).toMatch(/Algorithm 2 AdaMax, a variant of Adam based on the infinity norm\. See section 7\.1 for details/);
  expect(pdfText).toMatch(/See algorithm 1 for pseudo-code/);
  expect(pdfText).toMatch(/see algorithm 2\. We/);
  expect(pdfText).toMatch(/clarified in section 5\./);
  expect(pdfText).toMatch(/In section 2 we describe the algorithm.*Section 3 explains.*tion 4 provides.*shown in section 6\./);   // "sec- tion" may be hyphenated
  expect(pdfText).toMatch(/demonstrate in section 6\.4\./);
  expect(pdfText).toMatch(/According to Figure 1, we found/);
  expect(pdfText).toMatch(/shown in Figure 3 \(left\)/);
  expect(pdfText).toMatch(/In Figure 4, values/);
  for (const s of ['Figure 1: Logistic regression training', 'Figure 2: Training of multilayer neural networks', 'Figure 3: Convolutional neural networks training cost', 'Figure 4: Effect of bias-correction terms']) expect(pdfText).toContain(s);
  expect(pdfText).toMatch(/RMSProp: An optimization method closely related to Adam/);
  expect(pdfText).toMatch(/AdaGrad: An algorithm that works well for sparse gradients/);
  expect(pdfText).toMatch(/deep learning \[\d+, \d+, \d+, \d+, \d+\]\. Objectives/);
  expect(pdfText).toMatch(/References.*\[1\].*\[23\]/);
  // the appendix: a lettered section after the references, the numbered environments continue the theorem counter
  expect(pdfText).toMatch(/\[23\].*A Convergence proof/);
  expect(pdfText).toMatch(/Definition 3\. A function f : Rd → R is convex/);
  expect(pdfText).toMatch(/Lemma 4\. If a function f : Rd → R is convex/);
  expect(pdfText).toMatch(/Lemma 5\. Let gt = ∇ft \(θt \)/);
  expect(pdfText).toMatch(/Proof\. We will prove the inequality using(?: q)? induction over T\./);   // -layout may drop a √ glyph into the line
  expect(pdfText).toMatch(/Lemma 6\. Let γ/);
  expect(pdfText).toMatch(/using the update rules in Algorithm 1,/);
  expect(pdfText).toMatch(/Apply Lemma 5,/);
  expect(pdfText).toMatch(/Theorem 7\. Assume that the function ft has bounded gradients/);
  expect(pdfText).toMatch(/Proof\. Using Lemma 4, we have,/);
  expect(pdfText).toMatch(/We apply Lemma 6 to the above inequality/);
  expect(pdfText).toMatch(/Therefore, we have the following regret bound:/);
  expect(pdfText).toMatch(/Adaptive subgradient methods for online learning and stochastic optimization/i);
  expect(noErrors(errors)).toEqual([]);
});
