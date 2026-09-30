export type Workspace = 'edit' | 'color' | 'audio' | 'deliver';
export type Role = 'Owner' | 'Editor' | 'Commenter' | 'Viewer';
export interface User { id: string; name: string; email: string; initials: string; color: string }
export interface Group { id: string; name: string; userIds: string[] }
export interface ProjectMember { userId: string; role: Role }
export interface Project { classRole?: 'Editor' | 'Viewer'; id: string; name: string; description: string; shared: boolean; thumbnail: string; modifiedAt: number; duration: number; resolution: string; fps: number; status: 'In progress' | 'In review' | 'Complete'; members: ProjectMember[] }
export type MediaStatus = 'downloading' | 'uploading' | 'processing' | 'proxy' | 'waveform' | 'thumbnails' | 'ready' | 'failed';
export interface MediaAsset { preparationStage?: string; importLink?: { url: string; mode: 'video' | 'audio'; quality: 720 | 1080 | 2160 }; matchedSourceUrl?: string; matchedSourceTitle?: string; id: string; projectId: string; name: string; kind: 'video' | 'audio' | 'image'; binId: string; thumbnail: string; duration: number; resolution: string; fps: number; size: string; status: MediaStatus; progress: number; camera?: string; inputProfile?: string; inputGamut?: string; colorRange?: string; colorMatrix?: string; colorTransfer?: string; probeVersion?: number; colorEvidence?: string; cameraMetadataVersion?: number; frameRate?: string; sourcePath?: string; sourceUrl?: string; colorProxyUrl?: string; proxyUrl?: string; proxyVariants?: Record<string, string>; audioProxyUrl?: string; filmstrip?: string; filmstripFrames?: number; filmstripVersion?: number; waveform?: number[]; waveformVersion?: number; hasAudio?: boolean; error?: string }
export interface Bin { id: string; name: string }
export interface Timeline { composition?: boolean; id: string; projectId: string; name: string; duration: number; markers?: {time:number;name:string;color:string}[] }
export interface Track { captionSets?: import('../services/captions.ts').CaptionSet[]; height?: number; id: string; timelineId: string; name: string; kind: 'video' | 'audio'; number: number; muted: boolean; solo: boolean; locked: boolean; hidden: boolean; gain: number; pan: number }
export interface Effect { id: string; name: string; enabled: boolean; amount: number; parameters?: Record<string, number>; maskId?: string }
export type KeyframeValue = number | string | boolean;
export interface Keyframe { id: string; time: number; value: KeyframeValue; interpolation: 'linear' | 'hold' | 'bezier'; curve?: [number, number, number, number] }
export interface Clip { smartMasks?: import('../services/smartMask.ts').SmartMaskDocument[]; motionTrackers?: import('../services/motionTracker.ts').MotionTracker[]; keyframes?: Record<string, Keyframe[]>; id: string; projectId: string; timelineId: string; trackId: string; mediaId: string; name: string; start: number; duration: number; sourceIn: number; color: string; disabled: boolean; transition?: string; properties: Record<string, number | string | boolean>; effects: Effect[] }
export interface CurvePoint { id: string; x: number; y: number; slope?: number }
export interface ColorCurve { mode: "smooth" | "linear"; points: CurvePoint[] }
export type ColorCurves = Partial<Record<"RGB" | "R" | "G" | "B", ColorCurve>>;
export interface ColorTransformEffect { id: string; type: "cst"; enabled: boolean; inputGamma: string; inputGamut: string; outputGamma: string; outputGamut: string; toneMapping: "none" | "shoulder" | "aces2"; gamutMapping: "none" | "compress" }
export interface ColorLutEffect { id: string; type: "lut"; enabled: boolean; name: string; amount: number; inputGamma: string; inputGamut: string; cube: {size: number; data: number[]; min: number[]; max: number[]} }
export type ColorEffect = ColorTransformEffect | ColorLutEffect;
export interface GradeNode { mask?: import('../services/smartMask.ts').SmartMaskBinding; position?: {x: number; y: number}; curves?: ColorCurves; effects?: ColorEffect[]; id: string; projectId: string; clipId: string; name: string; kind: string; enabled: boolean; order?: number; parameters: Record<string, number> }
export interface Comment { id: string; projectId: string; userId: string; text: string; timestamp: number; time: number; clipId?: string; range?: [number, number]; resolved: boolean; replies: { id: string; userId: string; text: string; timestamp: number }[] }
export interface PresenceCursor { x: number; y: number; surface?: string; anchor?: string; clipId?: string; context?: string; fallback?: string }
export interface DragPreview { tracks?: { id: string; height: number }[]; clips?: { id: string; start: number; duration: number; trackId: string }[] }
export interface Presence { mediaTab?: string; inspectorTab?: string; preview?: DragPreview | null; userId: string; projectId: string; cursor: PresenceCursor | null; playhead: number; selectedClipId?: string; focusedField?: string; activity: string; online: boolean; updatedAt: number; receivedAt?: number; playing?: boolean; presenting?: boolean; timelineId?: string }
export interface CollaborativeLock { id: string; projectId: string; targetId: string; field: string; userId: string; expiresAt: number }
export type OperationType = 'ClipMoved' | 'ClipTrimmed' | 'ClipDeleted' | 'ClipAdded' | 'PropertyChanged' | 'EffectAdded' | 'GradeNodeAdded' | 'GradeNodeChanged' | 'TrackCreated' | 'TrackChanged' | 'CommentAdded' | 'CommentChanged' | 'SnapshotRestored';
export interface Operation { gestureId?: string; id: string; projectId: string; userId: string; timestamp: number; targetId: string; type: OperationType; oldState: unknown; newState: unknown; description: string; undone?: boolean }
export interface ProjectState { timelines?: Timeline[]; clips: Clip[]; tracks: Track[]; nodes: GradeNode[]; comments: Comment[] }
export interface Snapshot { id: string; projectId: string; name: string; note: string; userId: string; timestamp: number; state: ProjectState }
export interface RenderJob { id: string; projectId: string; name: string; preset: string; status: 'rendering' | 'waiting' | 'complete' | 'failed'; progress: number; remaining: string; settings: Record<string, string>; outputUrl?: string; error?: string }
export interface Notification { id: string; title: string; detail?: string; kind: 'success' | 'info' | 'error'; timestamp: number }
export interface Settings { uiScale: string; timelineDensity: string; reducedMotion: boolean; [key: string]: string | number | boolean }
