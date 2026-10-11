import { describe, expect, it } from 'vitest';
import {
  bindMedia,
  mediaKindFromMimeType,
  normalizeJobSet,
  videoResult,
  type UploadedMedia
} from './higgsfield-client.js';

function media(id: string, kind: UploadedMedia['kind']): UploadedMedia {
  return { id, kind, mimeType: `${kind}/x`, fileName: id, sizeBytes: 1 };
}

describe('mediaKindFromMimeType', () => {
  it('names the kind the platform uses in medias[].data.type', () => {
    expect(mediaKindFromMimeType('image/png')).toBe('image');
    expect(mediaKindFromMimeType('video/mp4')).toBe('video');
    expect(mediaKindFromMimeType('audio/mpeg')).toBe('audio');
    // Anything unrecognised is a still: that is what the reference slots take.
    expect(mediaKindFromMimeType('application/octet-stream')).toBe('image');
  });
});

describe('bindMedia', () => {
  it('sends a role-tagged list whose data is {id, type}, not a bare id', () => {
    expect(bindMedia([media('m1', 'image')], 'medias')).toEqual({
      medias: [{ role: 'start_image', data: { id: 'm1', type: 'image' } }]
    });
  });

  it('makes the first still the start frame and the rest plain references', () => {
    const bound = bindMedia([media('m1', 'image'), media('m2', 'image')], 'medias') as {
      medias: Array<{ role: string }>;
    };
    expect(bound.medias.map((entry) => entry.role)).toEqual(['start_image', 'image']);
  });

  // 这是这次改动的要点：Higgsfield 的参考位收图、视频和音频三种，
  // medias 就是唯一能带得下后两种的写法。
  it('carries reference video and audio under their own roles', () => {
    expect(bindMedia([
      media('m1', 'image'),
      media('m2', 'video'),
      media('m3', 'audio')
    ], 'medias')).toEqual({
      medias: [
        { role: 'start_image', data: { id: 'm1', type: 'image' } },
        { role: 'video', data: { id: 'm2', type: 'video' } },
        { role: 'audio', data: { id: 'm3', type: 'audio' } }
      ]
    });
  });

  it('numbers the stills independently of the video and audio around them', () => {
    const bound = bindMedia([
      media('v1', 'video'),
      media('m1', 'image'),
      media('m2', 'image')
    ], 'medias') as { medias: Array<{ role: string }> };
    expect(bound.medias.map((entry) => entry.role)).toEqual(['video', 'start_image', 'image']);
  });

  it('falls back to bare ids for the generators on the older convention', () => {
    expect(bindMedia([media('m1', 'image'), media('m2', 'image')], 'input_image'))
      .toEqual({ input_image: 'm1', input_image_end: 'm2' });
  });

  // input_image 只有两个位置，而且都是图；视频和音频在这条写法上没有去处，
  // 不能硬塞成 input_image，那会让平台收下一条素材类型不对的任务。
  it('drops video and audio on the older convention, which has nowhere to put them', () => {
    expect(bindMedia([media('v1', 'video'), media('m1', 'image')], 'input_image'))
      .toEqual({ input_image: 'm1' });
    expect(bindMedia([media('a1', 'audio')], 'input_image')).toEqual({});
  });

  it('sends nothing at all when there are no references', () => {
    expect(bindMedia([], 'medias')).toEqual({});
    expect(bindMedia([], 'input_image')).toEqual({});
  });
});

describe('normalizeJobSet', () => {
  it('reads both spellings of the ids the platform uses', () => {
    expect(normalizeJobSet({ id: 'js_1', type: 'seedance', jobs: [] })).toMatchObject({ id: 'js_1', type: 'seedance' });
    expect(normalizeJobSet({ job_set_id: 'js_2', job_set_type: 'kling' })).toMatchObject({ id: 'js_2', type: 'kling' });
    expect(normalizeJobSet({ jobs: [] })).toBeUndefined();
  });

  it('keeps the full-size render and the preview apart', () => {
    const jobSet = normalizeJobSet({
      id: 'js_1',
      jobs: [{
        id: 'job_1',
        status: 'completed',
        results: { raw: { url: 'https://cdn/a.mp4', type: 'video' }, min: { url: 'https://cdn/a.jpg' } }
      }]
    })!;
    expect(jobSet.jobs[0]).toMatchObject({
      status: 'completed',
      raw: { url: 'https://cdn/a.mp4', type: 'video' },
      preview: { url: 'https://cdn/a.jpg' }
    });
    expect(videoResult(jobSet)).toMatchObject({ url: 'https://cdn/a.mp4' });
  });

  // 没见过的状态当成还在跑：平台没给结论，轮询就不该替它下结论。
  it('treats a status it has not seen as still running', () => {
    expect(normalizeJobSet({ id: 'js_1', jobs: [{ id: 'job_1', status: 'reticulating' }] })!.jobs[0]!.status)
      .toBe('in_progress');
  });

  it('finds no video in a set whose jobs carry no url', () => {
    expect(videoResult(normalizeJobSet({ id: 'js_1', jobs: [{ id: 'job_1', status: 'completed' }] })!))
      .toBeUndefined();
  });
});
