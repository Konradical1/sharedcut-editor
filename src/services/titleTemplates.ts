import type { Clip, Keyframe } from '../state/models.ts';
import { defaultShape, type ShapeDocument } from './shapes.ts';
import { defaultTextEffects, defaultTextStyle, presetDocument, titlePresets, type TextDocument } from './text.ts';

const originalCategories = ['Cinematic','Cinematic','Bold','Lower Thirds','Lower Thirds','Simple','Cinematic','Simple','Simple','Credits','Simple','Credits'];
export const titleTemplates = titlePresets.map((preset, index) => ({ name: preset.name, category: originalCategories[index] ?? preset.category, layered: index >= 14 && index !== 16 && index !== 17 && index !== 34 }));
export interface TitleLayer { name: string; text?: TextDocument; shape?: ShapeDocument; properties?: Clip['properties']; keyframes?: Clip['keyframes'] }
export interface TitleTemplate { name: string; duration: number; layers: TitleLayer[] }
const text = (content: string, x: number, y: number, width: number, size: number, color = '#ffffff', patch: Partial<TextDocument> = {}): TextDocument => ({ ...defaultTextEffects, runs: [{ text: content, style: { ...defaultTextStyle, fontSize: size, color } }], x, y, width, height: Math.min(.7, 1 - y), align: 'left', lineHeight: 1.14, opacity: 100, ...patch });

export function createTitleTemplate(index = 0, animated = true, fps = 24): TitleTemplate {
  index = titlePresets[index] ? index : 0;
  const duration = index === 34 ? 10 : 5, layers: TitleLayer[] = [];
  const shape = (name: string, kind: string, x: number, y: number, width: number, height: number, fill: string, patch: Partial<ShapeDocument> = {}) => layers.push({ name, shape: { ...defaultShape(kind), x, y, width, height, fill, ...patch } });
  const label = (name: string, content: string, x: number, y: number, width: number, size: number, color?: string, patch: Partial<TextDocument> = {}) => layers.push({ name, text: text(content, x, y, width, size, color, patch) });
  const main = presetDocument(index);
  if ([0,3,4,7,9,10,14,15,16,26,27,29].includes(index)) Object.assign(main, { shadowOpacity: 42, shadowBlur: 16, shadowY: 5 });
  if (index === 13 || index === 4 || index === 8) Object.assign(main, { typingEnabled: animated, typingCursor: index === 13 && animated, typingSpeed: index === 4 ? 34 : 22, typingRandomness: 32 });
  switch (index) {
    case 14:
      shape('Upper rule', 'rectangle', .30, .35, .40, .002, '#c3ab76');
      shape('Lower rule', 'rectangle', .30, .59, .40, .002, '#c3ab76');
      label('Edition', 'AN ORIGINAL STORY', .2, .64, .6, 27, '#c3ab76', { align: 'center' });
      break;
    case 15:
      label('Kicker', 'FRAME / 001', .3, .27, .4, 28, '#c3b49c', { align: 'center' });
      shape('Fine rule', 'rectangle', .44, .57, .12, .003, '#c3b49c');
      label('Subheading', 'A FILM BY YOUR NAME', .2, .63, .6, 30, '#c3b49c', { align: 'center' });
      break;
    case 17:
      Object.assign(main, { outlineColor: '#151b22', outlineWidth: 7, shadowColor: '#e94156', shadowOpacity: 100, shadowBlur: 0, shadowX: 12, shadowY: 12 });
      break;
    case 18:
      shape('Signal bar', 'rectangle', .085, .20, .13, .018, '#eaff65');
      label('Footer', 'IDEAS / PEOPLE / POSSIBILITIES', .08, .68, .8, 31, '#eaff65');
      break;
    case 19:
      ['MAKE','SOME','NOISE.'].forEach((word, i) => {
        shape(`${word} label`, 'rectangle', .20 + i * .025, .21 + i * .185, [.33,.35,.43][i], .15, ['#f00951','#d80848','#ad093e'][i]);
        label(word, word, .225 + i * .025, .23 + i * .185, .5, 112);
      });
      break;
    case 20:
      shape('Angled ribbon', 'rectangle', .12, .37, .76, .20, '#ee0750');
      layers.at(-1)!.properties = { rotation: -5 };
      main.y = .40; main.runs[0].style.fontSize = 88;
      layers.push({ name: 'Title', text: main, properties: { rotation: -5 } });
      label('Subheading', 'A NEW WAY TO SEE THINGS', .18, .67, .64, 30, '#fa8da5', { align: 'center' });
      break;
    case 21:
      shape('Mint card', 'rectangle', .13, .20, .57, .57, '#b6ede1');
      shape('Orange tab', 'rectangle', .64, .16, .18, .22, '#f28e5d');
      shape('Blue dot', 'ellipse', .67, .64, .115, .20, '#5964f2');
      Object.assign(main, { x: .20, width: .56, y: .28 });
      break;
    case 22:
      shape('Lilac backplate', 'rectangle', .16, .20, .61, .57, '#d8baff');
      shape('Launch card', 'rectangle', .20, .24, .59, .54, '#6252f7', { shadowColor: '#4435d4', shadowOpacity: 55, shadowBlur: 36, shadowY: 15 });
      shape('Mint chevron', 'chevron', .65, .24, .14, .54, '#a9eae6');
      Object.assign(main, { x: .26, y: .34, width: .38 });
      label('Eyebrow', 'INTRODUCING', .26, .29, .40, 26, '#d4ceff');
      break;
    case 23:
      shape('Paper shadow', 'rectangle', .23, .23, .56, .53, '#a1d5d1');
      shape('Note', 'rectangle', .21, .21, .56, .53, '#b6f0e8');
      shape('Tape', 'rectangle', .40, .18, .17, .052, '#efaa99', { opacity: 92 });
      main.x = .25; main.width = .48; main.y = .35;
      label('Subheading', 'MAKE YOURSELF AT HOME', .28, .59, .42, 27, '#4c6082', { align: 'center' });
      break;
    case 24:
      shape('Yellow field', 'rounded', .14, .21, .70, .58, '#efef86', { cornerRadius: 30 });
      shape('Pink accent', 'ellipse', .72, .16, .12, .21, '#ed93c5');
      shape('Purple star', 'star', .12, .66, .12, .21, '#7663d8');
      main.x = .22; main.width = .6;
      break;
    case 25:
      shape('Frame', 'rectangle', .13, .33, .74, .32, '#ffffff', { opacity: 100, fillMode: 'solid', outlineColor: '#e9d9b3', outlineWidth: 2 });
      layers.at(-1)!.shape!.fillOpacity = 0;
      main.runs[0].style.fontSize = 76;
      break;
    case 26:
      shape('Interview plate', 'rectangle', .07, .70, .48, .19, '#172332', { opacity: 91 });
      shape('Side stripe', 'rectangle', .07, .70, .006, .19, '#cbbb9e');
      main.x = .10; main.width = .42; main.y = .72;
      break;
    case 27:
      shape('Accent underline', 'rectangle', .08, .885, .29, .006, '#ffd77c');
      break;
    case 28:
      shape('Badge', 'rounded', .08, .74, .34, .13, '#b9e8c4', { cornerRadius: 70, shadowOpacity: 22, shadowBlur: 18, shadowY: 6 });
      Object.assign(main, { x: .1, y: .77, width: .30, height: .1 });
      break;
    case 29:
      shape('Speaker panel', 'rounded', .07, .69, .48, .22, '#4f4bdd', { fillMode: 'linear', gradientEnd: '#8444c5', gradientAngle: 20, cornerRadius: 18 });
      shape('Accent dot', 'ellipse', .09, .744, .025, .044, '#d1ff8c');
      Object.assign(main, { x: .13, y: .73, width: .39 });
      break;
    case 30:
      shape('Breaking tab', 'pen', .025, .035, .32, .085, '#b9081d', { closed: true, points: [{x:0,y:0},{x:.92,y:0},{x:1,y:1},{x:0,y:1}] });
      label('Breaking label', 'BREAKING NEWS', .04, .049, .28, 48);
      label('Live label', 'LIVE', .84, .049, .12, 43, '#ffffff', { align: 'right' });
      shape('Blue rail', 'rectangle', .025, .71, .11, .17, '#0759aa', { fillMode: 'linear', gradientEnd: '#143264', gradientAngle: 90 });
      shape('Headline plate', 'pen', .13, .71, .84, .12, '#fafafa', { closed: true, points: [{x:0,y:0},{x:.96,y:0},{x:1,y:1},{x:0,y:1}] });
      shape('Red subtitle bar', 'rectangle', .13, .83, .84, .058, '#a3081c');
      label('News identifier', 'NEWS', .035, .754, .09, 44, '#ffffff', { align: 'center' });
      label('Subtitle', 'THE LATEST DEVELOPMENTS • YOUR SUBTITLE HERE', .16, .84, .78, 31);
      Object.assign(main, { x: .16, y: .727, width: .75, height: .095 });
      break;
    case 31:
      shape('News panel', 'rectangle', .09, .24, .81, .49, '#162b50', { fillMode: 'linear', gradientEnd: '#224a7d', gradientAngle: 25 });
      shape('Red marker', 'rectangle', .09, .24, .013, .49, '#e24249');
      label('Edition', 'NEWS / ANALYSIS / CONTEXT', .15, .29, .70, 29, '#9cb9db');
      label('Subheading', 'A CLEARER VIEW OF THE WORLD', .15, .57, .7, 32, '#c5d7e8');
      Object.assign(main, { x: .15, y: .40, width: .70 });
      break;
    case 32:
      shape('Bulletin bar', 'rectangle', .06, .69, .88, .19, '#152136', { opacity: 96 });
      shape('Update tab', 'rectangle', .06, .635, .16, .058, '#e74343');
      label('Update label', 'UPDATE', .075, .642, .135, 32);
      label('Subtitle', 'YOUR CONTEXT, IN A FEW WORDS', .09, .815, .80, 27, '#adbcd2');
      Object.assign(main, { x: .09, y: .72, width: .8 });
      break;
    case 33:
      shape('Offset ribbon', 'rectangle', .13, .36, .74, .20, '#77183b');
      shape('Headline ribbon', 'pen', .10, .34, .78, .20, '#d50a45', { closed: true, points: [{x:0,y:0},{x:1,y:0},{x:.96,y:1},{x:0,y:1}] });
      Object.assign(main, { y: .389, x: .13, width: .68 });
      break;
    case 34:
      Object.assign(main, { y: .10, height: .90, lineHeight: 1.26 });
      break;
    case 35:
      shape('Closing rule', 'rectangle', .44, .66, .12, .003, '#bfa77a');
      label('Sign off', 'THANK YOU FOR WATCHING', .20, .72, .6, 27, '#bfa77a', { align: 'center' });
      break;
  }
  if (![19,20].includes(index)) layers.push({ name: 'Title', text: main });
  if ([26,27,29].includes(index)) {
    const title = layers.at(-1)!.text!, [a,b] = title.runs[0].text.split('\n');
    title.runs = [{ text: a + '\n', style: title.runs[0].style }, { text: b, style: { ...title.runs[0].style, fontSize: 37, fontWeight: 400 } }];
  }
  if (!animated) return { name: titlePresets[index].name, duration, layers };
  const entrance = Math.min(.48, (layers.length - 1) * .08) + (index === 17 || index === 18 ? .55 : .85), exit = .65;
  layers.forEach((layer, i) => {
    const doc = layer.text ?? layer.shape!, prefix = layer.text ? 'text' : 'shape';
    const delay = Math.min(.48, i * .08), end = delay + (index === 17 || index === 18 ? .55 : .85);
    let serial = 0;
    const keys = (values: [number, number][], punch = false): Keyframe[] => values.map(([time, value]) => ({ id: `title-${index}-${i}-${serial++}`, time: Math.round(time * fps) / fps, value, interpolation: 'bezier', curve: punch ? [.18,.9,.25,1.16] : [.22,.7,.25,1] }));
    layer.properties = { ...layer.properties, animationPresetDuration: duration, animationEntrance: entrance, animationExit: exit };
    layer.keyframes = { 'properties.opacity': keys([[0,0],[delay,0],[end,100],[duration - exit,100],[duration - 1/fps,0]].filter(([t], j, all) => j === 0 || t !== all[j-1][0]) as [number,number][]) };
    const horizontal = [2,3,4,13,18,19,20,26,27,28,29,30,31,32,33].includes(index), direction = index % 3 === 0 ? -1 : 1;
    const axis = horizontal ? 'x' : 'y', offset = (horizontal ? .07 : .035) * direction;
    layer.keyframes[`${prefix}.${axis}`] = keys([[0,doc[axis] + offset],[end,doc[axis]],[duration - exit,doc[axis]],[duration - 1/fps,doc[axis] - offset * .5]], [2,17,18,19,21,22,24].includes(index));
    if (layer.text && [0,1,6,7,14,15,16,35].includes(index)) layer.keyframes['text.blur'] = keys([[0,index === 16 ? 24 : 12],[end,0],[duration - exit,0],[duration - 1/fps,9]]);
    if ([17,18,21,22,24].includes(index)) layer.keyframes['properties.zoom'] = keys([[0,92],[end,100],[duration - exit,100],[duration - 1/fps,103]], true);
    if (index === 34) layer.keyframes['text.y'] = keys([[0,.85],[duration - 1/fps,-.85]]).map(key => ({ ...key, interpolation: 'linear' }));
  });
  return { name: titlePresets[index].name, duration, layers };
}
