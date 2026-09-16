import { parseCube } from './color.ts';
// Decode large immutable LUT files off the UI thread.
self.onmessage = async (event: MessageEvent) => {
  const {key,url}=event.data;
  try {
    const response=await fetch(url);if(!response.ok)throw new Error('Resolve look is missing. Reimport its bundle.');
    const cube=parseCube(await response.text());self.postMessage({key,cube},{transfer:[cube.data.buffer]});
  }catch(error){self.postMessage({key,error:error instanceof Error?error.message:'Color transform failed.'});}
};
