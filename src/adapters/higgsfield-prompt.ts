/**
 * The prompt wrapper for Higgsfield's `video_edit` mode.
 *
 * `video_edit` is the cheap way to get a long clip out of this channel: the
 * platform bills it by the **reference video's own duration**, ignoring the
 * `duration` parameter entirely, and the length of what comes back is decided
 * by the prompt. So a two-second seed clip is the whole bill, and the number of
 * seconds actually wanted has to be stated — insistently — in the text.
 *
 * Hence this wrapper. It is not decoration: without it the model returns a clip
 * about as long as the seed, and the job quietly produces the wrong thing at
 * the right price. The caller's own prompt is kept verbatim in the middle,
 * where the platform's clients put it.
 */

/** What seedance 2.5 accepts; the platform rejects anything outside it. */
export const HIGGSFIELD_MIN_DURATION_SECONDS = 4;
export const HIGGSFIELD_MAX_DURATION_SECONDS = 30;

export interface VideoEditPromptInput {
  /** The caller's prompt, used as written. */
  prompt: string;
  /** How long the finished video should be. Clamped to what the model allows. */
  seconds: number;
  /** Stated in the text because `video_edit` ignores the parameter. */
  aspectRatio?: string;
}

export function clampVideoEditSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return HIGGSFIELD_MIN_DURATION_SECONDS;
  return Math.min(
    HIGGSFIELD_MAX_DURATION_SECONDS,
    Math.max(HIGGSFIELD_MIN_DURATION_SECONDS, Math.round(seconds))
  );
}

/**
 * Wrap a prompt with the length requirement `video_edit` needs.
 *
 * Every sentence is phrased against the requested length rather than a fixed
 * one, so asking for eight seconds does not ship a demand for thirty.
 */
export function wrapVideoEditPrompt(input: VideoEditPromptInput): string {
  const seconds = clampVideoEditSeconds(input.seconds);
  const prompt = input.prompt.trim();
  const ratio = input.aspectRatio?.trim();

  return [
    '[Highest-Priority Output Requirements]',
    `You must generate one complete, continuous, single video file with an actual duration of exactly ${seconds}.0 seconds.`,
    `Do not generate a clip shorter than ${seconds} seconds.`,
    'Do not output preview clips, test clips, input media, intermediate media, or cropped segments as the final result.',
    `The video must be generated continuously from 0 seconds through ${seconds} seconds. Do not end early or generate only a short looping clip.`,
    `The final video file must contain the complete video content from 0 to ${seconds} seconds.`,
    '[Customer\'s Original Prompt]',
    prompt,
    '[Final Acceptance Criteria]',
    `The final output must be a completed video with an actual duration of approximately ${seconds} seconds.`,
    ratio
      ? `Video duration requirement: ${seconds}s; aspect ratio: ${ratio}.`
      : `Video duration requirement: ${seconds}s.`
  ].join('\n');
}

/** True when a prompt already carries this wrapper, so it is not applied twice. */
export function hasVideoEditWrapper(prompt: string): boolean {
  return prompt.includes('[Highest-Priority Output Requirements]');
}
