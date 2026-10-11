import { describe, expect, it } from 'vitest';
import { createJobSchema } from './schemas.js';

const baseJob = {
  adapterId: 'hailuo-v1',
  assetId: 'asset_test',
  text: '镜头缓缓推进'
};

describe('createJobSchema MiniMax H3 options', () => {
  it('accepts the supported H3 option range', () => {
    expect(createJobSchema.safeParse({
      ...baseJob,
      assetIds: ['asset_test', 'asset_character', 'asset_scene'],
      options: {
        modelId: 'hailuo3.0-i2v',
        resolution: '1440',
        durationSeconds: 15,
        aspectRatio: '16:9',
        referenceMode: 'all-reference',
        frameType: 4,
        quantity: 1
      }
    }).success).toBe(true);
  });

  it.each([
    { modelId: '23210' },
    { resolution: '1080' },
    { durationSeconds: 3 },
    { durationSeconds: 16 },
    { referenceMode: 'start-end-frames' },
    { frameType: 0 },
    { quantity: 2 }
  ])('rejects unsupported options: %o', (options) => {
    expect(createJobSchema.safeParse({ ...baseJob, options }).success).toBe(false);
  });
});

describe('createJobSchema DreamMaker options', () => {
  const dreamMakerJob = { adapterId: 'dreammaker-v1', assetId: 'asset_test', text: '镜头缓慢推进' };

  it('accepts any platform model with its own parameter ranges', () => {
    expect(createJobSchema.safeParse({
      ...dreamMakerJob,
      options: {
        modelId: 'doubao-seedance-2-5-260628',
        mode: 'allReference',
        resolution: '1080p',
        durationSeconds: 30,
        aspectRatio: 'adaptive'
      }
    }).success).toBe(true);
  });

  // 这一层只管形状。值域是平台的：模型清单、清晰度档位、时长区间、参考图张数
  // 都按模型变且随平台更新，网关拒掉的可能正是平台会接的活，用户还只能看到
  // 一句 Invalid request 而不是平台自己的说法。
  it.each([
    { mode: 'someNewModeThePlatformAdded' },
    { resolution: '8k' },
    { durationSeconds: 60 },
    { aspectRatio: '21:9' },
    { quantity: 4 }
  ])('passes values through for the platform to judge: %o', (options) => {
    expect(createJobSchema.safeParse({ ...dreamMakerJob, options }).success).toBe(true);
  });

  it('accepts as many reference assets as the caller has', () => {
    const assetIds = Array.from({ length: 30 }, (_, index) => `asset_${index}`);
    expect(createJobSchema.safeParse({ ...dreamMakerJob, assetIds }).success).toBe(true);
    // 海螺那条路仍是 9 张，那是海螺自己的上限
    expect(createJobSchema.safeParse({ ...baseJob, assetIds }).success).toBe(false);
  });

  it.each([
    { mode: '' },
    { durationSeconds: 0 },
    { durationSeconds: 1.5 },
    { quantity: 0 },
    { modelId: '' }
  ])('still rejects what cannot be a value at all: %o', (options) => {
    expect(createJobSchema.safeParse({ ...dreamMakerJob, options }).success).toBe(false);
  });

  it('allows the prompt the platform allows: 20000 chars here, 7000 on Hailuo', () => {
    const long = '镜'.repeat(7_806);
    expect(createJobSchema.safeParse({ ...dreamMakerJob, text: long }).success).toBe(true);
    expect(createJobSchema.safeParse({ ...baseJob, text: long }).success).toBe(false);
    expect(createJobSchema.safeParse({ ...dreamMakerJob, text: '镜'.repeat(20_001) }).success).toBe(false);
  });
});

describe('createJobSchema Higgsfield options', () => {
  const higgsfieldJob = { adapterId: 'higgsfield-v1', assetId: 'asset_test', text: '镜头缓慢推进' };

  it('takes the generator, or the generator and the model it runs', () => {
    expect(createJobSchema.safeParse({ ...higgsfieldJob, options: { modelId: 'seedance' } }).success).toBe(true);
    expect(createJobSchema.safeParse({
      ...higgsfieldJob,
      options: { modelId: 'seedance:seedance-2-5', resolution: '1080p', durationSeconds: 10, aspectRatio: '9:16' }
    }).success).toBe(true);
    expect(createJobSchema.safeParse({
      ...higgsfieldJob,
      options: { modelId: 'v2/cinematic_studio_video_4_0' }
    }).success).toBe(true);
  });

  // 和 DreamMaker 同一个理由：模型清单、清晰度、时长都是平台的，网关只看形状。
  it.each([
    { resolution: '8k' },
    { durationSeconds: 60 },
    { aspectRatio: '21:9' },
    { quantity: 4 }
  ])('passes values through for the platform to judge: %o', (options) => {
    expect(createJobSchema.safeParse({ ...higgsfieldJob, options }).success).toBe(true);
  });

  // mode 不是自由文本：它决定这条任务怎么计费。video_edit 按参考视频自己的时长收费、
  // 并忽略 durationSeconds 和 aspectRatio，写错就是一条价钱和预期对不上的任务。
  it('only accepts a generation mode the platform has', () => {
    for (const mode of ['t2v', 'omni_reference', 'video_edit', 'video_extension']) {
      expect(createJobSchema.safeParse({ ...higgsfieldJob, options: { mode } }).success).toBe(true);
    }
    expect(createJobSchema.safeParse({ ...higgsfieldJob, options: { mode: 'medias' } }).success).toBe(false);
    expect(createJobSchema.safeParse({ ...higgsfieldJob, options: { mode: 'image2video' } }).success).toBe(false);
  });

  it.each([
    { modelId: '' },
    { durationSeconds: 0 },
    { quantity: 0 }
  ])('still rejects what cannot be a value at all: %o', (options) => {
    expect(createJobSchema.safeParse({ ...higgsfieldJob, options }).success).toBe(false);
  });
});
