/**
 * Opening the emoji keyboard (picker.ts, loaded on first use) for a text editor: the emoji goes in at
 * the cursor with the text's marks, an emoji font as the `face` mark; a made emoji is saved into the
 * project's figures/ and inserted as a picture at text size.
 */
import type { EditorView } from 'prosemirror-view';
import type { Command } from 'prosemirror-state';
import { schema, parseFace, EMOJI_FAMILIES } from '@overlyx/core';
import { insertGraphics } from '../commands';
import { uploadUnique } from '../imagepaste';
import { editorContext, toDocRel, viewDocDir, viewProject } from '../context';

/** the key that opens the emoji keyboard while typing (keymap.ts, the help rows) */
export const EMOJI_KEY = 'Mod-;';

/** insert `emoji` at the selection, keeping the text's marks but an emoji font, in `face` */
export function insertEmojiText(view: EditorView, emoji: string, face: string | null): void {
  const { state } = view;
  const { $from } = state.selection;
  const keep = (state.storedMarks ?? $from.marks()).filter(m => {
    if (m.type.name === 'face') return !EMOJI_FAMILIES.has(parseFace(String(m.attrs.value))?.family ?? '');
    return !(face && m.type.name === 'family');
  }).filter(m => !(face && m.type.name === 'face'));
  const marks = face ? keep.concat(schema.marks.face.create({ value: face })) : keep;
  view.dispatch(state.tr.replaceSelectionWith(schema.text(emoji, marks), false).scrollIntoView());
}

export function openEmojiKeyboard(view: EditorView): boolean {
  if (!view.editable) return false;
  const c = view.coordsAtPos(view.state.selection.head);
  void import('./picker').then(m => m.openEmojiPicker({
    insert: (e, face) => { insertEmojiText(view, e, face); if (!matchMedia('(pointer: coarse)').matches) view.focus(); },
    focus: () => view.focus(),
    insertPicture: viewProject(view) ? async (png, name) => {
      const project = viewProject(view)!;
      const rel = await uploadUnique(project, name, 'png', png);
      insertGraphics(toDocRel(rel, viewDocDir(view)), { height: '1em' })(view.state, view.dispatch);
      editorContext.notify?.(`Emoji saved as ${rel}`);
      view.focus();
    } : undefined,
  }, { x: c.left, y: c.bottom }));
  return true;
}

/** the keymap's command (Ctrl+; / ⌘;) */
export const emojiKeyboardCommand: Command = (_s, _d, view) => (view ? openEmojiKeyboard(view) : false);
