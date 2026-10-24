"""Float scene processing; ACES display rendering is native OpenColorIO, not a baked LUT.
The v3 grade (docs/color-grading-v3.md) ports src/services/grading.ts and filmLook.ts: per-pixel steps in grade(), film and the
Dehaze/Clarity maps on whole frames in grade_frame(). Everything stays float32; gradingRender.test.ts holds it to the CPU reference."""
import bisect, itertools, json, math, os, signal, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
import numpy as np
import PyOpenColorIO as ocio
if ocio.__version__!='2.5.2': raise RuntimeError('This reference pipeline requires OpenColorIO 2.5.2; run npm run setup:color.')
CONFIG='studio-config-v4.0.0_aces-v2.0_ocio-v2.5'
VIEW='ACES 2.0 - SDR 100 nits (Rec.709)'
config=ocio.Config.CreateFromBuiltinConfig(CONFIG)
display=config.getProcessor('Linear Rec.709 (sRGB)','Rec.1886 Rec.709 - Display',VIEW,ocio.TRANSFORM_DIR_FORWARD).getDefaultCPUProcessor()
STRIPE=64
# GRADE_PARAMS initial values the engine reads when a node leaves a key out (gradingRender.test.ts compares them with grading.ts).
DEFAULTS={'logLowRange':.333,'logHighRange':.55,'qualHue':0,'qualHueWidth':360,'qualHueSoft':20,'qualSatLow':0,'qualSatHigh':100,'qualSatSoft':10,'qualLumLow':0,'qualLumHigh':100,'qualLumSoft':10,
  'circX':.5,'circY':.5,'circW':.3,'circH':.3,'circAngle':0,'circSoft':.1,'rectX':.5,'rectY':.5,'rectW':.6,'rectH':.4,'rectAngle':0,'rectSoft':.05,'rectRound':0,
  'gradX':.5,'gradY':.5,'gradAngle':0,'gradSoft':.3,**{f'mix{r}{c}':float(r==c) for r in 'RGB' for c in 'RGB'}}
HSL_CURVES=('HueHue','HueSat','HueLum','LumSat','SatSat','SatLum')
MIX=[f'mix{r}{c}' for r in 'RGB' for c in 'RGB']
M32=0xFFFFFFFF

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
        a,b,c=(.529136,.0730597,10.1596) if p=='Canon Log' else (.281863093,.035388128,87.09937546);ire=(v*1023-64)/876
        return np.sign(ire-b)*(10**(np.abs(ire-b)/a)-1)/c*.9
    if p=='Canon Log 3':
        ire=(v*1023-64)/876  # Canon IRE curve on code values: black 128/1023, as the ACES IDT
        return .9*np.where(ire<.04076162,-(10**((.07623209-ire)/.42889912)-1)/14.98325,np.where(ire<=.105357102,(ire-.073059361)/2.3069815,(10**((ire-.069886632)/.42889912)-1)/14.98325))
    if p=='Apple Log':
        x=(v*1023-64)/876  # Apple Log Profile on the video-range scale; mirrored below code 64 as decodeLog
        return np.where(x>=.208555316,2**((x-.69336945)/.08550479)-.00964052,np.sign(x)*np.sqrt(np.abs(x)/47.28711236)-.05641088)
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
        return ((np.sign(v)*a*np.log10(c*np.abs(v)/.9+1)+b)*876+64)/1023
    if p=='Canon Log 3':
        x=v/.9
        return (np.where(x<-.014,-.42889912*np.log10(-x*14.98325+1)+.07623209,np.where(x<=.014,2.3069815*x+.073059361,.42889912*np.log10(x*14.98325+1)+.069886632))*876+64)/1023
    if p=='Apple Log':
        d=v+.05641088
        return (np.where(v>=.01,.08550479*np.log2(np.maximum(v,.01)+.00964052)+.69336945,47.28711236*d*np.abs(d))*876+64)/1023
    raise ValueError('Unsupported gamma: '+p)

def curve(v,c):
    points=c['points'];x=np.array([p['x'] for p in points]);y=np.array([p['y'] for p in points]);sec=np.diff(y)/np.diff(x)
    slopes=[points[i].get('slope',sec[0] if i==0 else sec[-1] if i==len(x)-1 else 0 if sec[i-1]*sec[i]<=0 else 2*sec[i-1]*sec[i]/(sec[i-1]+sec[i])) for i in range(len(x))]
    x,y,slopes=(np.asarray(a,np.float32) for a in (x,y,slopes))
    i=np.clip(np.searchsorted(x,v)-1,0,len(x)-2);h=x[i+1]-x[i];t=(v-x[i])/h
    result=y[i]+(y[i+1]-y[i])*t if c['mode']=='linear' else (2*t**3-3*t*t+1)*y[i]+(t**3-2*t*t+t)*h*slopes[i]+(-2*t**3+3*t*t)*y[i+1]+(t**3-t*t)*h*slopes[i+1]
    return np.where(v<x[0],y[0]+(v-x[0])*slopes[0],np.where(v>x[-1],y[-1]+(v-x[-1])*slopes[-1],result))

def periodic(c):
    """periodicCurve: one period of points wrapped onto each side, so a hue curve is smooth across red."""
    p=c['points'];return {**c,'points':[{**p[-2],'x':p[-2]['x']-1},*p,{**p[1],'x':p[1]['x']+1}]}

def lut(rgb,e):
    c=e['cube'];n=c['size']
    # Converted once per cube: a 65³ table converted from its JSON list on every stripe of every frame cost ~0.4 s of CPU a 4K frame.
    table=c.get('_table')
    if table is None: table=c['_table']=np.asarray(c['data'],np.float32).reshape(n,n,n,3)
    pos=np.clip((rgb-np.asarray(c['min'],np.float32))/(np.asarray(c['max'],np.float32)-np.asarray(c['min'],np.float32)),0,1)*(n-1);lo=np.minimum(n-2,np.floor(pos)).astype(int);f=pos-lo;result=np.zeros_like(rgb)
    for b in range(2):
        for g in range(2):
            for r in range(2):
                w=np.prod(np.where(np.array([r,g,b]),f,1-f),axis=-1,keepdims=True);at=lo+[r,g,b];result+=table[at[...,2],at[...,1],at[...,0]]*w
    return rgb+(result-rgb)*e['amount']

def smoothstep(a,b,x):
    t=np.clip((x-a)/(b-a),0,1); return t*t*(3-2*t)
def sse(a,b,x):
    """Smoothstep, or a hard step at a when the edge has no width (grading.ts sse)."""
    return smoothstep(a,b,x) if b>a else (x>=a).astype(x.dtype if isinstance(x,np.ndarray) else np.float32)
def val(p,key):
    v=p.get(key);return DEFAULTS[key] if v is None else v
def on(v): return (0 if v is None else v)>=.5
def has_window(p): return on(p.get('circOn')) or on(p.get('rectOn')) or on(p.get('gradOn'))
def js_round(x): return math.floor(x+.5)
def luma(rgb,w): return rgb[...,0]*w[0]+rgb[...,1]*w[1]+rgb[...,2]*w[2]

def range_saturation(rgb,w,p):
    """rangeSaturation in color.ts: saturationShadows/Midtones/Highlights (percent) by luma, after the node's saturation."""
    s,m,h=(p.get('saturation'+k,100)/100-1 for k in ('Shadows','Midtones','Highlights'))
    if not (s or m or h): return rgb
    y=luma(rgb,w)[...,None];ws=1-smoothstep(0,.5,y);wh=smoothstep(.5,1,y)
    return y+(rgb-y)*(1+ws*s+(1-ws-wh)*m+wh*h)

# ---- v3 per-pixel steps: ports of grading.ts tonal, chroma, hslCurves, mixer, qualifierAlpha, windowAlpha -----------------
def opponent(rgb,w):
    y=luma(rgb,w);return y,(rgb[...,2]-y)/(2*(1-w[2])),(rgb[...,0]-y)/(2*(1-w[0]))
def from_opponent(y,cb,cr,w):
    r=y+2*(1-w[0])*cr;b=y+2*(1-w[2])*cb;return np.stack([r,(y-w[0]*r-w[2]*b)/w[1],b],-1)
def hue_of(cb,cr,w):
    """Hue in turns, red 0; grey (s < 1e-6) is 0 as in every engine."""
    h=(np.arctan2(cr,cb)-math.atan2(.5,-w[0]/(2*(1-w[2]))))/(2*math.pi);h=h-np.floor(h)
    return np.where(2*np.hypot(cb,cr)<1e-6,0,h).astype(np.float32)
def rotate(cb,cr,turn):
    c,s=np.cos(turn),np.sin(turn);return cb*c-cr*s,cb*s+cr*c

def tonal(rgb,w,p,pivot):
    """Log wheels, then the Shadows/Highlights sliders split at the node's contrast pivot."""
    ranges=[np.array([p.get('log'+r,0)+p.get('log'+r+c,0) for c in 'RGB'],np.float32) for r in ('Shadow','Mid','Highlight')]
    if any(a.any() for a in ranges):
        t=np.clip(luma(rgb,w),0,1)[...,None];lo,hi=val(p,'logLowRange'),val(p,'logHighRange')
        ws=1-smoothstep(lo-.1,lo+.1,t);wh=smoothstep(hi-.1,hi+.1,t);wm=np.maximum(0,1-ws-wh)
        rgb=rgb+ws*ranges[0]+wm*ranges[1]+wh*ranges[2]
    sh,hl=p.get('shadows',0),p.get('highlights',0)
    if sh or hl:
        t=np.clip(luma(rgb,w),0,1);m=min(.95,max(.05,pivot));u=np.where(t<m,t/m,(1-t)/(1-m));bump=u*(1-u)**2
        d=np.where(t<m,sh/100*(2 if sh>0 else 1)*m*bump,np.where(t>m,hl/100*(2 if hl<0 else 1)*(1-m)*bump,0)).astype(np.float32)
        rgb=rgb+d[...,None]
    return rgb

def chroma(rgb,w,p):
    """Hue rotation, Color Boost and Density, after saturation."""
    hue,boost,density=p.get('hue',0),p.get('boost',0),p.get('density',0)
    if not (hue or boost or density): return rgb
    y,cb,cr=opponent(rgb,w)
    if hue: cb,cr=rotate(cb,cr,hue*math.pi/180)
    s=np.clip(2*np.hypot(cb,cr),0,1)
    if boost: f=1+boost/100*(1-s);cb=cb*f;cr=cr*f
    if density: y=y-density/100*.2*s
    return from_opponent(y,cb,cr,w)

def hsl_curves(rgb,w,curves):
    """Hue vs Hue/Sat/Lum, Lum vs Sat, Sat vs Sat/Lum, all read from the colour after the custom curves."""
    if not curves or not any(curves.get(k) for k in HSL_CURVES): return rgb
    y,cb,cr=opponent(rgb,w);s0=2*np.hypot(cb,cr);sc=np.clip(s0,0,1);h0=hue_of(cb,cr,w);t0=np.clip(y,0,1)
    H=lambda k:curve(h0,periodic(curves[k])) if curves.get(k) else .5
    C=lambda k,x:curve(x,curves[k]) if curves.get(k) else .5
    if curves.get('HueHue'): cb,cr=rotate(cb,cr,(H('HueHue')-.5)*2*math.pi)
    gain=2*H('HueSat')*2*C('LumSat',t0)*2*C('SatSat',sc);cb=cb*gain;cr=cr*gain
    y=y+(H('HueLum')-.5)*.5*smoothstep(0,.15,s0)+(C('SatLum',sc)-.5)*.5
    return from_opponent(y,cb,cr,w)

def mixer(rgb,p):
    m=[val(p,k) for k in MIX];mono=on(p.get('mixMono'))
    if not mono and m==[1,0,0,0,1,0,0,0,1]: return rgb
    out=np.stack([m[r*3]*rgb[...,0]+m[r*3+1]*rgb[...,1]+m[r*3+2]*rgb[...,2] for r in range(3)],-1)
    return np.repeat(out[...,:1],3,-1) if mono else out

def qualifier_alpha(rgb,w,p):
    """HSL key of the node's input colour; None when the qualifier is off (alpha 1)."""
    if not on(p.get('qualOn')): return None
    y,cb,cr=opponent(rgb,w);s=2*np.hypot(cb,cr);width=val(p,'qualHueWidth');k=1
    if width<360:
        d=np.abs(hue_of(cb,cr,w)*360-val(p,'qualHue'))%360;d=np.minimum(d,360-d);k=1-sse(width/2,width/2+val(p,'qualHueSoft'),d)
    band=lambda x,low,high,soft:(1 if low<=0 else sse(low-soft,low,x))*(1 if high>=100 else 1-sse(high,high+soft,x))
    a=k*band(np.clip(s,0,1)*100,val(p,'qualSatLow'),val(p,'qualSatHigh'),val(p,'qualSatSoft'))*band(np.clip(y,0,1)*100,val(p,'qualLumLow'),val(p,'qualLumHigh'),val(p,'qualLumSoft'))
    a=np.broadcast_to(np.asarray(a,np.float32),y.shape)
    return 1-a if on(p.get('qualInvert')) else a

def window_alpha(p,coords,shape):
    """Union of the node's windows for a stripe: coords = (first row, frame height, frame width), pixel centres at (x+.5)/W, (row+.5)/H."""
    if coords is None: raise ValueError('A window needs pixel positions; it cannot be baked into an RGB LUT.')
    row,height,width=coords;aspect=width/height
    px=((np.arange(shape[1])+.5)/width)[None,:];py=((row+np.arange(shape[0])+.5)/height)[:,None]
    keep=np.ones(shape[:2])
    def local(cx,cy,angle):
        X=(px-cx)*aspect;Y=py-cy;a=angle*math.pi/180;c,s=math.cos(a),math.sin(a);return X*c+Y*s,-X*s+Y*c
    def add(a,invert):
        nonlocal keep;keep=keep*(1-(1-a if invert else a))
    if on(p.get('circOn')):
        u,v=local(val(p,'circX'),val(p,'circY'),val(p,'circAngle'));rw,rh=val(p,'circW'),val(p,'circH');k=val(p,'circSoft')/min(rw,rh)
        add(1-sse(1-k/2,1+k/2,np.hypot(u/rw,v/rh)),on(p.get('circInvert')))
    if on(p.get('rectOn')):
        u,v=local(val(p,'rectX'),val(p,'rectY'),val(p,'rectAngle'));hw,hh=val(p,'rectW')/2,val(p,'rectH')/2;r=val(p,'rectRound')*min(hw,hh);soft=val(p,'rectSoft')
        qx=np.abs(u)-hw+r;qy=np.abs(v)-hh+r;sd=np.hypot(np.maximum(qx,0),np.maximum(qy,0))+np.minimum(np.maximum(qx,qy),0)-r
        add(1-sse(-soft/2,soft/2,sd),on(p.get('rectInvert')))
    if on(p.get('gradOn')):
        a=val(p,'gradAngle')*math.pi/180;soft=val(p,'gradSoft')
        add(sse(-soft/2,soft/2,(px-val(p,'gradX'))*aspect*math.sin(a)-(py-val(p,'gradY'))*math.cos(a)),on(p.get('gradInvert')))
    return (1-keep).astype(np.float32)

def grade(rgb,stages,masks=None,managed=True,coords=None):
    """Every per-pixel stage on rgb (any shape ending in 3). Film stages are skipped (grade_frame runs them on whole frames);
    a window needs `coords`, a Smart Mask or depth key its alpha in `masks`, a detail node its level-k maps there too."""
    def blend(result,before,stage,keyed):
        node=stage.get('node') or {};binding=node.get('mask');windows=has_window(node.get('parameters') or {})
        masked=bool(binding and binding['enabled'])
        if not stage.get('nodeEnd',True) or not masked and not windows and keyed is None: return result
        amount=np.ones(result.shape[:-1],np.float32) if keyed is None else keyed
        if masked:
            if not binding['amount']: return before
            key='depth:'+node['id'] if binding.get('source')=='depth' else binding['id']  # nodeMaskId in smartMask.ts
            if masks is None or key not in masks: raise ValueError('Missing spatial node mask')
            alpha=np.clip(masks[key],0,1);amount=amount*(1-alpha if binding['invert'] else alpha)*(binding['amount']/100)
        if windows: amount=amount*window_alpha(node['parameters'],coords,result.shape)
        return before+(result-before)*amount[...,None]
    before=rgb.copy();keyed=None
    # Inactive np.where branches may log a negative value; selected results are checked below.
    with np.errstate(invalid='ignore',divide='ignore',over='ignore'):
        for s in stages:
            if s['type']=='film': continue
            if s.get('nodeStart',True):
                before=rgb.copy();keyed=qualifier_alpha(rgb,[float(v) for v in s['weights']],s.get('extra') or {}) if s['type']=='correction' else None
            if s['type']=='cst':
                e=s['effect'];linear=decode(rgb,e['inputGamma'])@np.asarray(s['matrix'],np.float32).T
                if e['toneMapping']=='aces2':
                    rgb=np.ascontiguousarray(linear,dtype=np.float32);display.applyRGB(rgb);continue
                if e['toneMapping']=='shoulder':
                    peak=np.maximum(0,np.max(linear,axis=-1,keepdims=True));mapped=np.where(peak<=.6,peak,.6+.4*(1-np.exp(-(peak-.6)/.4)))
                    linear*=np.divide(mapped,peak,out=np.ones_like(peak),where=peak>0)
                if e['gamutMapping']=='compress':
                    y=np.clip(linear@np.asarray(s['weights'],np.float32),0,1)[...,None];delta=linear-y
                    limits=np.where(delta>0,(1-y)/delta,np.where(delta<0,-y/delta,1));amount=np.minimum(1,np.min(limits,axis=-1,keepdims=True));linear=y+delta*amount
                rgb=encode(linear,e['outputGamma']);continue
            if s['type']=='lut':
                rgb=blend(lut(rgb,s['effect']),before,s,keyed);continue
            g=s['g'];p=s['extra'];gamma=s['gamma'];channels='RGB';w=[float(v) for v in s['weights']]
            per=lambda key:np.array([p.get(key+c,0) for c in channels],np.float32);detail=detail_point(s)
            # Dehaze and Clarity first, in linear light: nodes-v2 inside the exposure/white balance step, legacy in the stage's encoding.
            if detail and not managed: rgb=encode(apply_detail(decode(rgb,gamma),w,*detail_at(masks,s,coords,rgb.shape),p),gamma)
            if managed:
                if detail or g['exposure'] or g['temperature'] or g['tint']:
                    lin=decode(rgb,gamma)*gain(g);rgb=encode(apply_detail(lin,w,*detail_at(masks,s,coords,rgb.shape),p) if detail else lin,gamma)
                # Neutral primaries (a CST node's) are skipped: the same pixels, about 170 ms less CPU a 4K frame each.
                if g['contrast']!=1 or g['offset'] or g['gamma'] or g['gain']!=1 or g['lift'] or any(p.get(k+c) for k in ('offset','gamma','gain','lift') for c in channels):
                    v=rgb;x=(v-g['pivot'])*g['contrast']+g['pivot']+g['offset']+per('offset')
                    rgb=np.sign(x)*np.abs(x)**(1/2**(g['gamma']+per('gamma')))*(g['gain']+per('gain'))+(g['lift']+per('lift'))*(1-v)
                rgb=tonal(rgb,w,p,g['pivot'])
                if g['saturation']!=1: y=luma(rgb,w)[...,None];rgb=y+(rgb-y)*g['saturation']
                rgb=chroma(range_saturation(rgb,w,p),w,p)
            else:
                v=np.maximum(0,rgb*2**g['exposure']);x=(v-g['pivot'])*g['contrast']+g['pivot']+g['offset']+per('offset')
                rgb=np.maximum(0,x)**(1/2**(g['gamma']+per('gamma')))*(g['gain']+per('gain'))+(g['lift']+per('lift'))*(1-np.minimum(1,v))
                rgb=tonal(rgb,w,p,g['pivot'])
                warm,tint=min(.5,max(-.5,g['temperature']/10000)),min(.5,max(-.5,g['tint']/200))
                y=luma(rgb,w)[...,None];rgb=chroma(range_saturation(y+(rgb-y)*g['saturation'],w,p),w,p)*np.array([1+warm,1-tint,1-warm],np.float32)
            curves=s['node'].get('curves')
            if curves is not None:
                if curves.get('RGB'): rgb=curve(rgb,curves['RGB'])
                # Never in place: with neutral primaries rgb can still be the caller's array (the assistant's cached frames).
                if any(curves.get(c) for c in channels): rgb=np.stack([curve(rgb[...,i],curves[c]) if curves.get(c) else rgb[...,i] for i,c in enumerate(channels)],-1)
            elif any(k.startswith('curve') for k in p): rgb=np.interp(np.clip(rgb,0,1),[0,.25,.5,.75,1],[0,p.get('curve25',.25),p.get('curve50',.5),p.get('curve75',.75),1]).astype(np.float32)
            rgb=blend(mixer(hsl_curves(rgb,w,curves),p),before,s,keyed)
    if not np.isfinite(rgb).all(): raise ValueError('Color grade produced non-finite pixels')
    return rgb

# ---- Film (filmLook.ts applyFilm): whole frames between per-pixel segments -------------------------------------------------
def hash32(x,y,k):
    h=((x*0x8da6b343)^(y*0xd8163841)^(k*0xcb1ab31f))&M32
    h^=h>>16;h=h*0x7feb352d&M32;h^=h>>15;h=h*0x846ca68b&M32;h^=h>>16
    return (h>>8)/16777216
def fade(t): return t*t*(3-2*t)
def value_noise1(t,k):
    i=math.floor(t);u=fade(t-i);a=hash32(i,0,k);return a+(hash32(i+1,0,k)-a)*u
def seed_key(seed): return js_round(seed)*0x01000193&M32
def grain_key(seed,frame,channel): return (seed_key(seed)^(frame*0x9E3779B9&M32)^((channel+1)*0x85EBCA6B&M32))&M32
def film_motion(p,frame):
    """Per-frame gate weave (picture heights) and breath (stops): filmMotion in grading.ts."""
    s=seed_key(p['filmGrainSeed']);weave=.003*p['filmWeave']/100
    return (weave*(2*value_noise1(frame/6,s^0xA136AAAD)-1),weave*(2*value_noise1(frame/6,s^0x27D4EB2F)-1),.08*p['filmBreath']/100*(2*value_noise1(frame/3,s^0x165667B1)-1))
def halation_tint(p,w):
    h=(p['filmHalationHue']%360+360)%360/60;sat=p['filmHalationSat']/100
    return [1-sat+sat*min(1,max(0,v)) for v in (abs(h-3)-1,2-abs(h-2),2-abs(h-4))]

def hash_grid(xs,ys,k):
    """hash32 over the integer lattice ys × xs (uint32, wrapping multiplies): float32 (len(ys), len(xs))."""
    h=(ys.astype(np.uint32)*np.uint32(0xd8163841))[:,None]^(xs.astype(np.uint32)*np.uint32(0x8da6b343))[None,:]^np.uint32(k*0xcb1ab31f&M32)
    h^=h>>16;h*=np.uint32(0x7feb352d);h^=h>>15;h*=np.uint32(0x846ca68b);h^=h>>16
    return (h>>8).astype(np.float32)*np.float32(1/16777216)
def value_noise_grid(lx,ly,k):
    """valueNoise2 at every (ly[i], lx[j]): corner hashes once per lattice point, smoothstep weights per row and column."""
    ix=np.floor(lx).astype(np.int64);iy=np.floor(ly).astype(np.int64);u=fade(lx-ix).astype(np.float32);v=fade(ly-iy).astype(np.float32)
    def lattice(i):
        # The whole span of cells, or only the ones a pixel reads when there are several cells per pixel (fine grain, small picture).
        if i[-1]-i[0]+2<=2*len(i): return np.arange(i[0],i[-1]+2),i-i[0],i-i[0]+1
        s,inverse=np.unique(np.concatenate([i,i+1]),return_inverse=True);return s,inverse[:len(i)],inverse[len(i):]
    (xs,x0,x1),(ys,y0,y1)=lattice(ix),lattice(iy);table=hash_grid(xs,ys,k)
    a=table[:,x0];rows=a+(table[:,x1]-a)*u
    a=rows[y0];return a+(rows[y1]-a)*v[:,None]
def grain_noise(lx,ly,k):
    return 1.6*(.7*(2*value_noise_grid(lx,ly,k)-1)+.3*(2*value_noise_grid(2.37*lx+17.1,2.37*ly+17.1,k^0x68E31DA4)-1))

def axis(n,m,coordinate):
    """Bilinear taps of n output samples read at source coordinates `coordinate` (clamped) on an axis of m texels."""
    x=np.clip(coordinate,0,m-1);lo=np.floor(x).astype(np.intp)
    return lo,np.minimum(lo+1,m-1),(x-lo).astype(np.float32)
def bilinear(height,width,h,w):
    """Resize (h,w) to (height,width) bilinearly with half-pixel centres and clamped edges, the browser canvas's upscale.
    resize(a, rows) returns only output rows `rows` (a slice), so callers can split the work."""
    y0,y1,fy=axis(height,h,(np.arange(height)+.5)*h/height-.5);x0,x1,fx=axis(width,w,(np.arange(width)+.5)*w/width-.5)
    def resize(a,rows=slice(None)):
        a0,a1,f=y0[rows],y1[rows],fy[rows];f=f.reshape(-1,*[1]*(a.ndim-1))
        r=a[a0]*(1-f)+a[a1]*f;g=fx.reshape(-1,*[1]*(a.ndim-2))
        return r[:,x0]*(1-g)+r[:,x1]*g
    return resize

def each(pool,work,height):
    return list((pool.map if pool else map)(work,range(0,height,STRIPE)))

def halve(a,pool=None):
    """2×2 box average, output size ceil(n/2), input indices clamped."""
    h,w=a.shape[:2];nh,nw=-(-h//2),-(-w//2);x0=np.arange(nw)*2;x1=np.minimum(x0+1,w-1);out=np.empty((nh,nw,*a.shape[2:]),np.float32)
    def rows(r):
        y=np.arange(r,min(nh,r+STRIPE))*2;top=a[y];bottom=a[np.minimum(y+1,h-1)]
        out[r:r+STRIPE]=(top[:,x0]+top[:,x1]+bottom[:,x0]+bottom[:,x1])/4
    each(pool,rows,nh);return out
def gauss(a,s,pool=None):
    """Separable Gaussian, radius ceil(3 s) taps, normalised, clamped edges (filmBlur's pass)."""
    radius=math.ceil(3*s);kernel=[math.exp(-(i*i)/(2*s*s)) for i in range(-radius,radius+1)];total=sum(kernel);h,w=a.shape[:2]
    def run(src,horizontal):
        out=np.empty_like(src)
        def rows(r):
            n=min(h,r+STRIPE)-r
            if horizontal: block=np.take(src[r:r+n],np.clip(np.arange(-radius,w+radius),0,w-1),axis=1);width=w
            else: block=src[np.clip(np.arange(r-radius,r+n+radius),0,h-1)];width=n
            acc=np.zeros((n,w,*a.shape[2:]),np.float32);tmp=np.empty_like(acc)
            for k,weight in enumerate(kernel):
                np.multiply(block[:,k:k+width] if horizontal else block[k:k+width],np.float32(weight),out=tmp);acc+=tmp
            out[r:r+n]=acc/np.float32(total)
        each(pool,rows,h);return out
    return run(run(a,True),False)
def film_blur(src,sigma,pool=None):
    """filmBlur: 2×2 halvings until sigma' is in [4, 8), the Gaussian, bilinear upsample with half-pixel centres."""
    if sigma<.5: return src
    levels=max(0,math.floor(math.log2(sigma/4)));data=src
    for _ in range(levels): data=halve(data,pool)
    blurred=gauss(data,sigma/2**levels,pool)
    if not levels: return blurred
    height,width=src.shape[:2];resize=bilinear(height,width,*blurred.shape[:2]);out=np.empty_like(src)
    def rows(r): out[r:r+STRIPE]=resize(blurred,slice(r,r+STRIPE))
    each(pool,rows,height);return out

def apply_film(rgb,stage,frame,pool=None):
    """applyFilm (filmLook.ts) on a whole (h, w, 3) picture in the stage's encoding, at source frame `frame`."""
    p,gamma=stage['p'],stage['gamma'];w=[float(v) for v in stage['weights']];height,width=rgb.shape[:2];aspect=width/height
    ox,oy,breath=film_motion(p,frame);ab=.004*p['filmAberration']/100
    halation,bloom,grain,vignette=p['filmHalation']>0,p['filmBloom']>0,p['filmGrain']>0,bool(p['filmVignette'])
    lin=np.empty((height,width,3),np.float32);hsrc=np.empty((height,width),np.float32) if halation else None;bsrc=np.empty_like(lin) if bloom else None
    shift=ox or oy or ab
    if shift:
        # 1-2. Gate weave and aberration move where each channel is read from (bilinear, clamped).
        taps=[(axis(height,height,(.5+((np.arange(height)+.5)/height-.5)*k-oy)*height-.5),axis(width,width,(.5+((np.arange(width)+.5)/width-.5)*k-ox/aspect)*width-.5)) for k in (1+ab,1,1-ab)]
    thr_h,thr_b=.18*2**p['filmHalationThreshold'],.18*2**p['filmBloomThreshold']
    def first(r):
        rs=slice(r,r+STRIPE)
        if shift:
            src=np.empty((min(height,r+STRIPE)-r,width,3),np.float32)
            for c,((y0,y1,fy),(x0,x1,fx)) in enumerate(taps):
                plane=rgb[...,c];f=fy[rs][:,None];top=plane[y0[rs]][:,x0];top1=plane[y0[rs]][:,x1];bottom=plane[y1[rs]][:,x0];bottom1=plane[y1[rs]][:,x1]
                top=top+(top1-top)*fx;bottom=bottom+(bottom1-bottom)*fx;src[...,c]=top+(bottom-top)*f
        else: src=rgb[rs]
        with np.errstate(invalid='ignore',divide='ignore',over='ignore'): l=np.asarray(decode(src,gamma),np.float32)
        lin[rs]=l;y=luma(l,w)
        if halation: hsrc[rs]=np.maximum(0,y-thr_h)
        if bloom: bsrc[rs]=l*(np.maximum(0,y-thr_b)/np.maximum(y,1e-4))[...,None]
    each(pool,first,height)
    hglow=film_blur(hsrc,p['filmHalationRadius']/100*height,pool) if halation else None
    bglow=film_blur(bsrc,p['filmBloomRadius']/100*height,pool) if bloom else None
    if halation: tint=np.array(halation_tint(p,w),np.float32)*np.float32(p['filmHalation']/100*.25)
    if bloom: warm=.3*p['filmBloomWarmth']/100;btint=np.array([1+warm,1,1-warm],np.float32)*np.float32(p['filmBloom']/100*.5)
    if vignette:
        ax=1+(aspect-1)*p['filmVignetteRoundness']/100;size=p['filmVignetteSize']/100;soft=max(.01,p['filmVignetteSoftness']/100);norm=math.sqrt(ax*ax+1)
        vx=(((np.arange(width)+.5)/width-.5)*2*ax)[None,:]
    if grain:
        r_=p['filmGrainResponse']/100;amp=.1*p['filmGrain']/100;color=p['filmGrainColor']/100;fg=0 if p['filmGrainStatic']>=.5 else frame;scale=1080/p['filmGrainSize']/height
        keys=[grain_key(p['filmGrainSeed'],fg,c) for c in range(4)];lx=(np.arange(width)+.5)*scale
    out=np.empty_like(lin)
    def second(r):
        rs=slice(r,r+STRIPE);o=lin[rs]
        if halation: o+=hglow[rs][...,None]*tint
        if bloom: o+=bglow[rs]*btint
        if breath: o*=np.float32(2**breath)
        if vignette:
            d=np.hypot(vx,(((np.arange(r,min(height,r+STRIPE))+.5)/height-.5)*2)[:,None])/norm
            o*=(2**(-2*p['filmVignette']/100*smoothstep(size,size+soft,d))).astype(np.float32)[...,None]
        with np.errstate(invalid='ignore',divide='ignore',over='ignore'): res=np.array(encode(o,gamma),np.float32)
        if grain:
            # 9. Grain on the encoded picture; its strength follows the encoded luma before any grain is added.
            ly=(np.arange(r,min(height,r+STRIPE))+.5)*scale;t=np.clip(luma(res,w),0,1);gain=amp*((1-r_)+r_*4*t*(1-t));mono=grain_noise(lx,ly,keys[3])
            if color:
                for c in range(3): res[...,c]+=gain*(mono+(grain_noise(lx,ly,keys[c])-mono)*np.float32(color))
            else: res+=(gain*mono)[...,None]
        out[rs]=res
    each(pool,second,height)
    if not np.isfinite(out).all(): raise ValueError('Film stage produced non-finite pixels')
    return out

# ---- Detail (filmLook.ts detailMaps/applyDetail): Dehaze and Clarity, docs/color-grading-v3.md -----------------------------
def detail_point(s):
    """A node whose correction (always its first stage) carries dehaze or clarity: its maps come from the whole picture entering it."""
    p=s.get('extra') or {};return s['type']=='correction' and s.get('nodeStart',True) and bool(p.get('dehaze') or p.get('clarity'))
def gain(g): e=2**g['exposure'];return np.array([e*(1+g['temperature']/10000),e*(1-g['tint']/200),e*(1-g['temperature']/10000)],np.float32)
def stops(x): return np.log2(np.maximum(x,0)+2**-10)-math.log2(.18)
def softcap(u): return u/np.sqrt(np.sqrt(1+(u/.8)**4))

def detail_maps(rgb,s,managed,pool=None):
    """Level-k maps of the node input: M1 = G(a_c, b_c, α, β), M2 = B2 = G(dk', lm·dk', dk'·vr, dk'·vb), from the linear picture
    grade() applies them to (decode·G on nodes-v2, the stage's encoding with G = 1 on legacy stages). Level and blurs are filmBlur's at σ = 2 % of the
    height. The source pass runs in even-row stripes halved at once (a 2×2 box never crosses one): a 4K frame never holds full-size maps."""
    height,width=rgb.shape[:2];w=[float(v) for v in s['weights']];sigma=.02*height;k=max(0,math.floor(math.log2(sigma/4)));sg=sigma/2**k
    SA=np.empty((-(-height//2),-(-width//2),4) if k else (height,width,4),np.float32);SB=np.empty((*SA.shape[:2],3),np.float32)
    def source(r):
        # SA = (l, l², lm, mx), SB = clamp(lin, 2⁻⁸, 1)⁻⁴ per channel (the soft dark channel's power mean), in log stops re 18 % grey.
        with np.errstate(invalid='ignore',divide='ignore',over='ignore'): lin=decode(rgb[r:r+STRIPE],s['gamma'])*(gain(s['g']) if managed else 1)
        mx=np.maximum(lin.max(-1),0);l,lm=stops(luma(lin,w)),stops(mx);q=1/np.clip(lin,2**-8,1);q=q*q;a,b=np.stack([l,l*l,lm,mx],-1),q*q
        if k: a,b,r=halve(a),halve(b),r//2
        SA[r:r+len(a)]=a;SB[r:r+len(b)]=b
    each(pool,source,height)
    for _ in range(k-1): SA,SB=halve(SA,pool),halve(SB,pool)
    # Soft minimum per channel (p = 4) on a quarter of the radius; the veil colour within ±.25 stop; bright texels out before any blur.
    sm=1/np.sqrt(np.sqrt(gauss(SB,sg/4,pool)));dk=sm.min(-1);vr,vb=np.log2(sm[...,0]/sm[...,1]),np.log2(sm[...,2]/sm[...,1])
    c=np.minimum(1,.25/np.maximum(np.sqrt(vr*vr+vb*vb),1e-6));vr,vb=vr*c,vb*c;dk=dk*(1-smoothstep(.25,.7,SA[...,3]));l,lm=SA[...,0],SA[...,2]
    B1=gauss(np.stack([l,SA[...,1],lm,lm*lm],-1),sg,pool);B2=gauss(np.stack([dk,lm*dk,dk*vr,dk*vb],-1),sg,pool)
    # Guided filters: clarity's base self-guided on l (eps (¼ stop)²), the haze map guided by lm (eps (½ stop)²).
    vl=np.maximum(B1[...,1]-B1[...,0]**2,0);vm=np.maximum(B1[...,3]-B1[...,2]**2,0);ac=vl/(vl+.0625);al=(B2[...,1]-B1[...,2]*B2[...,0])/(vm+.25)
    return gauss(np.stack([ac,(1-ac)*B1[...,0],al,B2[...,0]-al*B1[...,2]],-1),sg,pool),B2

def detail_at(masks,s,coords,shape):
    """This stripe's rows of the node's maps, bilinear from level k (half-pixel centres, clamped): only grade_frame has them."""
    maps=(masks or {}).get('detail:'+str(s['node'].get('id')))
    if maps is None or coords is None: raise ValueError('Dehaze and Clarity need whole frames; they cannot be baked into an RGB LUT.')
    row,height,width=coords;resize=bilinear(height,width,*maps[0].shape[:2]);return resize(maps[0],slice(row,row+shape[0])),resize(maps[1],slice(row,row+shape[0]))

def apply_detail(lin,w,U1,U2,p):
    """applyDetail per pixel on linear light: dehaze (J = (I − A(1 − t))/t on luminance, A = 1, the veil's own colour taken out of the
    chroma, the local mean partly re-exposed; − adds a neutral veil), then clarity (one 2^x gain on R, G and B) from the pre-dehaze l."""
    a,c=p.get('dehaze',0)/100,p.get('clarity',0)/100;y=luma(lin,w);l=stops(y);ac,bc=U1[...,0],U1[...,1];base=ac*l+bc;out=lin
    if a:
        # The dehaze base keeps only edges over about a stop (eps_m = 1, from a_c); the haze map is read at it plus the pixel's own
        # max-over-luma offset, so no texture is copied into h.
        am=.0625*ac/(.0625*ac+1-ac);bm=am*l+(1-am)*bc/np.maximum(1-ac,1e-3);mu=.18*np.exp2(bm)
        h=np.clip(U1[...,2]*(bm+stops(np.maximum(lin.max(-1),0))-l)+U1[...,3],0,1);h=np.where(y>1e-6,h*(1-smoothstep(.25,.7,y)),0)
        if a>0:
            t=np.maximum(1-.95*a*h,1/3);s=1-t;uc=softcap(s/np.maximum(y,1e-6));q=(1-uc)/t;gc=q*.4+.6/t;den=U2[...,0]+1e-3
            col=np.stack([np.exp2(U2[...,2]/den),np.ones_like(y),np.exp2(U2[...,3]/den)],-1);col=col/luma(col,w)[...,None]
            out=(q*y)[...,None]+gc[...,None]*(lin-y[...,None]-(uc*y)[...,None]*(col-1))
            out=out*(((1-softcap(s/np.maximum(mu,1e-6)))/t)**-.6)[...,None]
        else:
            v=-a*(.5*np.maximum(mu-2**-10,0)*(1-smoothstep(.25,.7,y))+h);out=(lin+v[...,None])*((mu/(mu+v))**.4)[...,None]
    if c:
        # Midtones only, soft-limited to ½ stop, gated by the local variance (v/(v + .08²)): flat skies and noise are left alone.
        d=l-base;f=d/np.sqrt(1+(d/.5)**2);mid=smoothstep(-6,-1.5,base)*(1-smoothstep(2,5,base));g=ac/(ac+.1024*(1-ac))
        out=out*np.exp2(c*(2 if c>0 else 1)*mid*g*f)[...,None]
    return out

def grade_frame(rgb,stages,masks=None,managed=True,frame=0,pool=None,input_cube=None):
    """A whole (h, w, 3) frame: per-pixel segments in STRIPE-row stripes (window alphas from each stripe's rows), the input cube
    first, film stages on the whole picture between segments. Each film stage follows its node's blend and each detail node starts
    a segment, its maps made from the whole picture entering it, so every segment after the first starts at a node's start."""
    height,width=rgb.shape[:2];segment=[];first=True;masks=dict(masks or {})
    def flush():
        nonlocal first
        if not segment and not (first and input_cube): return
        stages_,cube=list(segment),input_cube if first else None
        def stripe(r):
            values=rgb[r:r+STRIPE]
            if cube: values=lut(values,{'cube':cube,'amount':1})
            rgb[r:r+STRIPE]=grade(values,stages_,{k:a if k.startswith('detail:') else a[r:r+STRIPE] for k,a in masks.items()},managed,(r,height,width))
        each(pool,stripe,height);segment.clear();first=False
    for s in stages:
        if s['type']=='film': flush();first=False;rgb=apply_film(rgb,s,frame,pool);continue
        if detail_point(s): flush();masks['detail:'+str(s['node'].get('id'))]=detail_maps(rgb,s,managed,pool)
        segment.append(s)
    flush()
    return rgb

def frame_read(stream,size):
    data=bytearray()
    while len(data)<size:
        part=stream.read(size-len(data))
        if not part: break
        data.extend(part)
    if data and len(data)!=size: raise ValueError('Truncated color frame')
    return data

def depth_key(job,spec):
    """A depth key per decoded frame: the run's masters decoded in order (10-bit codes, as depth-fx.py reads them), each
    wanted frame through the key table (depthKeyTable in depth.ts) and up to the source size. A still repeats its frame."""
    w,h=spec['width'],spec['height'];table=np.asarray(spec['table'],dtype=np.float32);resize=bilinear(job['height'],job['width'],h,w)
    def codes():
        for path in spec['masters']:
            p=subprocess.Popen([job.get('ffmpeg','ffmpeg'),'-v','error','-nostdin','-i',path,'-f','rawvideo','-pix_fmt','gray10le','-'],stdout=subprocess.PIPE)
            try:
                while data:=frame_read(p.stdout,w*h*2): yield data
            except GeneratorExit: p.kill();p.wait();raise
            if p.wait(): raise RuntimeError('Depth master decode failed')
    source=codes();position=-1;current=None
    indices=itertools.chain(spec['indices'],itertools.repeat(spec['indices'][-1])) if spec.get('still') else spec['indices']
    for index in indices:
        while position<index:
            current=next(source,None);position+=1
            if current is None: raise ValueError('The depth analysis does not cover this clip')
        yield resize(table[np.minimum(np.frombuffer(current,dtype='<u2').reshape(h,w),1023)])

def threads(job): return max(1,int(job.get('threads') or os.cpu_count() or 1))

def process_frames(source,target,job,mask_targets=None,rgba16=False):
    """Planar float frames in (G,B,R[,A]); out the same floats, or with `rgba16` exact 16-bit G,B,R,A (opaque without a source alpha)."""
    w,h=job['width'],job['height'];count=0;channels=4 if job.get('alpha') else 3;fps=float(job.get('numericFps',24))
    masks=job.get('masks',[]);cached={};keys={m['document']['id']:depth_key(job,m['depth']) for m in masks if 'depth' in m}
    pool=ThreadPoolExecutor(threads(job))
    while data:=frame_read(source,w*h*channels*4):
        planes=np.frombuffer(data,dtype='<f4').reshape(channels,h,w)
        rgb=np.ascontiguousarray(planes[[2,0,1]].transpose(1,2,0))
        times=job.get('frameTimes');timed=times and count<len(times);time=times[count] if timed else job.get('seek',0)+count/fps
        # The film stage's frame number, as the preview counts it: round(source time x source fps). `filmFrame` (media.ts) is
        # the first decoded frame's when the decoder's own clock is not a source time (a still, a seek between frames).
        frame=js_round(time*fps) if timed or job.get('filmFrame') is None else int(job['filmFrame'])+count
        alphas={}
        for mask in masks:
            doc=mask['document']
            if 'depth' in mask:
                alphas[doc['id']]=next(keys[doc['id']],None)
                if alphas[doc['id']] is None: raise ValueError('The depth key has fewer frames than the source')
                continue
            index=max(0,bisect.bisect_right(mask['sourceTimes'],time+1e-7)-1)
            if time<doc['range']['start']-1e-7 or time>=doc['range']['end']-1e-7: alpha=np.zeros((h,w),dtype=np.float32)
            else:
                file=mask['files'].get(str(index))
                if file is None: raise ValueError('Smart Mask has no analyzed alpha for source frame '+str(index))
                cache=cached.get(doc['id'])
                if not cache or cache[0]!=index:
                    # One trusted lossless frame per mask is retained. Stream PNG decoding if this I/O becomes limiting.
                    decoded=subprocess.run([job.get('ffmpeg','ffmpeg'),'-v','error','-threads','1','-i',file,'-frames:v','1','-vf','format=gray16le','-f','rawvideo','-'],capture_output=True,check=True).stdout
                    if len(decoded)!=w*h*2: raise ValueError('Smart Mask dimensions differ from the source image')
                    alpha=np.frombuffer(decoded,dtype='<u2').reshape(h,w).astype(np.float32)/65535
                    cached[doc['id']]=(index,alpha)
                else: alpha=cache[1]
            alphas[doc['id']]=alpha
            if mask_targets and doc['id'] in mask_targets: mask_targets[doc['id']].write(np.rint(np.clip(alpha,0,1)*65535).astype('<u2').tobytes())
        # Per-pixel stages grade in stripes in parallel (numpy/OCIO release the GIL), film stages on the whole frame between them.
        rgb=grade_frame(rgb,job['stages'],alphas,job.get('managed',True),frame,pool,job.get('inputCube'))
        if rgba16:
            # Rounded here, not by FFmpeg: its float to 16-bit step is off by up to 5e-4, and FFmpeg 9.0.1 garbles the right half of
            # every slice's last row when a graph adds alpha to gbrp16le (the clip chain's format=gbrap16le). gbrap16le needs neither.
            output=np.empty((4,h,w),'<u2')
            def pack(r):
                rs=slice(r,r+STRIPE);output[:3,rs]=np.rint(np.clip(rgb[rs],0,1)*65535).transpose(2,0,1)[[1,2,0]]
                output[3,rs]=np.rint(np.clip(planes[3,rs],0,1)*65535) if channels==4 else 65535
            each(pool,pack,h)
        else:
            output=np.ascontiguousarray(rgb.transpose(2,0,1)[[1,2,0]],dtype='<f4')
            if channels==4: output=np.concatenate([output,planes[3:4]])
        target.write(output.tobytes());count+=1
        print(json.dumps({'progress':min(99,count/max(1,job.get('frames',count))*100)}),file=sys.stderr,flush=True)
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
        input_args=['-loop','1','-framerate',str(job['fps'])] if job.get('image') else ['-ss',f"{max(0,job['seek']):.6f}"]
        n=str(threads(job))
        # `scale` = [w, h]: the picture is fitted to the size it is graded at (media.ts: the canvas the clip ends up on).
        size=f"w={job['width']}:h={job['height']}:" if job.get('scale') else ''
        decoder=subprocess.Popen([ff,'-v','error','-threads',n,'-filter_threads',n,*input_args,'-i',job['input'],'-t',str(job['duration']),'-an','-vf',f"scale={size}in_color_matrix={job['matrix']}:in_range={job['range']},format={pixel_format}",'-fps_mode','passthrough','-f','rawvideo','-'],stdout=subprocess.PIPE);children.append(decoder)
        encoder=subprocess.Popen([ff,'-v','error','-y','-threads',n,'-filter_threads',n,'-f','rawvideo','-pixel_format','gbrap16le','-video_size',f"{job['width']}x{job['height']}",'-framerate',str(job['fps']),'-i','-','-c:v','ffv1','-threads',n,'-level','3','-color_range','pc','-colorspace','rgb','-color_primaries','bt709','-color_trc','bt709',job['output']],stdin=subprocess.PIPE);children.append(encoder)
        for mask in job.get('masks',[]):
            if not mask.get('output'): continue
            p=subprocess.Popen([ff,'-v','error','-y','-threads','1','-f','rawvideo','-pixel_format','gray16le','-video_size',f"{job['width']}x{job['height']}",'-framerate',str(job['fps']),'-i','-','-c:v','ffv1','-level','3','-color_range','pc',mask['output']],stdin=subprocess.PIPE)
            children.append(p);mask_targets[mask['document']['id']]=p.stdin
        process_frames(decoder.stdout,encoder.stdin,job,mask_targets,True);encoder.stdin.close();decoder.stdout.close()
        for stream in mask_targets.values(): stream.close()
        if any(p.wait()!=0 for p in children): raise RuntimeError('Color/mask decode or encode failed')
    finally:
        for p in children:
            if p.poll() is None: p.terminate()
        for p in children:
            try: p.wait(timeout=5)
            except subprocess.TimeoutExpired: p.kill();p.wait()

def write_cube(job,size,path):
    """Sample the exact grade on a size^3 grid. Without masks every stage is per-pixel, so the export can apply it with lut3d."""
    if any(s['type']=='film' or detail_point(s) or has_window((s.get('node') or {}).get('parameters') or {}) for s in job['stages']): raise ValueError('Windows, film effects, Dehaze and Clarity need whole frames; they cannot be baked into a LUT.')
    axis_=np.linspace(0,1,size,dtype=np.float32);b,g,r=np.meshgrid(axis_,axis_,axis_,indexing='ij')
    grid=np.stack([r,g,b],-1).reshape(size*size,size,3)  # .cube order: red varies fastest
    def rows(i):
        values=grid[i:i+size]
        if job.get('inputCube'): values=lut(values,{'cube':job['inputCube'],'amount':1})
        grid[i:i+size]=grade(values,job['stages'],{},job.get('managed',True))
    list(ThreadPoolExecutor(threads(job)).map(rows,range(0,len(grid),size)))
    with open(path,'w') as f:
        f.write(f'LUT_3D_SIZE {size}\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n')
        np.savetxt(f,grid.reshape(-1,3),fmt='%.7g')

if __name__=='__main__':
    if sys.argv[1:]==['--check']:
        print(json.dumps({'ocio':ocio.__version__,'config':CONFIG,'view':VIEW}));sys.exit(0)
    if sys.argv[1:]==['--defaults']:
        print(json.dumps(DEFAULTS));sys.exit(0)
    job=json.loads(open(sys.argv[1]).read())
    if sys.argv[2:3]==['--cube']: write_cube(job,int(sys.argv[3]),sys.argv[4]);sys.exit(0)
    if '--stream' in sys.argv: process_frames(sys.stdin.buffer,sys.stdout.buffer,job)
    else: render(job)
