# Fira Math

`FiraMath-Regular.otf` is the unmodified OpenType math font from [Fira Math](https://github.com/firamath/firamath), version 0.3.4 (also in TeX Live as `firamath`), a sans-serif math font built on Fira Sans. The editor's sans-serif face takes the formula symbols its text font lacks from it.

Copyright 2018–2020 Xiangdong Zeng. See the [SIL Open Font License](../../../public/licenses/firamath-OFL.txt), which ships with both the web client and the VS Code extension.

Fira Math is not on Google Fonts, so the CSS imports it through Vite like the Computer Modern faces; the browser fetches it only when a formula needs it.
