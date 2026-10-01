import { renderScope, SAMPLE_HEIGHT, SAMPLE_WIDTH, SCOPE_HEIGHT, SCOPE_WIDTH, type Scope } from './scopeRender.ts';
// Reading a GPU frame back blocks the thread that asks for it (~13 ms a picture), so during playback it happens here.
const sample = new OffscreenCanvas(SAMPLE_WIDTH, SAMPLE_HEIGHT).getContext('2d', { willReadFrequently: true })!;
const scope = new OffscreenCanvas(SCOPE_WIDTH, SCOPE_HEIGHT), context = scope.getContext('2d', { willReadFrequently: true })!;
self.onmessage = (event: MessageEvent<{ frame: ImageBitmap; type: Scope; revision: string; ticket: number }>) => {
  const { frame, type, revision, ticket } = event.data;
  sample.drawImage(frame, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT); frame.close();
  renderScope(context, sample.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT).data, type);
  const picture = scope.transferToImageBitmap();
  self.postMessage({ picture, revision, ticket }, { transfer: [picture] });
};
