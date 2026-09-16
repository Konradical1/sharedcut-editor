import { create } from 'zustand';
import { api } from './api';
export interface SharedFont { id: string; name: string; family: string; url: string }
const installed = ['TikTok Sans','Montserrat','Barlow Condensed','Helvetica Neue', 'Helvetica', 'Arial', 'Arial Black', 'Arial Narrow', 'Avenir', 'Avenir Next', 'Baskerville', 'Big Caslon', 'Bodoni 72', 'Bradley Hand', 'Chalkboard', 'Chalkduster', 'Cochin', 'Comic Sans MS', 'Copperplate', 'Courier', 'Courier New', 'Didot', 'DIN Alternate', 'DIN Condensed', 'Futura', 'Geneva', 'Georgia', 'Gill Sans', 'Herculanum', 'Hoefler Text', 'Impact', 'Lucida Grande', 'Luminari', 'Marker Felt', 'Menlo', 'Monaco', 'Noteworthy', 'Optima', 'Palatino', 'Papyrus', 'Rockwell', 'Savoye LET', 'SignPainter', 'Skia', 'Snell Roundhand', 'Tahoma', 'Times', 'Times New Roman', 'Trattatello', 'Trebuchet MS', 'Verdana', 'Zapfino'];
export const useFonts = create<{ shared: SharedFont[]; local: string[]; error: string; revision: number }>(() => ({ shared: [], local: installed, error: '', revision: 0 }));
// Browsers without Local Font Access can still offer installed, known system families.
export function detectLocalFonts() {
  const ctx = document.createElement('canvas').getContext('2d')!;
  const sample = 'mmmmmmWWWWWiiiiii0123456789';
  const width = (family: string) => { ctx.font = `72px ${family}`; return ctx.measureText(sample).width; };
  useFonts.setState({ local: installed.filter(font => ['monospace', 'serif'].some(fallback => width(`"${font}", ${fallback}`) !== width(fallback))) });
}
const loaded = new Set<string>();
let refreshing: Promise<void> | undefined;
export function refreshFonts() {
  return refreshing ??= (async () => {
    try {
      const { fonts } = await api<{ fonts: SharedFont[] }>('/fonts');
      for (const font of fonts) if (!loaded.has(font.id)) {
        const face = await new FontFace(font.family, `url("${font.url}")`).load(); document.fonts.add(face); loaded.add(font.id);
      }
      useFonts.setState(s => ({ shared: fonts, error: '', revision: s.revision + 1 }));
    } catch (error) { useFonts.setState({ error: (error as Error).message }); }
  })().finally(() => { refreshing = undefined; });
}
export async function browseLocalFonts() {
  const query = (window as unknown as { queryLocalFonts?: () => Promise<{family: string}[]> }).queryLocalFonts;
  if (!query) throw new Error('This browser cannot list installed fonts. Use Chrome or Edge, or choose a system font below.');
  const fonts = await query(); useFonts.setState({ local: [...new Set(fonts.map(font => font.family))].sort() });
}
export async function uploadFont(file: File) {
  if (!/\.(ttf|otf|ttc|woff2?)$/i.test(file.name) || file.size > 15 * 1024 * 1024) throw new Error('Choose a TTF, OTF, TTC, WOFF, or WOFF2 font under 15 MB.');
  const { font } = await api<{font: SharedFont}>(`/fonts?name=${encodeURIComponent(file.name.replace(/\.[^.]+$/, '').slice(0, 100))}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
  await refreshFonts(); return font;
}

export function loadCaptionFonts(){return Promise.all(['800 20px \"TikTok Sans\"','800 20px Montserrat','700 20px \"Barlow Condensed\"'].map(font=>document.fonts.load(font)));}
