import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectCover } from './library.ts';
import type { MediaAsset, Project } from '../state/models.ts';

const project = (thumbnail: string): Project => ({ id: 'p1', name: 'Girls Soccer', description: '', shared: false, thumbnail, modifiedAt: 0, duration: 0, resolution: '', fps: 24, status: 'In progress', members: [] });
const asset = (over: Partial<MediaAsset>): MediaAsset => ({ id: 'm1', projectId: 'p1', name: 'C0001.MP4', kind: 'video', binId: 'broll', thumbnail: '/api/media/m1/files/thumbnail.jpg', duration: 1, resolution: '', fps: 24, size: '', status: 'ready', progress: 100, ...over });

test('a project without a thumbnail uses its own footage', () => {
  assert.equal(projectCover(project(''), [asset({})]), '/api/media/m1/files/thumbnail.jpg');
});

test('stock art never beats real footage', () => {
  assert.equal(projectCover(project('/media/studio.jpg'), [asset({})]), '/api/media/m1/files/thumbnail.jpg');
});

test('audio and other projects are skipped, stock art is the last resort', () => {
  const others = [asset({ id: 'm2', kind: 'audio' }), asset({ id: 'm3', projectId: 'p2' }), asset({ id: 'm4', thumbnail: '' })];
  assert.equal(projectCover(project('/media/city.jpg'), others), '/media/city.jpg');
  assert.equal(projectCover(project(''), others), '');
});

test('a rendered project thumbnail wins', () => {
  assert.equal(projectCover(project('/api/projects/p1/resolve/a.png'), [asset({})]), '/api/projects/p1/resolve/a.png');
});
