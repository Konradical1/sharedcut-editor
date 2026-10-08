import type { Bin, Clip, Comment, GradeNode, MediaAsset, Operation, Presence, Project, Snapshot, Track, User } from './models.ts';

export const users: User[] = [
  { id: 'kyle', name: 'Kyle', email: 'kyle@frameline.studio', initials: 'K', color: '#F06A70' },
  { id: 'ashley', name: 'Ashley', email: 'ashley@frameline.studio', initials: 'A', color: '#B298F5' },
  { id: 'jacob', name: 'Jacob', email: 'jacob@frameline.studio', initials: 'J', color: '#78AAEF' },
  { id: 'maya', name: 'Maya', email: 'maya@frameline.studio', initials: 'M', color: '#EBC876' },
];
export const bins: Bin[] = [
  { id: 'all', name: 'All media' }, { id: 'interviews', name: 'Interviews' },
  { id: 'broll', name: 'B-roll' }, { id: 'drone', name: 'Drone' },
  { id: 'audio', name: 'Audio' }, { id: 'graphics', name: 'Graphics' },
];

const now = Date.now();
export const projects: Project[] = [
  { id: 'city-after-dark', name: 'City After Dark', description: 'A short documentary about the people who keep the city alive after sunset.', shared: true, thumbnail: '/media/city.jpg', modifiedAt: now - 240_000, duration: 180, resolution: '3840 × 2160', fps: 24, status: 'In progress', members: [{ userId: 'kyle', role: 'Owner' }, { userId: 'ashley', role: 'Editor' }, { userId: 'jacob', role: 'Editor' }, { userId: 'maya', role: 'Commenter' }] },
  { id: 'the-long-way-home', name: 'The Long Way Home', description: 'Finding a different rhythm on the Pacific coast.', shared: true, thumbnail: '/media/ocean.jpg', modifiedAt: now - 7_200_000, duration: 180, resolution: '3840 × 2160', fps: 24, status: 'In review', members: [{ userId: 'kyle', role: 'Owner' }, { userId: 'ashley', role: 'Editor' }] },
  { id: 'in-good-company', name: 'In Good Company', description: 'Conversations with a new generation of makers.', shared: true, thumbnail: '/media/interview.jpg', modifiedAt: now - 86_400_000, duration: 180, resolution: '1920 × 1080', fps: 24, status: 'In progress', members: [{ userId: 'kyle', role: 'Owner' }, { userId: 'jacob', role: 'Editor' }, { userId: 'maya', role: 'Commenter' }] },
  { id: 'above-the-treeline', name: 'Above the Treeline', description: 'An alpine field journal.', shared: false, thumbnail: '/media/mountains.jpg', modifiedAt: now - 3 * 86_400_000, duration: 180, resolution: '3840 × 2160', fps: 24, status: 'Complete', members: [{ userId: 'kyle', role: 'Owner' }] },
  { id: 'last-stop', name: 'Last Stop', description: 'A portrait of the city at the end of the line.', shared: true, thumbnail: '/media/train.jpg', modifiedAt: now - 4 * 86_400_000, duration: 180, resolution: '3840 × 2160', fps: 24, status: 'In progress', members: [{ userId: 'kyle', role: 'Owner' }, { userId: 'jacob', role: 'Editor' }] },
];

export const defaultProperties: Clip['properties'] = { x: 0, y: 0, zoom: 100, scaleX: 100, scaleY: 100, rotation: 0, anchorX: 0, anchorY: 0, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0, opacity: 100, blendMode: 'Normal', speed: 100, reverse: false, freeze: false, gain: 0, pan: 0 };

export function createDemoProject(projectId = 'city-after-dark') {
  const isCity = projectId === 'city-after-dark';
  const id = (value: string) => isCity ? value : `${projectId}-${value}`;
  const timelineId = id('main-timeline');
  const media: MediaAsset[] = [
    { id: id('m1'), projectId, name: 'City skyline · 01', kind: 'video', binId: 'broll', thumbnail: '/media/street.jpg', duration: 94, resolution: '3840 × 2160', fps: 24, size: '2.4 GB', status: 'ready', progress: 100, camera: 'Sony FX3 · S-Log3' },
    { id: id('m2'), projectId, name: 'Neon crossing · 03', kind: 'video', binId: 'broll', thumbnail: '/media/city.jpg', duration: 68, resolution: '3840 × 2160', fps: 24, size: '1.8 GB', status: 'ready', progress: 100, camera: 'Sony FX3 · S-Log3' },
    { id: id('m3'), projectId, name: 'Interview · Elena', kind: 'video', binId: 'interviews', thumbnail: '/media/interview.jpg', duration: 312, resolution: '3840 × 2160', fps: 24, size: '8.2 GB', status: 'ready', progress: 100, camera: 'Blackmagic Pocket 6K · Film' },
    { id: id('m4'), projectId, name: 'Aerial · Downtown', kind: 'video', binId: 'drone', thumbnail: '/media/drone.jpg', duration: 128, resolution: '3840 × 2160', fps: 24, size: '3.1 GB', status: 'ready', progress: 100, camera: 'DJI Mavic 3 · D-Log' },
    { id: id('m5'), projectId, name: 'Last train · 02', kind: 'video', binId: 'broll', thumbnail: '/media/train.jpg', duration: 84, resolution: '3840 × 2160', fps: 24, size: '2.0 GB', status: 'ready', progress: 100, camera: 'Sony FX3 · S-Log3' },
    { id: id('m6'), projectId, name: 'Interview · Marcus', kind: 'video', binId: 'interviews', thumbnail: '/media/interview.jpg', duration: 284, resolution: '3840 × 2160', fps: 24, size: '7.4 GB', status: 'ready', progress: 100, camera: 'Blackmagic Pocket 6K · Film' },
    { id: id('m7'), projectId, name: 'Midnight people.wav', kind: 'audio', binId: 'audio', thumbnail: '', duration: 242, resolution: '48 kHz · Stereo', fps: 0, size: '46.5 MB', status: 'ready', progress: 100 },
    { id: id('m8'), projectId, name: 'City ambience.wav', kind: 'audio', binId: 'audio', thumbnail: '', duration: 380, resolution: '48 kHz · Stereo', fps: 0, size: '72.9 MB', status: 'ready', progress: 100 },
    { id: id('m9'), projectId, name: 'Room tone.wav', kind: 'audio', binId: 'audio', thumbnail: '', duration: 92, resolution: '48 kHz · Mono', fps: 0, size: '8.8 MB', status: 'ready', progress: 100 },
    { id: id('m10'), projectId, name: 'City After Dark · Title', kind: 'image', binId: 'graphics', thumbnail: '/media/city.jpg', duration: 180, resolution: '3840 × 2160', fps: 24, size: '420 KB', status: 'ready', progress: 100 },
  ];
  const tracks: Track[] = [
    ['v3', 'Titles & adjustments', 'video', 3], ['v2', 'B-roll', 'video', 2], ['v1', 'Main picture', 'video', 1],
    ['a1', 'Dialogue', 'audio', 1], ['a2', 'Music', 'audio', 2], ['a3', 'Ambience', 'audio', 3],
  ].map(([trackId, name, kind, number]) => ({ id: id(String(trackId)), timelineId, name: String(name), kind: kind as Track['kind'], number: Number(number), muted: false, solo: false, locked: false, hidden: false, gain: kind === 'audio' ? number === 1 ? 0 : -12 : 0, pan: 0 }));
  const clip = (clipId: string, trackId: string, mediaId: string, name: string, start: number, duration: number, sourceIn = 0): Clip => ({ id: id(clipId), projectId, timelineId, trackId: id(trackId), mediaId: id(mediaId), name, start, duration, sourceIn, color: trackId === 'v3' ? '#83709D' : trackId.startsWith('v') ? '#467879' : trackId === 'a1' ? '#4977A0' : trackId === 'a2' ? '#6C6092' : '#427A68', disabled: false, properties: { ...defaultProperties }, effects: [] });
  const clips: Clip[] = [
    clip('c1', 'v3', 'm10', 'CITY AFTER DARK', 2, 13), clip('c2', 'v2', 'm1', 'Skyline at blue hour', 0, 22),
    clip('c3', 'v2', 'm2', 'Neon crossing', 30, 25, 7), clip('c4', 'v2', 'm4', 'Above the city', 65, 21, 18),
    clip('c5', 'v2', 'm5', 'The last train', 107, 23, 12), clip('c6', 'v2', 'm1', 'A city still awake', 150, 30, 28),
    clip('c7', 'v1', 'm3', 'Elena · After hours', 12, 44, 34), clip('c8', 'v1', 'm3', 'Elena · The quiet moments', 57, 39, 101),
    clip('c9', 'v1', 'm6', 'Marcus · Night shift', 98, 49, 46), clip('c10', 'v1', 'm4', 'Home before sunrise', 150, 30, 52),
    clip('c11', 'a1', 'm3', 'Elena · Dialogue', 12, 44, 34), clip('c12', 'a1', 'm3', 'Elena · Dialogue', 57, 39, 101),
    clip('c13', 'a1', 'm6', 'Marcus · Dialogue', 98, 49, 46), clip('c14', 'a2', 'm7', 'Midnight people · Original score', 0, 180),
    clip('c15', 'a3', 'm8', 'Downtown · City ambience', 0, 92, 21), clip('c16', 'a3', 'm8', 'Station · Platform ambience', 94, 86, 122),
  ];
  clips[2].transition = 'Cross dissolve';
  clips[2].effects = [{ id: id('fx1'), name: 'Film grain', enabled: true, amount: 18 }];
  clips[2].properties.zoom = 105;
  const nodeParameters: Record<string, number>[] = [{ exposure: 0 }, { temperature: 350, tint: 2, exposure: 0.15 }, { contrast: 1.12, pivot: 0.47 }, { saturation: -4, softness: 35 }, { intensity: 25, warmth: 12 }, { saturation: 100, gain: 1 }];
  const nodes: GradeNode[] = ['Input', 'Balance', 'Contrast', 'Skin', 'Look', 'Output Trim'].map<GradeNode>((name, index) => ({
    id: id(`node-${index + 1}`), projectId, clipId: id('c3'), name, kind: name.toLowerCase().replace(' ', '-'), enabled: true,
    parameters: nodeParameters[index],
  }));
  const comments: Comment[] = [
    { id: id('comment-1'), projectId, userId: 'ashley', text: 'Love this moment. Could we hold the shot for another half second before Elena comes in?', timestamp: now - 720_000, time: 42, clipId: id('c3'), resolved: false, replies: [{ id: id('reply-1'), userId: 'kyle', text: 'Agreed — giving the city a little more room to breathe.', timestamp: now - 600_000 }] },
    { id: id('comment-2'), projectId, userId: 'maya', text: 'The sound of the train would make a beautiful bridge into this interview.', timestamp: now - 3_600_000, time: 112, range: [107, 120], resolved: false, replies: [] },
    { id: id('comment-3'), projectId, userId: 'jacob', text: 'Matched the drone footage to the street shots. Ready for a color review.', timestamp: now - 7_200_000, time: 74, clipId: id('c4'), resolved: true, replies: [] },
  ];
  const operations: Operation[] = [
    { id: id('op-demo-1'), projectId, userId: 'ashley', timestamp: now - 480_000, targetId: id('c3'), type: 'PropertyChanged', oldState: [], newState: [], description: 'adjusted the framing on Neon crossing' },
    { id: id('op-demo-2'), projectId, userId: 'jacob', timestamp: now - 1_320_000, targetId: id('c3'), type: 'GradeNodeAdded', oldState: [], newState: [], description: 'added a warm evening look' },
    { id: id('op-demo-3'), projectId, userId: 'kyle', timestamp: now - 2_100_000, targetId: id('c8'), type: 'ClipTrimmed', oldState: [], newState: [], description: 'trimmed Elena · The quiet moments' },
    { id: id('op-demo-4'), projectId, userId: 'maya', timestamp: now - 3_600_000, targetId: id('comment-2'), type: 'CommentAdded', oldState: [], newState: [], description: 'left a note at 01:52' },
    { id: id('op-demo-5'), projectId, userId: 'ashley', timestamp: now - 4_800_000, targetId: id('c5'), type: 'ClipMoved', oldState: [], newState: [], description: 'moved The last train to 01:47' },
    { id: id('op-demo-6'), projectId, userId: 'kyle', timestamp: now - 6_500_000, targetId: id('c14'), type: 'ClipAdded', oldState: [], newState: [], description: 'added Midnight people to the music track' },
  ];
  const reviewId = id('review-timeline');
  tracks.push(...tracks.slice(0, 6).map(track => ({ ...track, id: `${track.id}-review`, timelineId: reviewId })));
  clips.push(...[clips[2], clips[6], clips[9]].map((item, index) => ({ ...structuredClone(item), id: `${item.id}-review`, timelineId: reviewId, trackId: `${id('v1')}-review`, start: index * 35, duration: Math.min(item.duration, 30) })));
  const state = { clips, tracks, nodes, comments };
  const snapshots: Snapshot[] = [
    { id: id('snapshot-4'), projectId, name: 'Before Sound Design', note: 'Picture lock from Thursday review. Ready for ambience and final dialogue polish.', userId: 'kyle', timestamp: now - 1_800_000, state: structuredClone(state) },
    { id: id('snapshot-3'), projectId, name: 'Before Color', note: 'The story is in place. Keeping a clean version before the first grade.', userId: 'jacob', timestamp: now - 9_000_000, state: structuredClone({ ...state, nodes: [] }) },
    { id: id('snapshot-2'), projectId, name: 'Picture Lock', note: 'Approved after our class screening.', userId: 'ashley', timestamp: now - 86_400_000, state: structuredClone(state) },
    { id: id('snapshot-1'), projectId, name: 'Rough Cut', note: 'First assembly — finding the rhythm of the city.', userId: 'kyle', timestamp: now - 2 * 86_400_000, state: structuredClone({ ...state, clips: clips.filter(c => !['c1', 'c5', 'c16'].includes(c.id)), nodes: [] }) },
  ];
  const presence: Presence[] = [
    { userId: 'ashley', projectId, cursor: { x: 61, y: 25 }, playhead: 73, selectedClipId: id('c4'), activity: 'Editing', online: true, updatedAt: now },
    { userId: 'jacob', projectId, cursor: { x: 34, y: 61 }, playhead: 28, selectedClipId: id('c2'), activity: 'Color grading', online: true, updatedAt: now },
    { userId: 'maya', projectId, cursor: { x: 82, y: 52 }, playhead: 114, selectedClipId: id('c5'), activity: 'Reviewing', online: true, updatedAt: now },
  ];
  return { media, timelines: [{ id: timelineId, projectId, name: 'Main timeline', duration: 180 }, { id: id('review-timeline'), projectId, name: 'Review selects', duration: 180 }], tracks, clips, nodes, comments, operations, snapshots, presence, timelineId, selectedClipId: id('c3'), selectedNodeId: id('node-2') };
}
