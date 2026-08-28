#!/usr/bin/env python3
"""
Generate packages/server/templates/welcome/welcome.lyx — the personal example document every
account gets (see packages/server/src/access.ts, ensureWelcomeProject). Placeholders %%NAME%%,
%%FIRSTNAME%% and %%LLANGLE%% are filled in when the project is created for a user.

After generating, normalise the file through OverLyX's writer so that it is in LyX's canonical
form (line wrapping etc.):
    python3 scripts/gen-welcome.py && npx tsx scripts/normalize-lyx.ts packages/server/templates/welcome/welcome.lyx
"""
import os, re

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'packages', 'server', 'templates', 'welcome', 'welcome.lyx')
TEMPLATE = os.path.join(HERE, '..', 'packages', 'server', 'templates', 'article.lyx')

# ---------------------------------------------------------------- helpers

def par(layout, content, extra=''):
    return f"\\begin_layout {layout}\n{extra}{content}\n\\end_layout\n\n"

def imath(latex):
    return f"\n\\begin_inset Formula ${latex}$\n\\end_inset\n\n"

def dmath(latex):
    return f"\n\\begin_inset Formula \n{latex}\n\\end_inset\n\n"

def emph(t): return f"\n\\emph on\n{t}\n\\emph default\n"
def bold(t): return f"\n\\series bold\n{t}\n\\series default\n"
def tt(t): return f"\n\\family typewriter\n{t}\n\\family default\n"
def sans(t): return f"\n\\family sans\n{t}\n\\family default\n"
def key(t): return sans(t)
def sc(name): return f"\n\\SpecialChar {name}\n"
def cmd(name): return tt("\n\\backslash\n" + name)   # a LaTeX command in typewriter text (backslash is LyX syntax)
LYX = sc('LyX'); LATEX = sc('LaTeX'); TEX = sc('TeX'); SEP = sc('menuseparator'); LDOTS = sc('ldots')
def quoted(t): return "\n\\begin_inset Quotes eld\n\\end_inset\n\n" + t + "\n\\begin_inset Quotes erd\n\\end_inset\n\n"
def foot(t): return f"\n\\begin_inset Foot\nstatus collapsed\n\n\\begin_layout Plain Layout\n{t}\n\\end_layout\n\n\\end_inset\n\n"
def label(name): return f"\n\\begin_inset CommandInset label\nLatexCommand label\nname \"{name}\"\n\n\\end_inset\n\n"
def ref(name, cmd='ref'): return f"\n\\begin_inset CommandInset ref\nLatexCommand {cmd}\nreference \"{name}\"\nplural \"false\"\ncaps \"false\"\nnoprefix \"false\"\nnolink \"false\"\n\n\\end_inset\n\n"
def cite(keys, cmd='citep'): return f"\n\\begin_inset CommandInset citation\nLatexCommand {cmd}\nkey \"{keys}\"\nliteral \"false\"\n\n\\end_inset\n\n"
def href(target, name=None): return f"\n\\begin_inset CommandInset href\nLatexCommand href\nname \"{name or target}\"\ntarget \"{target}\"\nliteral \"false\"\n\n\\end_inset\n\n"
def note(kind, paragraphs, status='open'):
    body = ''.join(par('Plain Layout', p) for p in paragraphs)
    return f"\n\\begin_inset Note {kind}\nstatus {status}\n\n{body}\\end_inset\n\n"
def macro(definition): return f"\\begin_inset FormulaMacro\n{definition}\n\\end_inset\n"

def graphics(filename, width='70col%'):
    return f"\n\\begin_inset Graphics\n\tfilename {filename}\n\twidth {width}\n\n\\end_inset\n\n"

def caption(text, lab):
    return f"\n\\begin_inset Caption Standard\n\n\\begin_layout Plain Layout\n{label(lab)}{text}\n\\end_layout\n\n\\end_inset\n\n"

def float_(kind, content):
    return (f"\\begin_layout Standard\n\\begin_inset Float {kind}\nplacement document\nalignment document\nwide false\nsideways false\nstatus open\n\n"
            f"{content}\\end_inset\n\n\n\\end_layout\n\n")

def tabular(rows, header=True):
    ncols = len(rows[0])
    out = [f'<lyxtabular version="3" rows="{len(rows)}" columns="{ncols}">', '<features tabularvalignment="middle">']
    for c in range(ncols):
        out.append(f'<column alignment="{"left" if c == 0 else "left"}" valignment="top">')
    for r, row in enumerate(rows):
        out.append('<row>')
        for c, cell in enumerate(row):
            attrs = 'alignment="left" valignment="top"'
            if r == 0: attrs += ' topline="true"'
            if r == 0 and header or r == len(rows) - 1: attrs += ' bottomline="true"'
            attrs += ' usebox="none"'
            out.append(f'<cell {attrs}>\n\\begin_inset Text\n\n\\begin_layout Plain Layout\n{cell}\n\\end_layout\n\n\\end_inset\n</cell>')
        out.append('</row>')
    out.append('</lyxtabular>')
    return "\n\\begin_inset Tabular\n" + "\n".join(out) + "\n\n\\end_inset\n\n"

# ------------------------------------------------------------------ body

body = []
body.append(par('Title', 'Welcome to OverLyX'))
body.append(par('Author', '%%NAME%%'))
body.append(par('Abstract',
    "This is your personal example document, %%FIRSTNAME%%. It is an ordinary " + LYX + " file in a project of your own: everything you do here is saved exactly as " + LYX +
    " would save it, so you can open it in desktop " + LYX + " at any time. Edit it, break it, share it — or delete the project once you know your way around."))

# --- Editing text
body.append(par('Section', 'Editing text' + label('sec:text')))
body.append(par('Standard',
    "Every paragraph has a " + emph('layout') + " — Standard, Section, Itemize, Quote, " + LDOTS + " — chosen from the drop-down at the left of the toolbar, with " + LYX +
    "'s shortcuts (" + key('Alt+P') + " followed by a letter, e.g." + sans(' Alt+P 2') + " for a section), or from the right-click menu. The outline on the right follows the sections; click an entry to jump there."))
body.append(par('Standard',
    "Character styles work as in " + LYX + ": " + emph('emphasis') + " with" + key(' Ctrl+E') + ", " + bold('bold') + " with" + key(' Ctrl+B') + ", " + tt('typewriter') +
    " and small caps from the Edit" + SEP + "Text Style menu. Footnotes" + foot("A footnote. Insets like this one open and close with a click on their label; " + key('Ctrl+Alt+F') + " inserts one.") +
    " and " + quoted('typographic quotes') + " are insets, just like in " + LYX + "."))
body.append(par('Itemize', "Lists are layouts too: this is an Itemize paragraph (" + key('Alt+P I') + ")."))
body.append(par('Itemize', "Press" + key(' Enter') + " for the next item, " + key('Tab') + " to nest it one level deeper, and" + key(' Shift+Tab') + " (or the layout drop-down) to get out again."))
body.append(par('Enumerate', "Enumerate (" + key('Alt+P E') + ") numbers its items —"))
body.append(par('Enumerate', "and Description (" + key('Alt+P D') + ") sets the first words in bold, like the shortcut list below."))
body.append(par('Description', "Ctrl+M inline formula"))
body.append(par('Description', "Ctrl+Shift+M display formula"))
body.append(par('Description', "Ctrl+R compile the PDF"))
body.append(par('Description', "Ctrl+F find and replace"))
body.append(par('Description', "Ctrl+Shift+E track changes"))
body.append(par('Standard',
    "Cross-references are insets as well: the mathematics are in Section " + ref('sec:math') + ", the figure is Figure " + ref('fig:waves') +
    " and the shortcuts are collected in Table " + ref('tab:shortcuts') + ". Insert" + SEP + "Label puts a label on the current paragraph; Insert" + SEP + "Cross-reference lists all labels of the project, including those of child documents."))

# --- Mathematics
body.append(par('Section', 'Mathematics' + label('sec:math')))
body.append(par('Standard',
    "Formulas are edited in place with a port of " + LYX + "'s math editor, so everything behaves as you are used to: " + key('Ctrl+M') + " starts an inline formula such as " +
    imath("e^{i\\pi}+1=0") + " and" + key(' Ctrl+Shift+M') + " a displayed one. Type a backslash to enter a command (" + cmd('int') + ", " + cmd('alpha') + ", " + cmd('frac') +
    "), complete it with" + key(' Tab') + ", and use" + key(' Space') + " to leave the current inset:"))
body.append(par('Standard', dmath("\\begin{equation}\n\\int_{-\\infty}^{\\infty}e^{-x^{2}}\\,\\mathrm{d}x=\\sqrt{\\pi}.\\label{eq:gauss}\n\\end{equation}\n")))
body.append(par('Standard',
    "The math toolbars (they appear while the cursor is in a formula) hold the Greek letters, operators, relations, arrows, decorations, fonts and delimiters of " + LYX +
    "'s panels. Delimiters come in every size — plain, " + cmd('left') + LDOTS + cmd('right') + ", " + cmd('big') + ", " + cmd('Big') + ", " + cmd('bigg') + ", " + cmd('Bigg') +
    " — including the double angle brackets, for which OverLyX added a small macro to this document's preamble:"))
body.append(par('Standard', dmath("\\begin{equation}\n\\left\\llangle f,g\\right\\rrangle =\\int_{0}^{1}f(x)\\,g(x)\\,\\mathrm{d}x,\\qquad\\bigl\\llangle x\\bigr\\rrangle \\neq\\left|x\\right|.\\label{eq:llangle}\n\\end{equation}\n")))
body.append(par('Standard',
    "Document macros are honoured. The following paragraph defines one — a " + LYX + " math macro (Insert" + SEP + "Math" + SEP + "Macro) with one argument:"))
body.append(par('Standard', macro("\\newcommand{\\E}[1]{\\mathbb{E}\\left[#1\\right]}")))
body.append(par('Standard',
    "From here on " + imath("\\E{X}") + " expands to the definition (editable in place, argument included); equation (" + ref('eq:macro') + ") uses it, and the definition travels with the document to " + LATEX + "."))
body.append(par('Standard', dmath("\\begin{align}\n\\mathrm{Var}\\left[X\\right] & =\\E{X^{2}}-\\E{X}^{2},\\label{eq:macro}\\\\\n\\mathrm{Cov}\\left[X,Y\\right] & =\\E{XY}-\\E{X}\\E{Y}.\\nonumber \n\\end{align}\n")))
body.append(par('Standard',
    "Press" + key(' Enter') + " inside a formula to add a row (an inline formula becomes an" + tt(' align') + " environment), " + key('Tab') + " to move between cells, and use the matrix button of the math toolbar for something like " +
    imath("\\begin{pmatrix}a & b\\\\\nc & d\n\\end{pmatrix}") + ". The right-hand " + emph(' Source') + " panel shows the " + LYX + " and " + LATEX + " source of the paragraph under the cursor."))

# --- Figures, tables, references
body.append(par('Section', 'Figures, tables and references' + label('sec:floats')))
body.append(par('Standard',
    "Figure " + ref('fig:waves') + " is a floating figure with a PDF graphic from the project's" + tt(' figures') + " folder. Upload your own files with the upload button next to a project in the file browser (or drop them onto it); SVG, PNG, JPEG, PDF and EPS are rendered in the editor and converted for " + LATEX + " as needed."))
body.append(float_('figure',
    par('Plain Layout', "\\align center" + graphics('figures/waves.pdf', '70col%'), '') +
    par('Plain Layout', caption("Three damped oscillations, " + imath("x(t)=A\\,e^{-t/4}\\sin(\\omega t+\\varphi)") + ". The figure is" + tt(' figures/waves.pdf') + " in this project; double-click it to change its size.", 'fig:waves'))))
body.append(par('Standard',
    "Tables are " + LYX + " tables: the table toolbar (shown while the cursor is in a table) adds and removes rows and columns, sets borders and alignment, and joins cells."))
body.append(float_('table',
    par('Plain Layout', caption("Keyboard shortcuts you will use most (Help" + SEP + "Keyboard shortcuts lists them all).", 'tab:shortcuts')) +
    par('Plain Layout', "\\align center" + tabular([
        ['Keys', 'Action'],
        [key('Ctrl+M') + ' / ' + key('Ctrl+Shift+M'), 'inline / display formula'],
        [key('Alt+P') + ' + letter', 'paragraph layout (1–6 sections, I, E, D lists)'],
        [key('Ctrl+E') + ', ' + key('Ctrl+B'), 'emphasis, bold'],
        [key('Ctrl+R'), 'compile the PDF'],
        [key('Ctrl+Shift+E'), 'track changes on/off'],
        [key('Ctrl+Alt+F') + ' / ' + key('Ctrl+Alt+N') + ' / ' + key('Ctrl+Alt+C'), 'footnote / note / comment'],
        [key('Ctrl+F'), 'find and replace'],
    ]), '')))
body.append(par('Standard',
    "Citations come from the project's BibTeX files (" + tt('refs.bib') + " here): Insert" + SEP + "Citation searches them by author, year and title. OverLyX writes " + LYX + " files, " + LYX + " writes " + LATEX + " " +
    cite('lamport1994', 'citep') + ", and underneath it all is " + TEX + " " + cite('knuth1984', 'citep') + ". Concurrent edits from several people are merged with conflict-free replicated data types " + cite('shapiro2011', 'citep') +
    ", which is why nobody ever has to resolve a merge conflict."))

# --- Working together
body.append(par('Section', 'Working together' + label('sec:collab')))
body.append(par('Standard',
    bold('Sharing.') + " A project is private to you until you share it — like a Google Doc. File" + SEP + "Share project" + LDOTS + " (or the share button next to the project in the file browser) invites people by username or e-mail address as" +
    emph(' viewers') + " or " + emph(' editors') + ", and can turn on a link that anyone signed in can use. Someone invited by e-mail gets access the moment they sign in with Google."))
body.append(par('Standard',
    bold('Presence.') + " Everybody who has the document open appears as a small avatar in the status bar, and their cursors and selections show in the text in their colour. Click an avatar to jump to where that person is editing."))
body.append(par('Standard',
    bold('Saving.') + " There is no Save button: every change goes to the server as you type and is written to the" + tt(' .lyx') + " file a moment later (the status bar says " + emph(' All changes saved') +
    "). If you open the same file in desktop " + LYX + " and save it there, OverLyX picks up the change. Working offline is fine too — edits are kept in the browser and merge when you are back."))
body.append(par('Standard',
    bold('Changes, notes and comments.') + " " + key('Ctrl+Shift+E') + " turns on change tracking; the review toolbar walks through the changes and accepts or rejects them, just as in " + LYX +
    ". Notes are invisible in the output — this one is a " + LYX + " note:" + note('Note', ["A " + LYX + " note. It is stored in the file and shown in desktop " + LYX + ", but never printed."]) +
    " Comments become discussion threads (reply, resolve), and View" + SEP + "Notes & comments in the margin shows them next to the text:" +
    note('Comment', ["OverLyX (2026-08-28 09:00):", "A comment thread. Click it to reply or to mark it resolved."]) +
    " File" + SEP + "Versions keeps named versions and automatic snapshots of the document; any of them can be compared and restored."))

# --- Compiling
body.append(par('Section', 'Compiling and exporting' + label('sec:compile')))
body.append(par('Standard',
    key('Ctrl+R') + " compiles the document with" + tt(' pdflatex') + " (via" + tt(' latexmk') + ") in the background and shows the result in the PDF panel; errors and warnings are listed underneath it. File" + SEP + "Export also offers the " + LATEX +
    " source, a build with native " + LYX + " for comparison, and the" + tt(' .lyx') + " file itself for download. Document" + SEP + "Settings changes the class, the preamble, packages and the bibliography style."))

# --- Where next
body.append(par('Section', 'Where to go next' + label('sec:next')))
body.append(par('Standard',
    "Create a project of your own with the" + bold(' + Project') + " button in the file browser and upload your existing" + tt(' .lyx') + " files, figures and bibliographies — or ask a colleague to share theirs with you. Help" + SEP +
    "Keyboard shortcuts lists everything; the source of this editor is at" + href('https://github.com/japhba/overlyx', 'github.com/japhba/overlyx') + "."))
body.append(par('Standard', "Enjoy writing, %%FIRSTNAME%%!"))

body.append(par('Standard', "\n\\begin_inset CommandInset bibtex\nLatexCommand bibtex\nbtprint \"btPrintCited\"\nbibfiles \"refs\"\noptions \"plainnat\"\nencoding \"default\"\n\n\\end_inset\n\n"))

# ---------------------------------------------------------------- assemble

tpl = open(TEMPLATE, encoding='utf8').read()
tpl = tpl.replace("\\begin_preamble\n\\end_preamble", "\\begin_preamble\n%%LLANGLE%%\n\\end_preamble")
tpl = tpl.replace("\\use_package amsmath 0", "\\use_package amsmath 1").replace("\\use_package amssymb 0", "\\use_package amssymb 1")
tpl = tpl.replace("\\use_hyperref false", "\\use_hyperref true")
tpl = tpl.replace("\\pdf_pdfusetitle true", "\\pdf_pdfusetitle true\n\\pdf_quoted_options \"linkcolor=blue,citecolor=blue,urlcolor=blue\"")
doc = tpl.replace('%%BODY%%', "\n" + ''.join(body).rstrip('\n') + "\n")
os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, 'w', encoding='utf8').write(doc)
print('wrote', os.path.relpath(OUT), len(doc), 'bytes')
