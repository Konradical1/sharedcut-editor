export type Scope = 'Waveform' | 'RGB Parade' | 'Vectorscope' | 'Histogram';
type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
/** Size of the frame sample a scope plots, and of the scope picture itself. */
export const SAMPLE_WIDTH = 192, SAMPLE_HEIGHT = 108, SCOPE_WIDTH = 320, SCOPE_HEIGHT = 160;
const colors = [[230, 128, 128], [138, 198, 141], [131, 168, 220]], green = [188, 232, 199];

/** Draws the scope of a SAMPLE_WIDTH x SAMPLE_HEIGHT RGBA sample. `ctx` is read back, so give it a CPU (willReadFrequently) canvas. */
export function renderScope(ctx: Context, pixels: Uint8ClampedArray, type: Scope) {
  ctx.fillStyle='#14191a';ctx.fillRect(0,0,320,160);
  ctx.strokeStyle='#303739';ctx.lineWidth=1;
  for(let i=0;i<=4;i++){ctx.beginPath();ctx.moveTo(0,8+i*36);ctx.lineTo(320,8+i*36);ctx.stroke();}
  const hist=[new Uint32Array(256),new Uint32Array(256),new Uint32Array(256)];
  const image=ctx.getImageData(0,0,320,160),out=image.data;
  const plot=(x:number,y:number,color:number[])=>{x=Math.floor(x);y=Math.floor(y);if(x<0||x>=320||y<0||y>=160)return;const at=(y*320+x)*4;for(let c=0;c<3;c++)out[at+c]=out[at+c]*.84+color[c]*.16;};
  for(let i=0;i<pixels.length;i+=4){
    const r=pixels[i],g=pixels[i+1],b=pixels[i+2],y=.2126*r+.7152*g+.0722*b;
    if(type==='Histogram'){hist[0][r]++;hist[1][g]++;hist[2][b]++;continue;}
    if(type==='Vectorscope'){plot(160+(b-y)/1.8556*.52,80-(r-y)/1.5748*.52,green);}
    else if(type==='Waveform'){plot((i/4%192)/192*320,152-y/255*144,green);}
    else for(let c=0;c<3;c++)plot(c*106+(i/4%192)/192*104,152-pixels[i+c]/255*144,colors[c]);
  }
  ctx.putImageData(image,0,0);
  if(type==='Histogram')hist.forEach((bins,c)=>{const max=Math.max(...bins,1);ctx.strokeStyle=['#e68080','#8ac68d','#83a8dc'][c];ctx.beginPath();bins.forEach((v,i)=>{const x=i/255*320,y=152-v/max*140;i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.stroke();});
  if(type==='Vectorscope'){ctx.strokeStyle='#56635d';[32,64].forEach(r=>{ctx.beginPath();ctx.arc(160,80,r,0,Math.PI*2);ctx.stroke();});ctx.beginPath();ctx.moveTo(160,80);ctx.lineTo(125,15);ctx.setLineDash([3,3]);ctx.stroke();ctx.setLineDash([]);}
}
