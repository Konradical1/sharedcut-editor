/** Clip blend modes: the canvas operation used by the preview and the FFmpeg `blend` mode used by export. */
export const blendModes = {
  Normal: { canvas: 'source-over', ffmpeg: '' },
  Add: { canvas: 'lighter', ffmpeg: 'addition' },
  Screen: { canvas: 'screen', ffmpeg: 'screen' },
  Multiply: { canvas: 'multiply', ffmpeg: 'multiply' },
  Overlay: { canvas: 'overlay', ffmpeg: 'overlay' },
  'Soft light': { canvas: 'soft-light', ffmpeg: 'softlight' },
  'Hard light': { canvas: 'hard-light', ffmpeg: 'hardlight' },
  Lighten: { canvas: 'lighten', ffmpeg: 'lighten' },
  Darken: { canvas: 'darken', ffmpeg: 'darken' },
  'Color dodge': { canvas: 'color-dodge', ffmpeg: 'dodge' },
  'Color burn': { canvas: 'color-burn', ffmpeg: 'burn' },
  Difference: { canvas: 'difference', ffmpeg: 'difference' },
  Exclusion: { canvas: 'exclusion', ffmpeg: 'exclusion' },
} as const satisfies Record<string, { canvas: GlobalCompositeOperation; ffmpeg: string }>;

export type BlendMode = keyof typeof blendModes;
export const blendModeNames = Object.keys(blendModes) as BlendMode[];
export const blendModeOf = (value: unknown) => blendModes[String(value) as BlendMode] ?? blendModes.Normal;
