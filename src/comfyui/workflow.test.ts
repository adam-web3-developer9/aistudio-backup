import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compileWorkflow, validateProfile, type WorkflowProfile } from './workflow.js';

function profile(): WorkflowProfile {
  return {
    id: 'example', version: '1',
    graph: { '1': { class_type: 'LoadImage', inputs: { image: 'default.png' } }, '2': { class_type: 'Render', inputs: { image: ['1', 0], text: 'default', seed: 42, enabled: true } } },
    bindings: { image: { nodeId: '1', input: 'image', required: true, kind: 'media' }, text: { nodeId: '2', input: 'text', required: true, kind: 'value' }, seed: { nodeId: '2', input: 'seed' }, enabled: { nodeId: '2', input: 'enabled' } },
    outputNodeIds: ['2']
  };
}

function referenceProfile(): WorkflowProfile {
  const source: WorkflowProfile = {
    id: 'minimax-h3-9plus3', version: '1.1',
    graph: JSON.parse(readFileSync(new URL('../../docs/examples/minimax-h3-9plus3.api.json', import.meta.url), 'utf8')),
    bindings: {
      prompt: { nodeId: '4', input: 'text', required: true, kind: 'value' },
      outputPrefix: { nodeId: '39', input: 'filename_prefix', required: true, kind: 'output-prefix' }
    },
    outputNodeIds: ['39']
  };
  for (let index = 1; index <= 9; index++) {
    source.bindings[`image${index}`] = { nodeId: String(index + 5), input: 'image', kind: 'media',
      ...(index === 1 ? { required: true } : { omitWhenMissing: true }) };
  }
  for (let index = 1; index <= 3; index++) {
    source.bindings[`audio${index}`] = { nodeId: String(index + 14), input: 'audio', kind: 'media', omitWhenMissing: true };
  }
  return source;
}

describe('compileWorkflow', () => {
  it('binds by name independent of order, replaces media, preserves links and falsy values', () => {
    const source = profile();
    const compiled = compileWorkflow(source, { enabled: false, seed: 0, text: '', image: 'attempt/upload.png' });
    expect(compiled).toEqual({ '1': { class_type: 'LoadImage', inputs: { image: 'attempt/upload.png' } }, '2': { class_type: 'Render', inputs: { image: ['1', 0], text: '', seed: 0, enabled: false } } });
    expect(JSON.stringify(compiled)).not.toContain('default');
    expect(JSON.stringify(source.graph)).toContain('default.png');
    expect(compileWorkflow(source, { image: 'second.png', text: 'second' })).not.toEqual(compiled);
  });

  it('requires explicitly registered required media, not its default value', () => {
    expect(() => compileWorkflow(profile(), { text: 'hello' })).toThrow('Missing required binding: image');
  });

  it('does not invent media-key policies for optional bindings', () => {
    const source = profile();
    source.bindings.image!.required = false;
    expect(compileWorkflow(source, { text: 'hello' })['1']).toEqual(source.graph['1']);
  });

  it('compiles the real 9+3 graph with seven images and no audio without dangling links', () => {
    const source = referenceProfile();
    const defaults = structuredClone(source);
    const values = { prompt: 'test prompt', outputPrefix: 'attempt/output',
      ...Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`image${index + 1}`, `upload/image${index + 1}.png`])) };
    const compiled = compileWorkflow(source, values);
    const referenceInputs = (compiled['29'] as { inputs: Record<string, unknown> }).inputs;
    expect(Object.keys(referenceInputs).filter((input) => input.startsWith('ref_images.'))).toHaveLength(7);
    expect(Object.keys(referenceInputs).filter((input) => input.startsWith('ref_audios.'))).toHaveLength(0);
    for (const nodeId of ['13', '14', '15', '16', '17']) expect(compiled).not.toHaveProperty(nodeId);
    for (let index = 1; index <= 7; index++) {
      expect((compiled[String(index + 5)] as { inputs: Record<string, unknown> }).inputs.image).toBe(`upload/image${index}.png`);
    }
    for (const node of Object.values(compiled)) {
      for (const input of Object.values((node as { inputs: Record<string, unknown> }).inputs)) {
        if (Array.isArray(input) && input.length === 2 && typeof input[0] === 'string' && typeof input[1] === 'number') {
          expect(Object.hasOwn(compiled, input[0])).toBe(true);
        }
      }
    }
    expect(() => validateProfile({ ...source, graph: compiled, bindings: {} })).not.toThrow();
    expect(compiled['39']).toBeDefined();
    expect(JSON.stringify(compiled)).not.toContain('EXPLICIT_UPLOAD_REQUIRED');
    expect(source).toEqual(defaults);
    expect(() => compileWorkflow(source, { prompt: 'missing media', outputPrefix: 'attempt/output' })).toThrow('Missing required binding: image1');
    expect(() => compileWorkflow(source, { image1: 'upload/image.png', outputPrefix: 'attempt/output' })).toThrow('Missing required binding: prompt');
  });

  it('keeps explicitly supplied optional media, removes every direct optional reference and isolates compilations', () => {
    const source = referenceProfile();
    (source.graph['29'] as { inputs: Record<string, unknown> }).inputs['ref_images.ref_image_9'] = ['14', 0];
    source.graph.extra = structuredClone(source.graph['29']);
    const omitted = compileWorkflow(source, { prompt: '', image1: 'upload/one.png', outputPrefix: 'first' });
    const supplied = compileWorkflow(source, { prompt: '', image1: 'upload/one.png', image9: 'upload/nine.png', audio3: 'upload/three.wav', outputPrefix: 'second' });
    for (const nodeId of ['29', 'extra']) {
      const inputs = (omitted[nodeId] as { inputs: Record<string, unknown> }).inputs;
      expect(inputs).not.toHaveProperty('ref_images.ref_image_8');
      expect(inputs).not.toHaveProperty('ref_images.ref_image_9');
      expect(inputs).not.toHaveProperty('ref_audios.ref_audio_2');
      const retained = (supplied[nodeId] as { inputs: Record<string, unknown> }).inputs;
      expect(retained['ref_images.ref_image_8']).toEqual(['14', 0]);
      expect(retained['ref_images.ref_image_9']).toEqual(['14', 0]);
      expect(retained['ref_audios.ref_audio_2']).toEqual(['17', 0]);
    }
    expect((supplied['14'] as { inputs: Record<string, unknown> }).inputs.image).toBe('upload/nine.png');
    expect((supplied['17'] as { inputs: Record<string, unknown> }).inputs.audio).toBe('upload/three.wav');
  });

  it('preserves loader defaults and connections when omission is absent or disabled', () => {
    const source = referenceProfile();
    delete source.bindings.image9!.omitWhenMissing;
    source.bindings.audio3!.omitWhenMissing = false;
    const compiled = compileWorkflow(source, { prompt: '', image1: 'upload/one.png', outputPrefix: 'attempt/output' });
    for (const nodeId of ['14', '17']) expect(compiled[nodeId]).toEqual(source.graph[nodeId]);
    const inputs = (compiled['29'] as { inputs: Record<string, unknown> }).inputs;
    expect(inputs['ref_images.ref_image_8']).toEqual(['14', 0]);
    expect(inputs['ref_audios.ref_audio_2']).toEqual(['17', 0]);
  });

  it.each([
    { omitWhenMissing: 'true' },
    { omitWhenMissing: null },
    { kind: 'value' },
    { kind: 'output-prefix' },
    { kind: undefined },
    { required: true },
    { omitWhenMissing: false, kind: 'value' },
    { omitWhenMissing: false, required: true }
  ])('rejects invalid omission flags or incompatible binding options: %j', (override) => {
    const source = referenceProfile();
    Object.assign(source.bindings.image9!, override);
    expect(() => validateProfile(source)).toThrow();
  });

  it.each(['output', 'multiple bindings', 'non-loader', 'loader dependency', 'wrong loader input', 'non-string media'])('rejects unsafe omitted loaders: %s', (kind) => {
    const source = referenceProfile();
    const loader = source.graph['14'] as { class_type: string; inputs: Record<string, unknown> };
    if (kind === 'output') source.outputNodeIds.push('14');
    if (kind === 'multiple bindings') {
      loader.inputs.upload = 'image';
      source.bindings.other = { nodeId: '14', input: 'upload' };
    }
    if (kind === 'non-loader') loader.class_type = 'CustomImageLoader';
    if (kind === 'loader dependency') loader.inputs.dependency = ['6', 0];
    if (kind === 'wrong loader input') {
      loader.inputs.upload = 'image';
      source.bindings.image9!.input = 'upload';
    }
    if (kind === 'non-string media') loader.inputs.image = 42;
    expect(() => validateProfile(source)).toThrow('Unsafe omitted loader: image9');
    expect(() => compileWorkflow(source, { image9: 'explicit.png' })).toThrow('Unsafe omitted loader: image9');
  });

  it.each(['ordinary input', 'wrong media input', 'unknown dynamic input', 'wrong consumer', 'bound reference', 'wrong output slot'])('rejects unsafe omitted references: %s', (kind) => {
    const source = referenceProfile();
    const consumer = source.graph['29'] as { class_type: string; inputs: Record<string, unknown> };
    if (kind === 'ordinary input') consumer.inputs.image = ['14', 0];
    if (kind === 'wrong media input') consumer.inputs['ref_audios.ref_audio_3'] = ['14', 0];
    if (kind === 'unknown dynamic input') consumer.inputs['ref_images.required'] = ['14', 0];
    if (kind === 'wrong consumer') source.graph.other = { class_type: 'RequiredImageConsumer', inputs: { 'ref_images.ref_image_0': ['14', 0] } };
    if (kind === 'bound reference') source.bindings.reference = { nodeId: '29', input: 'ref_images.ref_image_8', required: true };
    if (kind === 'wrong output slot') consumer.inputs['ref_images.ref_image_8'] = ['14', 1];
    expect(() => validateProfile(source)).toThrow('Unsafe omitted reference: image9');
  });

  it('ships sanitized media and prompt defaults while preserving real model nodes', () => {
    const source = referenceProfile();
    expect((source.graph['4'] as { inputs: Record<string, unknown> }).inputs.text).toBe('');
    for (const node of Object.values(source.graph) as { class_type: string; inputs: Record<string, unknown> }[]) {
      if (node.class_type === 'LoadImage') expect(node.inputs.image).toBe('EXPLICIT_UPLOAD_REQUIRED');
      if (node.class_type === 'LoadAudio') expect(node.inputs.audio).toBe('EXPLICIT_UPLOAD_REQUIRED');
    }
    expect((source.graph['21'] as { inputs: Record<string, unknown> }).inputs.clip_name).toBe('qwen3vl_32b_minimax_h3_int8_convrot.safetensors');
    expect((source.graph['22'] as { inputs: Record<string, unknown> }).inputs.unet_name).toBe('minimax_h3_delta_fl2va_ref2va_r1024_fp8_scaled.safetensors');
    expect(JSON.stringify(source.graph)).not.toMatch(/https?:\/\/|"(?:token|api_key|authorization)"\s*:|example\.png|ntakzd5cl8/i);
  });

  it('validates binding kind without asset resolution or graph pruning', () => {
    const source = profile();
    expect(() => validateProfile(source)).not.toThrow();
    Object.assign(source.bindings.image!, { kind: 'unknown' });
    expect(() => validateProfile(source)).toThrow('Invalid binding: image');
  });

  it('accepts resolved output prefixes and isolates each compilation without mutating defaults', () => {
    const source = profile();
    (source.graph['2'] as { inputs: Record<string, unknown> }).inputs.filename_prefix = 'example';
    source.bindings.outputPrefix = { nodeId: '2', input: 'filename_prefix', kind: 'output-prefix', required: true };
    expect(() => validateProfile(source)).not.toThrow();
    const first = compileWorkflow(source, { image: 'uploaded.png', text: 'first', outputPrefix: 'job_attempt_one' });
    const second = compileWorkflow(source, { image: 'uploaded.png', text: 'second', outputPrefix: 'job_attempt_two' });
    expect((first['2'] as { inputs: Record<string, unknown> }).inputs.filename_prefix).toBe('job_attempt_one');
    expect((second['2'] as { inputs: Record<string, unknown> }).inputs.filename_prefix).toBe('job_attempt_two');
    expect((source.graph['2'] as { inputs: Record<string, unknown> }).inputs.filename_prefix).toBe('example');
    expect(() => compileWorkflow(source, { image: 'uploaded.png', text: 'missing' })).toThrow('Missing required binding: outputPrefix');
  });

  it('rejects unregistered fields and inherited names', () => {
    expect(() => compileWorkflow(profile(), { image: 'a', text: 'b', unknown: 1 })).toThrow('Unregistered binding');
    expect(() => compileWorkflow(profile(), { image: 'a', text: 'b', constructor: 'x' })).toThrow('Unregistered binding');
  });

  it.each(['binding', 'input', 'output', 'link'])('rejects missing %s nodes or inputs', (kind) => {
    const source = profile();
    if (kind === 'binding') source.bindings.image!.nodeId = 'missing';
    if (kind === 'input') source.bindings.image!.input = 'missing';
    if (kind === 'output') source.outputNodeIds = ['missing'];
    if (kind === 'link') (source.graph['2'] as { inputs: Record<string, unknown> }).inputs.image = ['missing', 0];
    expect(() => validateProfile(source)).toThrow();
  });

  it('rejects UI graphs and ambiguous duplicate bindings', () => {
    const source = profile();
    source.graph = { nodes: [{ id: 1, type: 'LoadImage' }] };
    expect(() => validateProfile(source)).toThrow('Invalid API node');
    const duplicate = profile();
    duplicate.bindings.other = { ...duplicate.bindings.image! };
    expect(() => validateProfile(duplicate)).toThrow('Duplicate binding target');
  });

  it('deep clones nested data and rejects non-JSON graphs', () => {
    const source = profile();
    const compiled = compileWorkflow(source, { image: 'a', text: 'b' });
    (compiled['2'] as { inputs: Record<string, unknown> }).inputs.seed = 99;
    expect((source.graph['2'] as { inputs: Record<string, unknown> }).inputs.seed).toBe(42);
    source.graph.bad = undefined;
    expect(() => validateProfile(source)).toThrow('JSON');
  });
});
