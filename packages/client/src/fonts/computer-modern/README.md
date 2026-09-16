# Computer Modern text fonts

These are the unmodified OpenType CMU Serif faces from [Computer Modern Unicode](https://ctan.org/pkg/cm-unicode), version 0.7.0:

- `cmunrm.otf`: Roman
- `cmunbx.otf`: Bold
- `cmunti.otf`: Italic
- `cmunbi.otf`: Bold italic

Copyright belongs to the original Metafont authors and Andrey V. Panov. See the [SIL Open Font License and copyright notices](../../../public/licenses/cm-unicode-OFL.txt), which ship with both the web client and the VS Code extension.

The CSS imports these files through Vite, so live development and packaged webviews load the same fonts without a local font installation. KaTeX supplies its own Computer Modern math faces.
