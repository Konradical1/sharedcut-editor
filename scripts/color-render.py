"""Float scene processing; ACES display rendering is native OpenColorIO, not a baked LUT."""
import bisect, json, os, signal, subprocess, sys
import numpy as np
import PyOpenColorIO as ocio
if ocio.__version__!='2.5.2': raise RuntimeError('This reference pipeline requires OpenColorIO 2.5.2; run npm run setup:color.')
CONFIG='studio-config-v4.0.0_aces-v2.0_ocio-v2.5'
VIEW='ACES 2.0 - SDR 100 nits (Rec.709)'
config=ocio.Config.CreateFromBuiltinConfig(CONFIG)
display=config.getProcessor('Linear Rec.709 (sRGB)','Rec.1886 Rec.709 - Display',VIEW,ocio.TRANSFORM_DIR_FORWARD).getDefaultCPUProcessor()

def decode(v,p):
    if p=='Linear': return v
    if p=='Gamma 2.4': return np.sign(v)*np.abs(v)**2.4
    if p=='Rec.709': return np.maximum(v,0)**2.4
    if p=='DaVinci Intermediate': return np.where(v>.02740668,2**(v/.07329248-7)-.0075,v/10.44426855)
    if p=='S-Log3': return np.where(v>=171.2102946929/1023,10**((v*1023-420)/261.5)*.19-.01,(v*1023-95)*.01125/(171.2102946929-95))
    if p in ['S-Log','S-Log2']:
        x=(v*1023-64)/876
        return np.where(x>=.030001222851889303,10**((x-.646596)/.432699)-.037584,(x-.030001222851889303)/5)*.9*(219/155 if p=='S-Log2' else 1)
    if p in ['Canon Log','Canon Log 2']:
        a,b,c=(.529136,.0730597,10.1596) if p=='Canon Log' else (.281863093,.035388128,87.09937546)
        return np.sign(v-b)*(10**(np.abs(v-b)/a)-1)/c*.9
    if p=='Canon Log 3': return .9*np.where(v<.04076162,-(10**((.07623209-v)/.42889912)-1)/14.98325,np.where(v<=.105357102,(v-.073059361)/2.3069815,(10**((v-.069886632)/.42889912)-1)/14.98325))
    raise ValueError('Unsupported gamma: '+p)

def encode(v,p):
    if p=='Linear': return v
    if p=='Gamma 2.4': return np.sign(v)*np.abs(v)**(1/2.4)
    if p=='Rec.709': return np.maximum(v,0)**(1/2.4)
    if p=='DaVinci Intermediate': return np.where(v>.00262409,(np.log2(v+.0075)+7)*.07329248,v*10.44426855)
    if p=='S-Log3': return np.where(v>=.01125,(420+np.log10((v+.01)/.19)*261.5)/1023,(v*(171.2102946929-95)/.01125+95)/1023)
    if p in ['S-Log','S-Log2']:
        x=v/.9*(155/219 if p=='S-Log2' else 1)
        return (np.where(x>=0,.432699*np.log10(x+.037584)+.646596,x*5+.030001222851889303)*876+64)/1023
    if p in ['Canon Log','Canon Log 2']:
        a,b,c=(.529136,.0730597,10.1596) if p=='Canon Log' else (.281863093,.035388128,87.09937546)
        return np.sign(v)*a*np.log10(c*np.abs(v)/.9+1)+b
    if p=='Canon Log 3':
        x=v/.9
        return np.where(x<-.014,-.42889912*np.log10(-x*14.98325+1)+.07623209,np.where(x<=.014,2.3069815*x+.073059361,.42889912*np.log10(x*14.98325+1)+.069886632))
    raise ValueError('Unsupported gamma: '+p)

def curve(v,c):
    points=c['points'];x=np.array([p['x'] for p in points]);y=np.array([p['y'] for p in points]);sec=np.diff(y)/np.diff(x)
    slopes=[points[i].get('slope',sec[0] if i==0 else sec[-1] if i==len(x)-1 else 0 if sec[i-1]*sec[i]<=0 else 2*sec[i-1]*sec[i]/(sec[i-1]+sec[i])) for i in range(len(x))]
    slopes=np.array(slopes);i=np.clip(np.searchsorted(x,v)-1,0,len(x)-2);h=x[i+1]-x[i];t=(v-x[i])/h
    result=y[i]+(y[i+1]-y[i])*t if c['mode']=='linear' else (2*t**3-3*t*t+1)*y[i]+(t**3-2*t*t+t)*h*slopes[i]+(-2*t**3+3*t*t)*y[i+1]+(t**3-t*t)*h*slopes[i+1]
    return np.where(v<x[0],y[0]+(v-x[0])*slopes[0],np.where(v>x[-1],y[-1]+(v-x[-1])*slopes[-1],result))

def lut(rgb,e):
    c=e['cube'];n=c['size'];table=np.array(c['data']).reshape(n,n,n,3);pos=np.clip((rgb-c['min'])/(np.array(c['max'])-c['min']),0,1)*(n-1);lo=np.minimum(n-2,np.floor(pos)).astype(int);f=pos-lo;result=np.zeros_like(rgb)
    for b in range(2):
        for g in range(2):
            for r in range(2):
                w=np.prod(np.where(np.array([r,g,b]),f,1-f),axis=-1,keepdims=True);at=lo+[r,g,b];result+=table[at[...,2],at[...,1],at[...,0]]*w
    return rgb+(result-rgb)*e['amount']

def grade(rgb,stages,masks=None,managed=True):
    def blend(result,before,stage):
        binding=stage.get('node',{}).get('mask')
        if not stage.get('nodeEnd',True) or not binding or not binding['enabled']: return result
        if not binding['amount']: return before
        if masks is None or binding['id'] not in masks: raise ValueError('Missing spatial node mask')
        alpha=masks[binding['id']][...,None]
        return before+(result-before)*(1-alpha if binding['invert'] else alpha)*binding['amount']/100
    before=rgb.copy()
    # Inactive np.where branches may log a negative value; selected results are checked below.
    with np.errstate(invalid='ignore',divide='ignore',over='ignore'):
        for s in stages:
            if s.get('nodeStart',True): before=rgb.copy()
            if s['type']=='cst':
                e=s['effect'];linear=decode(rgb,e['inputGamma'])@np.array(s['matrix']).T
                if e['toneMapping']=='aces2':
                    rgb=np.ascontiguousarray(linear,dtype=np.float32);display.applyRGB(rgb);continue
                if e['toneMapping']=='shoulder':
                    peak=np.maximum(0,np.max(linear,axis=-1,keepdims=True));mapped=np.where(peak<=.6,peak,.6+.4*(1-np.exp(-(peak-.6)/.4)))
                    linear*=np.divide(mapped,peak,out=np.ones_like(peak),where=peak>0)
                if e['gamutMapping']=='compress':
                    y=np.clip(linear@np.array(s['weights']),0,1)[...,None];delta=linear-y
                    limits=np.where(delta>0,(1-y)/delta,np.where(delta<0,-y/delta,1));amount=np.minimum(1,np.min(limits,axis=-1,keepdims=True));linear=y+delta*amount
                rgb=encode(linear,e['outputGamma']);continue
            if s['type']=='lut':
                rgb=blend(lut(rgb,s['effect']),before,s);continue
            g=s['g'];p=s['extra'];gamma=s['gamma'];channels='RGB'
            if managed:
                if g['exposure'] or g['temperature'] or g['tint']: rgb=encode(decode(rgb,gamma)*2**g['exposure']*np.array([1+g['temperature']/10000,1-g['tint']/200,1-g['temperature']/10000]),gamma)
                v=rgb;x=(v-g['pivot'])*g['contrast']+g['pivot']+g['offset']+np.array([p.get('offset'+c,0) for c in channels])
                rgb=np.sign(x)*np.abs(x)**(1/2**(g['gamma']+np.array([p.get('gamma'+c,0) for c in channels])))*(g['gain']+np.array([p.get('gain'+c,0) for c in channels]))+(g['lift']+np.array([p.get('lift'+c,0) for c in channels]))*(1-v)
                y=(rgb@np.array(s['weights']))[...,None];rgb=y+(rgb-y)*g['saturation']
            else:
                v=np.maximum(0,rgb*2**g['exposure']);x=(v-g['pivot'])*g['contrast']+g['pivot']+g['offset']+np.array([p.get('offset'+c,0) for c in channels])
                rgb=np.maximum(0,x)**(1/2**(g['gamma']+np.array([p.get('gamma'+c,0) for c in channels])))*(g['gain']+np.array([p.get('gain'+c,0) for c in channels]))+(g['lift']+np.array([p.get('lift'+c,0) for c in channels]))*(1-np.minimum(1,v))
                y=(rgb@np.array([.2126,.7152,.0722]))[...,None];rgb=(y+(rgb-y)*g['saturation'])*np.array([1+np.clip(g['temperature']/10000,-.5,.5),1-np.clip(g['tint']/200,-.5,.5),1-np.clip(g['temperature']/10000,-.5,.5)])
            curves=s['node'].get('curves')
            if curves is not None:
                if 'RGB' in curves: rgb=curve(rgb,curves['RGB'])
                for i,c in enumerate(channels):
                    if c in curves: rgb[...,i]=curve(rgb[...,i],curves[c])
            elif any(k.startswith('curve') for k in p): rgb=np.interp(np.clip(rgb,0,1),[0,.25,.5,.75,1],[0,p.get('curve25',.25),p.get('curve50',.5),p.get('curve75',.75),1])
            rgb=blend(rgb,before,s)
    if not np.isfinite(rgb).all(): raise ValueError('Color grade produced non-finite pixels')
    return rgb

def frame_read(stream,size):
    data=bytearray()
    while len(data)<size:
        part=stream.read(size-len(data))
        if not part: break
        data.extend(part)
    if data and len(data)!=size: raise ValueError('Truncated color frame')
    return data

def process_frames(source,target,job,mask_targets=None):
    w,h=job['width'],job['height'];count=0;channels=4 if job.get('alpha') else 3
    masks=job.get('masks',[]);cached={}
    while data:=frame_read(source,w*h*channels*4):
        planes=np.frombuffer(data,dtype='<f4').reshape(channels,h,w)
        rgb=np.ascontiguousarray(planes[[2,0,1]].transpose(1,2,0))
        times=job.get('frameTimes');time=times[count] if times and count<len(times) else job.get('seek',0)+count/float(job.get('numericFps',24))
        alphas={}
        for mask in masks:
            doc=mask['document'];index=max(0,bisect.bisect_right(mask['sourceTimes'],time+1e-7)-1)
            if time<doc['range']['start']-1e-7 or time>=doc['range']['end']-1e-7: alpha=np.zeros((h,w),dtype=np.float32)
            else:
                frame=mask['files'].get(str(index))
                if frame is None: raise ValueError('Smart Mask has no analyzed alpha for source frame '+str(index))
                cache=cached.get(doc['id'])
                if not cache or cache[0]!=index:
                    # One trusted lossless frame per mask is retained. Stream PNG decoding if this I/O becomes limiting.
                    decoded=subprocess.run([job.get('ffmpeg','ffmpeg'),'-v','error','-threads','1','-i',frame,'-frames:v','1','-vf','format=gray16le','-f','rawvideo','-'],capture_output=True,check=True).stdout
                    if len(decoded)!=w*h*2: raise ValueError('Smart Mask dimensions differ from the source image')
                    alpha=np.frombuffer(decoded,dtype='<u2').reshape(h,w).astype(np.float32)/65535
                    cached[doc['id']]=(index,alpha)
                else: alpha=cache[1]
            alphas[doc['id']]=alpha
            if mask_targets and doc['id'] in mask_targets: mask_targets[doc['id']].write(np.rint(np.clip(alpha,0,1)*65535).astype('<u2').tobytes())
        for row in range(0,h,128):
            values=rgb[row:row+128]
            if job.get('inputCube'): values=lut(values,{'cube':job['inputCube'],'amount':1})
            rgb[row:row+128]=grade(values,job['stages'],{id:a[row:row+128] for id,a in alphas.items()},job.get('managed',True))
        output=np.ascontiguousarray(rgb.transpose(2,0,1)[[1,2,0]],dtype='<f4')
        if channels==4: output=np.concatenate([output,planes[3:4]])
        target.write(output.tobytes());count+=1
        if count%12==0: print(json.dumps({'progress':min(99,count/job.get('frames',count)*100)}),file=sys.stderr,flush=True)
    if not count: raise ValueError('No decoded color frames')
    if job.get('frameTimes') and count!=len(job['frameTimes']): raise ValueError('Decoded source frames do not match Smart Mask timestamps')

def render(job):
    ff=job.get('ffmpeg','ffmpeg');children=[];mask_targets={};pixel_format='gbrapf32le' if job.get('alpha') else 'gbrpf32le'
    def stop(*_):
        for p in children:
            if p.poll() is None: p.terminate()
        raise InterruptedError('Color render canceled')
    signal.signal(signal.SIGTERM,stop)
    try:
        input_args=['-loop','1','-framerate',str(job['fps'])] if job.get('image') else ['-ss',str(job['seek'])]
        decoder=subprocess.Popen([ff,'-v','error','-threads','2','-filter_threads','1',*input_args,'-i',job['input'],'-t',str(job['duration']),'-an','-vf',f"scale=in_color_matrix={job['matrix']}:in_range={job['range']},format={pixel_format}",'-fps_mode','passthrough','-f','rawvideo','-'],stdout=subprocess.PIPE);children.append(decoder)
        encoder=subprocess.Popen([ff,'-v','error','-y','-threads','2','-filter_threads','1','-f','rawvideo','-pixel_format',pixel_format,'-video_size',f"{job['width']}x{job['height']}",'-framerate',str(job['fps']),'-i','-','-vf','format=gbrap16le' if job.get('alpha') else 'format=gbrp16le','-c:v','ffv1','-threads','2','-level','3','-color_range','pc','-colorspace','rgb','-color_primaries','bt709','-color_trc','bt709',job['output']],stdin=subprocess.PIPE);children.append(encoder)
        for mask in job.get('masks',[]):
            if not mask.get('output'): continue
            p=subprocess.Popen([ff,'-v','error','-y','-threads','1','-f','rawvideo','-pixel_format','gray16le','-video_size',f"{job['width']}x{job['height']}",'-framerate',str(job['fps']),'-i','-','-c:v','ffv1','-level','3','-color_range','pc',mask['output']],stdin=subprocess.PIPE)
            children.append(p);mask_targets[mask['document']['id']]=p.stdin
        process_frames(decoder.stdout,encoder.stdin,job,mask_targets);encoder.stdin.close();decoder.stdout.close()
        for stream in mask_targets.values(): stream.close()
        if any(p.wait()!=0 for p in children): raise RuntimeError('Color/mask decode or encode failed')
    finally:
        for p in children:
            if p.poll() is None: p.terminate()
        for p in children:
            try: p.wait(timeout=5)
            except subprocess.TimeoutExpired: p.kill();p.wait()

if __name__=='__main__':
    if sys.argv[1:]==['--check']:
        print(json.dumps({'ocio':ocio.__version__,'config':CONFIG,'view':VIEW}));sys.exit(0)
    job=json.loads(open(sys.argv[1]).read())
    if '--stream' in sys.argv: process_frames(sys.stdin.buffer,sys.stdout.buffer,job)
    else: render(job)
