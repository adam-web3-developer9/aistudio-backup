import { SystemError } from '../system/types.js';
import type { ComfyInput } from './store.js';

const presets = { '480p': 480, '768p': 768, '1080p': 1080 } as const;
const ratios = new Set(['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9']);
const align = (pixels: number) => Math.round(pixels / 32) * 32;

/** Translate the public H3 preset exactly once before freezing the graph inputs. */
export function h3PresetInput(input: ComfyInput): ComfyInput {
  if (input.workflowId !== 'minimax-h3-9plus3') return input;
  const { resolution, aspectRatio, ...values } = input.values;
  if (resolution === undefined && aspectRatio === undefined) return input;
  if ('width' in values || 'height' in values) {
    throw new SystemError(400, 'COMFY_DIMENSIONS_INVALID', 'Use either an H3 preset or legacy width and height');
  }
  const supplied = typeof resolution === 'string' ? resolution.toLowerCase().replace(/^short-/, '') : resolution;
  const preset = supplied === '720p' || supplied === undefined ? '768p' : supplied;
  if (typeof preset !== 'string' || !Object.hasOwn(presets, preset)) {
    throw new SystemError(400, 'COMFY_RESOLUTION_INVALID', 'H3 resolution must be 480p, 768p or 1080p');
  }
  const ratio = aspectRatio === undefined ? '16:9' : aspectRatio;
  if (typeof ratio !== 'string' || !ratios.has(ratio)) {
    throw new SystemError(400, 'COMFY_ASPECT_RATIO_INVALID', 'H3 aspect ratio is unsupported');
  }
  const [x, y] = ratio.split(':').map(Number) as [number, number];
  const short = presets[preset as keyof typeof presets];
  const aspect = Math.max(x, y) / Math.min(x, y);
  const long = short === 768 && aspect === 16 / 9 ? 1344 : align(short * aspect);
  const [width, height] = x >= y ? [long, align(short)] : [align(short), long];
  if (width > 1920 || height > 1920) {
    throw new SystemError(400, 'COMFY_DIMENSIONS_INVALID', 'H3 resolution and aspect ratio exceed the supported canvas');
  }
  return { ...input, values: { ...values, width, height } };
}
