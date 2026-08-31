#!/usr/bin/env python3
"""Extract the LyX toolbar icons (lib/images/*.svgz) used by OverLyX's toolbars into
packages/client/public/lyxicons/*.svg and generate src/app/lyxicons.ts mapping icon keys to
their URLs. The keys are the ones the ToolButton definitions in App.tsx use; the files are
LyX's own icons, named by the LFUN the button triggers (spaces become underscores; the
dialog-toggle actions fall back to the dialog-show icon, as LyX's iconInfo() does).
Run from anywhere: python3 scripts/gen-lyx-icons.py  (needs the LyX source tree at ../..)."""
import gzip, os, sys

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
images = os.path.abspath(os.path.join(root, '..', 'lib', 'images'))
outdir = os.path.join(root, 'packages', 'client', 'public', 'lyxicons')
ts = os.path.join(root, 'packages', 'client', 'src', 'app', 'lyxicons.ts')

# key -> icon file (relative to lib/images, without .svgz); a leading ? marks an optional icon
ICONS = {
    # standard
    'new': 'buffer-new', 'open': 'file-open', 'spellcheck': 'spelling-continuously',
    'undo': 'undo', 'redo': 'redo', 'cut': 'cut', 'copy': 'copy', 'paste': 'paste',
    'find': 'dialog-show_findreplace', 'navback': 'bookmark-goto_0',
    'emph': 'font-emph', 'noun': 'font-noun', 'charstyles': 'textstyle-apply',
    'math': 'math-mode', 'graphics': 'dialog-show-new-inset_graphics', 'table': 'tabular-insert',
    'outline': 'dialog-show_toc',
    'mathtb': 'toolbar-toggle_math', 'tabletb': 'toolbar-toggle_table', 'reviewtb': 'toolbar-toggle_review',
    'mathpanelstb': '?toolbar-toggle_math_panels',
    # view/update
    'view': 'buffer-view', 'update': 'buffer-update', 'viewmaster': 'master-buffer-view',
    'updatemaster': 'master-buffer-update', 'outputsync': 'buffer-toggle-output-sync',
    # extra
    'layout': 'layout', 'enumerate': 'layout-toggle_Enumerate', 'itemize': 'layout-toggle_Itemize',
    'labeling': 'layout-toggle_Labeling', 'description': 'layout-toggle_Description', 'section': 'layout-toggle_Section',
    'depthin': 'outline-in', 'depthout': 'outline-out',
    'float': 'float-insert_figure', 'tablefloat': 'float-insert_table', 'label': 'label-insert',
    'ref': 'dialog-show-new-inset_ref', 'cite': 'dialog-show-new-inset_citation', 'index': 'index-insert', 'nomencl': 'nomencl-insert',
    'footnote': 'footnote-insert', 'marginal': 'marginalnote-insert', 'note': 'note-insert', 'boxinset': 'box-insert',
    'href': 'href-insert', 'ert': 'ert-insert', 'macro': 'math-macro_newmacroname_newcommand', 'include': 'dialog-show-new-inset_include',
    'textstyle': 'dialog-show_character', 'paragraph': 'layout-paragraph', 'thesaurus': '?thesaurus-entry',
    # math
    'display': 'math-display', 'sub': 'math-subscript', 'sup': 'math-superscript',
    'msqrt': 'math/sqrt', 'mroot': 'math/root', 'mfrac': 'math/frac', 'msum': 'math/sum', 'mint': 'math/int', 'mprod': 'math/prod',
    'delimsize': 'dialog-show_mathdelimiter', 'matrix': 'dialog-show_mathmatrix', 'cases': 'math/cases',
    # table (also used inside the math row for grid editing)
    'addrow': 'tabular-feature_append-row', 'addcol': 'tabular-feature_append-column',
    'delrow': 'tabular-feature_delete-row', 'delcol': 'tabular-feature_delete-column',
    'rowup': 'tabular-feature_move-row-up', 'colleft': 'tabular-feature_move-column-left',
    'rowdown': 'tabular-feature_move-row-down', 'colright': 'tabular-feature_move-column-right',
    'linetop': 'tabular-feature_toggle-line-top', 'linebottom': 'tabular-feature_toggle-line-bottom',
    'lineleft': 'tabular-feature_toggle-line-left', 'lineright': 'tabular-feature_toggle-line-right',
    'borderlines': 'tabular-feature_toggle-border-lines', 'innerlines': 'tabular-feature_toggle-inner-lines',
    'alllines': 'tabular-feature_toggle-all-lines', 'nolines': 'tabular-feature_unset-all-lines',
    'formallines': 'tabular-feature_reset-formal-default',
    'alignleft': 'tabular-feature_m-align-left', 'aligncenter': 'tabular-feature_m-align-center',
    'alignright': 'tabular-feature_m-align-right', 'aligndecimal': 'tabular-feature_align-decimal',
    'valigntop': 'tabular-feature_m-valign-top', 'valignmiddle': 'tabular-feature_m-valign-middle',
    'valignbottom': 'tabular-feature_m-valign-bottom',
    'rotatecell': 'tabular-feature_toggle-rotate-cell', 'rotatetable': 'tabular-feature_toggle-rotate-tabular',
    'multicolumn': 'tabular-feature_multicolumn', 'multirow': 'tabular-feature_multirow',
    'tablesettings': '?dialog-show_tabular',
    # review
    'track': 'changes-track', 'changesoutput': 'changes-output',
    'changenext': 'change-next', 'changeprev': '?change-previous',
    'accept': 'change-accept', 'reject': 'change-reject',
    'acceptall': 'all-changes-accept', 'rejectall': 'all-changes-reject',
    # version control
    'vcregister': 'vc-register', 'vccheckin': 'vc-check-in', 'vclog': 'dialog-show_vclog',
    'vccompare': 'vc-compare', 'vcrepoupdate': 'vc-repo-update',
}

os.makedirs(outdir, exist_ok=True)
entries, missing = [], []
for key, src in sorted(ICONS.items()):
    optional = src.startswith('?')
    src = src.lstrip('?')
    path = os.path.join(images, src + '.svgz')
    if not os.path.exists(path):
        if optional:
            print(f'  (optional icon {src} not in lib/images — {key} keeps its fallback)')
            continue
        missing.append(key + ' -> ' + src)
        continue
    svg = gzip.open(path, 'rb').read()
    with open(os.path.join(outdir, key + '.svg'), 'wb') as f:
        f.write(svg)
    entries.append(key)

if missing:
    sys.exit('missing icons: ' + ', '.join(missing))

with open(ts, 'w') as f:
    f.write('/** LyX toolbar icons (lib/images/*.svgz), generated by scripts/gen-lyx-icons.py — do not edit. */\n')
    f.write('export const LYX_ICONS: Record<string, string> = {\n')
    for key in entries:
        f.write(f"  {key!r}: '/lyxicons/{key}.svg',\n")
    f.write('};\n')
print(f'{len(entries)} icons -> {outdir}, manifest -> {ts}')
