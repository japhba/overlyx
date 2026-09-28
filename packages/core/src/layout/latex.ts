/**
 * The LaTeX side of layout documents: the small macro package the managed block defines when a
 * document has layout pages (TikZ overlay pictures anchored at the page corner, adjustbox for
 * cropped images, beamer's \only for animation steps), and what a page and its objects are
 * written as. Everything is defined in the file itself, so it compiles anywhere (Overleaf, latexmk)
 * without OverLyX.
 *
 *   \begin{frame}[plain]
 *   \olpage{fill=paleblue,transition=fade}
 *   \begin{olbox}{x=20mm,y=30mm,w=100mm,h=40mm,fill=white,draw=jblue,line=1pt,radius=3mm,pad=4mm,font=25pt}
 *   Text with $\int_0^1 f$, lists, … (LyX content)
 *   \end{olbox}
 *   \olshape{x=10mm,y=90mm,w=40mm,h=30mm,vb=0 0 100 100,fill=red!20,draw=red}{M 0 0 L 100 0 L 50 100 Z}
 *   \olimage{x=60mm,y=90mm,w=40mm,h=30mm,crop=0.1 0 0 0.2,step=2-}{figures/plot.pdf}
 *   \note{Speaker notes}
 *   \end{frame}
 */

/** Requirements of the macro package (loaded in the managed block when the document has layout pages). */
export const LAYOUT_PACKAGES = ['tikz', 'adjustbox'];

/** The macro definitions (inside \makeatletter … \makeatother). */
export const LAYOUT_MACROS = String.raw`% OverLyX layout objects: positioned on the page from its top left corner (x, y, w, h;
% rotate: degrees about the centre), shown on the beamer overlay steps given by step=
\usetikzlibrary{svg.path,arrows.meta}
\pgfqkeys{/ol}{x/.store in=\ol@x,y/.store in=\ol@y,w/.store in=\ol@w,h/.store in=\ol@h,rotate/.store in=\ol@rot,
  fill/.code={\ol@setcolor\ol@fill{#1}},draw/.code={\ol@setcolor\ol@draw{#1}},color/.code={\ol@setcolor\ol@color{#1}},
  line/.store in=\ol@line,radius/.store in=\ol@radius,pad/.store in=\ol@pad,valign/.store in=\ol@valign,shape/.store in=\ol@shape,
  font/.store in=\ol@font,leading/.store in=\ol@leading,opacity/.store in=\ol@opacity,step/.store in=\ol@step,align/.store in=\ol@align,
  vb/.store in=\ol@vb,crop/.store in=\ol@crop,dash/.store in=\ol@dash,arrows/.store in=\ol@arrows,
  transition/.store in=\ol@trans,.unknown/.code={}}
\def\ol@reset{\def\ol@x{0mm}\def\ol@y{0mm}\def\ol@w{10mm}\def\ol@h{10mm}\def\ol@rot{0}\def\ol@fill{}\def\ol@draw{}\def\ol@color{}%
  \def\ol@line{0.4pt}\def\ol@radius{0pt}\def\ol@pad{0pt}\def\ol@valign{t}\def\ol@shape{rect}\def\ol@font{}\def\ol@leading{1.2}%
  \def\ol@opacity{1}\def\ol@step{}\def\ol@align{left}\def\ol@vb{0 0 1 1}\def\ol@crop{0 0 0 0}\def\ol@dash{}\def\ol@arrows{}\def\ol@trans{}}
\def\ol@setcolor#1#2{\def#1{}\if\relax\detokenize{#2}\relax\else\ol@@setcolor#1#2\relax\fi}
\def\ol@@setcolor#1#2#3\relax{\ifx[#2\ol@@@setcolor#1[#3\relax\else\def#1{#2#3}\fi}
\def\ol@@@setcolor#1[#2]#3\relax{\definecolor{ol\expandafter\@gobble\string#1}{#2}{#3}\edef#1{ol\expandafter\@gobble\string#1}}
\def\ol@style{\tikzset{ol@frame/.style={}}%
  \ifx\ol@fill\empty\else\tikzset{ol@frame/.append style/.expanded={fill=\ol@fill}}\fi
  \ifx\ol@draw\empty\else\tikzset{ol@frame/.append style/.expanded={draw=\ol@draw,line width=\ol@line}}\fi
  \ifx\ol@dash\empty\else\tikzset{ol@frame/.append style/.expanded={\ol@dash}}\fi
  \ifx\ol@arrows\empty\else\tikzset{ol@frame/.append style/.expanded={\ol@arrows}}\fi}
\def\ol@only#1{\only<#1>}
\def\ol@place#1{\ifx\ol@step\empty#1\else\edef\ol@tmp{\noexpand\ol@only{\ol@step}}\ol@tmp{#1}\fi\ignorespaces}
\def\ol@at{\path ([xshift=\ol@x+\ol@w/2,yshift=-\ol@y-\ol@h/2]current page.north west) coordinate (ol@c);}
\newsavebox\ol@box
\def\ol@boxbegin{\pgfmathsetlengthmacro\ol@iw{\ol@w-2*(\ol@pad)}\pgfmathsetlengthmacro\ol@ih{\ol@h-2*(\ol@pad)}%
  \begin{lrbox}{\ol@box}\begin{minipage}[c][\ol@ih][\ol@valign]{\ol@iw}}
\def\ol@boxdraw{\leavevmode\begin{tikzpicture}[remember picture,overlay]\ol@at
  \begin{scope}[shift={(ol@c)},rotate=\ol@rot,opacity=\ol@opacity]
  \def\ol@tmp{ellipse}\ifx\ol@shape\ol@tmp\path[ol@frame] (0,0) ellipse [x radius=\ol@w/2,y radius=\ol@h/2];%
  \else\path[ol@frame,rounded corners=\ol@radius] (-\ol@w/2,-\ol@h/2) rectangle (\ol@w/2,\ol@h/2);\fi
  \node[anchor=center,inner sep=0pt,outer sep=0pt,transform shape] at (0,0) {\usebox\ol@box};
  \end{scope}\end{tikzpicture}}
\newenvironment{olbox}[1]{\ol@reset\pgfqkeys{/ol}{#1}\ol@boxbegin
  \ifx\ol@font\empty\else\pgfmathsetlengthmacro\ol@lead{\ol@leading*(\ol@font)}\fontsize{\ol@font}{\ol@lead}\selectfont\fi
  \ifx\ol@color\empty\else\color{\ol@color}\fi\csname ol@align@\ol@align\endcsname\ignorespaces}%
  {\par\end{minipage}\end{lrbox}\ol@style\ol@place{\ol@boxdraw}}
\def\ol@align@left{\raggedright}\def\ol@align@center{\centering}\def\ol@align@right{\raggedleft}\def\ol@align@justify{}
\newenvironment{olraw}[1]{\ol@reset\pgfqkeys{/ol}{#1}\ol@boxbegin\ignorespaces}%
  {\par\end{minipage}\end{lrbox}\ol@style\ol@place{\ol@boxdraw}}
\newcommand\olshape[2]{\ol@reset\pgfqkeys{/ol}{#1}\ol@style\expandafter\ol@parsevb\ol@vb\relax
  \pgfmathsetmacro\ol@sx{(\ol@w)/\ol@vbw}\pgfmathsetmacro\ol@sy{(\ol@h)/\ol@vbh}\ol@place{\ol@shapedraw{#2}}}
\def\ol@parsevb#1 #2 #3 #4\relax{\def\ol@vbx{#1}\def\ol@vby{#2}\def\ol@vbw{#3}\def\ol@vbh{#4}}
\def\ol@shapedraw#1{\leavevmode\begin{tikzpicture}[remember picture,overlay]\ol@at
  \begin{scope}[shift={(ol@c)},rotate=\ol@rot,shift={(-\ol@w/2,\ol@h/2)},xscale=\ol@sx,yscale=-\ol@sy,shift={(-\ol@vbx pt,-\ol@vby pt)}]
  \path[ol@frame,opacity=\ol@opacity] svg {#1};\end{scope}\end{tikzpicture}}
\newcommand\olimage[2]{\ol@reset\pgfqkeys{/ol}{#1}\expandafter\ol@parsecrop\ol@crop\relax\ol@place{\ol@imagedraw{#2}}}
\def\ol@parsecrop#1 #2 #3 #4\relax{\def\ol@cl{#1}\def\ol@ct{#2}\def\ol@cr{#3}\def\ol@cb{#4}}
\def\ol@imagedraw#1{\leavevmode\begin{tikzpicture}[remember picture,overlay]\ol@at
  \node[anchor=center,inner sep=0pt,outer sep=0pt,rotate=\ol@rot,opacity=\ol@opacity] at (ol@c)
  {\adjincludegraphics[trim={\ol@cl\width} {\ol@cb\height} {\ol@cr\width} {\ol@ct\height},clip,width=\ol@w,height=\ol@h]{#1}};\end{tikzpicture}}
\newenvironment{olgroup}[1]{\ol@reset\pgfqkeys{/ol}{#1}\ifx\ol@step\empty\def\ol@grpend{}\else
  \edef\ol@tmp{\noexpand\begin{onlyenv}<\ol@step>}\ol@tmp\def\ol@grpend{\end{onlyenv}}\fi\ignorespaces}{\ol@grpend\ignorespacesafterend}
\newcommand\olpage[1]{\ol@reset\pgfqkeys{/ol}{#1}\ifx\ol@fill\empty\else\leavevmode\begin{tikzpicture}[remember picture,overlay]
  \fill[\ol@fill] (current page.north west) rectangle (current page.south east);\end{tikzpicture}\fi
  \ifx\ol@trans\empty\else\ifcsname trans\ol@trans\endcsname\csname trans\ol@trans\endcsname\fi\fi\ignorespaces}
\@ifundefined{only}{\def\only<#1>#2{#2}\newenvironment{onlyenv}{\ol@skipspec}{}\def\ol@skipspec<#1>{}}{}
\@ifundefined{note}{\newcommand\note[2][]{}}{}`;

/** beamer slide transitions offered for pages (\trans<name>) */
export const PAGE_TRANSITIONS = ['fade', 'dissolve', 'wipe', 'push', 'cover', 'uncover', 'boxin', 'boxout', 'splitverticalin', 'blindsvertical', 'glitter'];

/** Entrance effects of OverLyX's presentation mode (the PDF shows the object at its step). */
export const OBJECT_EFFECTS = ['appear', 'fade', 'fly-left', 'fly-right', 'fly-up', 'fly-down', 'zoom', 'wipe'];
