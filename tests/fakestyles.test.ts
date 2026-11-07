/** Styles a font by name lacks, faked by the browser and missing in the PDF (client fonts/fakestyles.ts): the font button's "!". */
import { describe, it, expect } from 'vitest';
import { fakedStyles, fakeWarning, wantedStyles } from '../packages/client/src/fonts/fakestyles';

const mark = (name: string, value: string) => ({ type: { name }, attrs: { value } });
const lora = { axes: [{ tag: 'wght', min: 400, max: 700 }], weights: [], italic: true, features: ['kern', 'liga'] };
const thin = { axes: [{ tag: 'wght', min: 100, max: 500 }, { tag: 'slnt', min: -10, max: 0 }], weights: [], italic: false, features: ['smcp'] };
const staticLight = { axes: [], weights: [300, 400], italic: false, features: [] };

describe('fakedStyles', () => {
  it('bold needs a face of 600 or more, italic italic files, small capitals smcp', () => {
    const all = { bold: true, italic: true, smallcaps: true };
    expect(fakedStyles(lora, all)).toEqual(['smallcaps']);
    expect(fakedStyles(thin, all)).toEqual(['bold', 'italic']);
    expect(fakedStyles(staticLight, all)).toEqual(['bold', 'italic', 'smallcaps']);
    expect(fakedStyles({ ...staticLight, weights: [400, 600] }, all)).toEqual(['italic', 'smallcaps']);
    expect(fakedStyles(staticLight, { bold: false, italic: false, smallcaps: false })).toEqual([]);
  });

  it('only what the text in that face asks for', () => {
    const inLora = [mark('face', 'Lora|500'), mark('series', 'bold')];
    const inInter = [mark('face', 'Inter'), mark('noun', 'on'), mark('emph', 'on')];
    expect(wantedStyles([inLora, inInter], 'Lora')).toEqual({ bold: true, italic: false, smallcaps: false });
    expect(wantedStyles([inLora, inInter], 'Inter')).toEqual({ bold: false, italic: true, smallcaps: true });
    expect(wantedStyles([[mark('series', 'bold')]], 'Lora')).toEqual({ bold: false, italic: false, smallcaps: false });
    expect(wantedStyles([[mark('face', 'Lora'), mark('shape', 'smallcaps')], [mark('face', 'Lora'), mark('shape', 'slanted')]], 'Lora')).toEqual({ bold: false, italic: true, smallcaps: true });
  });

  it('says what is faked and how to avoid it', () => {
    expect(fakeWarning('Lora', ['smallcaps'])).toMatch(/^Lora has no small capitals: .* lower case\. Pick a font that has it/);
    expect(fakeWarning('Thin', ['bold', 'italic'])).toMatch(/no bold.*no italic.*has them/);
  });
});
