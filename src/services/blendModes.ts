/**
 * Clip blend modes (W3C Compositing): the canvas operation the preview draws with, and the FFmpeg `blend` mode or
 * expression the export reproduces it with (server/media.ts blendFilters), the clip as A (top) and the picture under
 * it as B. FFmpeg's own names do not always mean the W3C mode: its "hardlight" with the clip on top is W3C overlay and
 * its "overlay" W3C hard light (they switch on the other input); its softlight is a different curve; its dodge and
 * burn answer the 0/1 corners the other way. Those are written out below. FFmpeg's YUV conversions land black and white
 * up to about one 8-bit step off (black 1/255, white 254/255), so dodge and burn take anything within 1.5 steps of
 * black or white as exactly that: their corners are cliffs, and the preview's 8-bit pixels sit exactly on them.
 */
const softLight = 'if(lte(A,0.5),B-(1-2*A)*B*(1-B),B+(2*A-1)*(if(lte(B,0.25),((16*B-12)*B+4)*B,sqrt(B))-B))';
const colorDodge = 'if(lte(B,1.5/255),0,if(gte(A,1-1.5/255),1,min(1,B/(1-A))))';
const colorBurn = 'if(gte(B,1-1.5/255),1,if(lte(A,1.5/255),0,1-min(1,(1-B)/A)))';

export const blendModes = {
  Normal: { canvas: 'source-over', ffmpeg: '' },
  Add: { canvas: 'lighter', ffmpeg: 'addition' },
  Screen: { canvas: 'screen', ffmpeg: 'screen' },
  Multiply: { canvas: 'multiply', ffmpeg: 'multiply' },
  Overlay: { canvas: 'overlay', ffmpeg: 'hardlight' },
  'Soft light': { canvas: 'soft-light', ffmpeg: softLight },
  'Hard light': { canvas: 'hard-light', ffmpeg: 'overlay' },
  Lighten: { canvas: 'lighten', ffmpeg: 'lighten' },
  Darken: { canvas: 'darken', ffmpeg: 'darken' },
  'Color dodge': { canvas: 'color-dodge', ffmpeg: colorDodge },
  'Color burn': { canvas: 'color-burn', ffmpeg: colorBurn },
  Difference: { canvas: 'difference', ffmpeg: 'difference' },
  Exclusion: { canvas: 'exclusion', ffmpeg: 'exclusion' },
} as const satisfies Record<string, { canvas: GlobalCompositeOperation; ffmpeg: string }>;

export const blendModeNames = Object.keys(blendModes);
/** The mode a saved value names (missing is Normal), or undefined for one this version does not know. */
export const blendModeOf = (value: unknown) => { const name = String(value ?? 'Normal'); return Object.hasOwn(blendModes, name) ? blendModes[name as keyof typeof blendModes] : undefined; };
