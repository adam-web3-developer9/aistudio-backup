export interface WorkflowProfile {
  id: string;
  version: string;
  graph: Record<string, unknown>;
  bindings: Record<string, { nodeId: string; input: string; required?: boolean; kind?: 'value' | 'media' | 'output-prefix'; omitWhenMissing?: boolean }>;
  outputNodeIds: string[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function link(value: unknown): value is [string, number] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'number';
}

function assertJson(value: unknown, seen = new Set<unknown>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if ((!Array.isArray(value) && !record(value)) || seen.has(value)) throw new Error('Workflow must contain only JSON data');
  seen.add(value);
  for (const child of Object.values(value)) assertJson(child, seen);
  seen.delete(value);
}

export function validateProfile(profile: WorkflowProfile): void {
  assertJson(profile);
  if (!profile.id || !profile.version || !record(profile.graph) || !record(profile.bindings) ||
      !Array.isArray(profile.outputNodeIds) || Object.keys(profile.graph).length === 0) throw new Error('Invalid workflow profile');
  for (const [nodeId, node] of Object.entries(profile.graph)) {
    if (!record(node) || typeof node.class_type !== 'string' || !node.class_type || !record(node.inputs) ||
        Object.keys(node).some((key) => !['class_type', 'inputs', '_meta'].includes(key))) throw new Error(`Invalid API node: ${nodeId}`);
    for (const input of Object.values(node.inputs)) {
      if (link(input) && !Object.hasOwn(profile.graph, input[0])) throw new Error(`Missing linked node: ${input[0]}`);
    }
  }
  const targets = new Set<string>();
  for (const [key, binding] of Object.entries(profile.bindings)) {
    if (!record(binding) || typeof binding.nodeId !== 'string' || typeof binding.input !== 'string' || !binding.input ||
        (binding.required !== undefined && typeof binding.required !== 'boolean') ||
        (binding.omitWhenMissing !== undefined && (typeof binding.omitWhenMissing !== 'boolean' || binding.kind !== 'media' || binding.required === true)) ||
        (binding.kind !== undefined && binding.kind !== 'value' && binding.kind !== 'media' && binding.kind !== 'output-prefix')) throw new Error(`Invalid binding: ${key}`);
    const node = Object.hasOwn(profile.graph, binding.nodeId) ? profile.graph[binding.nodeId] : undefined;
    if (!record(node) || !record(node.inputs) || !Object.hasOwn(node.inputs, binding.input)) throw new Error(`Missing binding target: ${key}`);
    const target = JSON.stringify([binding.nodeId, binding.input]);
    if (targets.has(target)) throw new Error(`Duplicate binding target: ${key}`);
    targets.add(target);
  }
  for (const nodeId of profile.outputNodeIds) {
    if (typeof nodeId !== 'string' || !Object.hasOwn(profile.graph, nodeId)) throw new Error('Missing output node');
  }
  for (const [key, binding] of Object.entries(profile.bindings)) {
    if (!binding.omitWhenMissing) continue;
    const node = profile.graph[binding.nodeId] as { class_type: string; inputs: Record<string, unknown> };
    const mediaInput = node.class_type === 'LoadImage' ? 'image' : node.class_type === 'LoadAudio' ? 'audio' : undefined;
    if (!mediaInput || binding.input !== mediaInput || typeof node.inputs[mediaInput] !== 'string' ||
        profile.outputNodeIds.includes(binding.nodeId) || Object.values(node.inputs).some(link) ||
        Object.values(profile.bindings).filter((other) => other.nodeId === binding.nodeId).length !== 1) {
      throw new Error(`Unsafe omitted loader: ${key}`);
    }
    const referenceInput = mediaInput === 'image' ? /^ref_images\.ref_image_\d+$/ : /^ref_audios\.ref_audio_\d+$/;
    for (const [nodeId, consumer] of Object.entries(profile.graph)) {
      const target = consumer as { class_type: string; inputs: Record<string, unknown> };
      for (const [input, value] of Object.entries(target.inputs)) {
        if (!link(value) || value[0] !== binding.nodeId) continue;
        if (target.class_type !== 'MiniMaxH3ReferenceToVideo' || !referenceInput.test(input) || value[1] !== 0 ||
            targets.has(JSON.stringify([nodeId, input]))) throw new Error(`Unsafe omitted reference: ${key} -> ${nodeId}.${input}`);
      }
    }
  }
}

export function compileWorkflow(profile: WorkflowProfile, values: Record<string, string | number | boolean>): Record<string, unknown> {
  validateProfile(profile);
  if (!record(values)) throw new Error('Invalid workflow values');
  for (const [key, value] of Object.entries(values)) {
    if (!Object.hasOwn(profile.bindings, key)) throw new Error(`Unregistered binding: ${key}`);
    if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) throw new Error(`Invalid binding value: ${key}`);
  }
  const graph = structuredClone(profile.graph);
  for (const [key, binding] of Object.entries(profile.bindings)) {
    if (!Object.hasOwn(values, key)) {
      if (binding.required) throw new Error(`Missing required binding: ${key}`);
      if (binding.omitWhenMissing) {
        delete graph[binding.nodeId];
        for (const node of Object.values(graph)) {
          const inputs = (node as { inputs: Record<string, unknown> }).inputs;
          for (const [input, value] of Object.entries(inputs)) {
            if (link(value) && value[0] === binding.nodeId) delete inputs[input];
          }
        }
      }
      continue;
    }
    const node = graph[binding.nodeId] as { inputs: Record<string, unknown> };
    Object.defineProperty(node.inputs, binding.input, { value: values[key], enumerable: true, writable: true, configurable: true });
  }
  return graph;
}
