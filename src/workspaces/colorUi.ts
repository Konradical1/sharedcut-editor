import { create } from 'zustand';

/** Color page tool tabs, shared by the bottom tool area and the viewer overlays (windows handles, qualifier picker). */
export const COLOR_TOOLS = ['Primaries', 'Curves', 'Qualifier', 'Windows', 'Mixer', 'Film'] as const;
export type ColorTool = typeof COLOR_TOOLS[number];
/** `picking`: the next click on the viewer samples the selected node's input for the qualifier (shift adds to the key).
 *  `matte`: what the viewer shows for the selected node's key: the grade, the keyed colours over grey, or the black/white matte. */
export const useColorUi = create<{ tool: ColorTool; picking: boolean; matte: 'off' | 'highlight' | 'matte' }>(() => ({ tool: 'Primaries', picking: false, matte: 'off' }));
