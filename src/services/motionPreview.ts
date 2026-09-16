import type { Clip } from '../state/models.ts';
import { drawMotionBlur, type MotionPose } from './motionBlur.ts';

/** One source upload and one floating-point shader sum; no per-sample 8-bit colour rounding. */
export function createMotionPreview() {
  const canvas=document.createElement('canvas'),software=document.createElement('canvas'),scratch=document.createElement('canvas');
  const gl=canvas.getContext('webgl2',{alpha:true,premultipliedAlpha:true,antialias:false,depth:false,stencil:false});
  let program:WebGLProgram|null=null,texture:WebGLTexture|null=null,lost=false;
  canvas.addEventListener('webglcontextlost',()=>{lost=true;});
  canvas.dataset.motionBlurBackend='webgl2';software.dataset.motionBlurBackend='software';
  if(gl){
    const compile=(type:number,source:string)=>{const shader=gl.createShader(type)!;gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)){gl.deleteShader(shader);return null;}return shader;};
    const vertex=compile(gl.VERTEX_SHADER,`#version 300 es
      void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.0-1.0,0,1);}`);
    const fragment=compile(gl.FRAGMENT_SHADER,`#version 300 es
      precision highp float;
      uniform sampler2D source;
      uniform vec2 size;
      uniform int count;
      uniform vec4 linear[64];
      uniform vec2 offset[64];
      uniform vec4 crop;
      out vec4 colour;
      void main(){
        vec2 point=vec2(gl_FragCoord.x,size.y-gl_FragCoord.y);vec4 sum=vec4(0);
        for(int i=0;i<64;i++){
          if(i>=count)break;
          vec2 p=vec2(dot(linear[i].xy,point),dot(linear[i].zw,point))+offset[i];
          if(p.x>=crop.x&&p.y>=crop.y&&p.x<crop.z&&p.y<crop.w)sum+=texture(source,p/size);
        }
        colour=sum/float(count);
      }`);
    if(vertex&&fragment){program=gl.createProgram()!;gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS)){gl.deleteProgram(program);program=null;}}
    if(vertex)gl.deleteShader(vertex);if(fragment)gl.deleteShader(fragment);
    if(program){texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);}
  }
  const uniforms=gl&&program?Object.fromEntries(['source','size','count','linear[0]','offset[0]','crop'].map(name=>[name,gl.getUniformLocation(program!,name)])):null;
  return {
    draw(source:HTMLCanvasElement,poses:MotionPose[],clip:Clip,width:number,height:number,projectWidth:number,projectHeight:number):HTMLCanvasElement {
      if(!gl||!program||!uniforms||lost||gl.isContextLost()){
        if(software.width!==width||software.height!==height){software.width=scratch.width=width;software.height=scratch.height=height;}
        drawMotionBlur(software.getContext('2d')!,source,poses,clip,width,height,projectWidth,projectHeight,scratch.getContext('2d',{willReadFrequently:true})!);
        return software;
      }
      if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
      gl.viewport(0,0,width,height);gl.useProgram(program);gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,true);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,source);
      const linear=new Float32Array(poses.length*4),offset=new Float32Array(poses.length*2);
      poses.forEach((pose,i)=>{
        const c=Math.cos(pose.rotation),s=Math.sin(pose.rotation),a=c/pose.scaleX,b=s/pose.scaleX,d=-s/pose.scaleY,e=c/pose.scaleY;
        const x=width/2+pose.x*width/projectWidth,y=height/2+pose.y*height/projectHeight;
        linear.set([a,b,d,e],i*4);offset.set([width/2-a*x-b*y,height/2-d*x-e*y],i*2);
      });
      const p=clip.properties;
      gl.uniform1i(uniforms.source,0);gl.uniform2f(uniforms.size,width,height);gl.uniform1i(uniforms.count,poses.length);
      gl.uniform4fv(uniforms['linear[0]'],linear);gl.uniform2fv(uniforms['offset[0]'],offset);
      gl.uniform4f(uniforms.crop,Math.max(0,Number(p.cropLeft??0))*width/projectWidth,Math.max(0,Number(p.cropTop??0))*height/projectHeight,Math.min(width,width-Number(p.cropRight??0)*width/projectWidth),Math.min(height,height-Number(p.cropBottom??0)*height/projectHeight));
      gl.drawArrays(gl.TRIANGLES,0,3);
      return canvas;
    },
    dispose(){if(gl){gl.deleteTexture(texture);gl.deleteProgram(program);gl.getExtension('WEBGL_lose_context')?.loseContext();}},
  };
}
