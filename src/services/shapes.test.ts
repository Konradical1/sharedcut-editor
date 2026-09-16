import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { defaultShape, drawShape, fitPenPoints, shapeKinds, shapePath, validateShape } from './shapes.ts';

test('every shape renders; Bézier points retain their frame positions when fitted',()=>{
  const canvas=createCanvas(320,180),ctx=canvas.getContext('2d');
  for(const kind of shapeKinds.filter(k=>k!=='pen')){
    const doc={...defaultShape(kind),fillMode:'linear' as const,shadowOpacity:40};validateShape(doc);ctx.clearRect(0,0,320,180);drawShape(ctx as unknown as CanvasRenderingContext2D,doc,320,180,1920,1080);
    assert.ok(ctx.getImageData(0,0,320,180).data.some((n,i)=>i%4===3&&n>0),kind);
  }
  const pen=fitPenPoints([{x:.2,y:.3,outX:.4,outY:.1},{x:.8,y:.6,inX:.6,inY:.8}],false);validateShape(pen);
  assert.ok(Math.abs(pen.x+pen.points[0].outX!*pen.width-.4)<1e-10);
  assert.ok(shapePath(pen,1920,1080).includes('C'));
  assert.throws(()=>validateShape({...pen,points:[{x:NaN,y:0}]}));
  assert.throws(()=>validateShape({...pen,fill:'url(https://example.com)'}));
  assert.throws(()=>validateShape({...pen,points:[{x:0,y:0,inX:.4}]}));
});
