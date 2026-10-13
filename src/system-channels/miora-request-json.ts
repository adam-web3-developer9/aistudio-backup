import parser, { type Token } from 'stream-json/web/parser.js';
import { constants as bufferConstants } from 'node:buffer';
import { Readable } from 'node:stream';
import { assertMediaMemory, mediaIdleWatchdog } from '../system-media/resources.js';
import { SystemError } from '../system/types.js';

type Frame = { value: Record<string, unknown> | unknown[]; key: string; size: number };
/** Token AST, never a complete raw request string/Buffer. Scalar chunks are joined once. */
export async function readMioraRequestJson(source: AsyncIterable<Uint8Array>, options: {
  signal?: AbortSignal; idleTimeoutMs?: number; admit?: (bytes: number) => void;
} = {}): Promise<{ value: unknown; bytes: number }> {
  const idle = mediaIdleWatchdog(options.idleTimeoutMs ?? 60_000,
    () => new SystemError(408, 'MIORA_REQUEST_IDLE_TIMEOUT', 'Miora request stopped making progress'), options.signal);
  const iterator = source[Symbol.asyncIterator]();
  const decoder = new TextDecoder('utf-8', { fatal:true });
  let bytes = 0, retained = 0;
  const admit = (extra = 0) => {
    try { (options.admit ?? (size => assertMediaMemory(size, 'buffer')))(retained + extra); }
    catch { throw new SystemError(507, 'MIORA_REQUEST_MEMORY_UNAVAILABLE', 'Available memory cannot hold this Miora request'); }
  };
  async function* pieces() {
    for (;;) {
      idle.signal.throwIfAborted();
      const next = await iterator.next();
      if (next.done) { const tail = decoder.decode(); if (tail) yield tail; return; }
      bytes += next.value.byteLength;
      for (let offset = 0; offset < next.value.byteLength; offset += 16 * 1024) {
        admit(128 * 1024); idle.progress();
        yield decoder.decode(next.value.subarray(offset, offset + 16 * 1024), { stream:true });
      }
    }
  }
  const inputs = pieces();
  const input = new ReadableStream<string>({
    async pull(controller) { try { const next = await inputs.next(); if (next.done) controller.close(); else controller.enqueue(next.value); } catch (error) { controller.error(error); } },
    cancel() { void inputs.return(undefined).catch(() => {}); void iterator.return?.().catch(() => {}); }
  });
  const reader = input.pipeThrough(parser.asWebStream({ packValues:false })).getReader();
  const stack: Frame[] = [], sizes = new WeakMap<object, number>();
  let result: unknown, roots = 0, scalar: 'key'|'string'|'number'|undefined, parts:string[] = [], length = 0;
  const valueSize = (value:unknown) => typeof value === 'string' ? value.length * 2 : value && typeof value === 'object' ? sizes.get(value) ?? 64 : 8;
  const attach = (value:unknown) => {
    const frame = stack.at(-1), size = valueSize(value);
    if (!frame) { result = value; roots++; return; }
    if (Array.isArray(frame.value)) { frame.value.push(value); frame.size += size + 8; retained += 8; }
    else {
      if (Object.hasOwn(frame.value, frame.key)) { const previous = valueSize(frame.value[frame.key]); frame.size -= previous; retained -= previous + frame.key.length * 2; }
      else { const overhead = frame.key.length * 2 + 16; frame.size += overhead; retained += 16; }
      Object.defineProperty(frame.value, frame.key, { value, enumerable:true, writable:true, configurable:true });
      frame.size += size; frame.key = '';
    }
    admit();
  };
  let rejectAbort!: (error:unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = () => { const error = idle.signal.reason; rejectAbort(error); if (source instanceof Readable) source.destroy(error); };
  idle.signal.addEventListener('abort', abort, { once:true });
  try {
    idle.signal.throwIfAborted();
    for (;;) {
      const next = await Promise.race([reader.read(), aborted]); if (next.done) break;
      const token = next.value as Token;
      switch (token.name) {
        case 'startObject': case 'startArray': {
          retained += 64; admit();
          stack.push({ value:token.name === 'startArray' ? [] : {}, key:'', size:64 }); break;
        }
        case 'endObject': case 'endArray': { const frame = stack.pop()!; sizes.set(frame.value, frame.size); attach(frame.value); break; }
        case 'startKey': case 'startString': case 'startNumber': scalar = token.name === 'startKey' ? 'key' : token.name === 'startString' ? 'string' : 'number'; parts = []; length = 0; break;
        case 'stringChunk': case 'numberChunk': {
          length += token.value.length;
          if (length > bufferConstants.MAX_STRING_LENGTH) throw new SystemError(507, 'MIORA_REQUEST_MEMORY_UNAVAILABLE', 'A request scalar exceeds the native string capacity');
          retained += token.value.length * 2 + 8; admit(); parts.push(token.value); break;
        }
        case 'endKey': case 'endString': case 'endNumber': {
          admit(length * 2);
          const text = parts.join(''); retained -= parts.length * 8; parts = [];
          if (scalar === 'key') { stack.at(-1)!.key = text; }
          else if (scalar === 'number') { retained -= length * 2; retained += 8; attach(Number(text)); }
          else attach(text);
          scalar = undefined; break;
        }
        case 'trueValue': case 'falseValue': case 'nullValue': retained += 8; admit(); attach(token.value); break;
      }
    }
    if (roots !== 1 || stack.length || scalar) throw new SystemError(400, 'MIORA_REQUEST_JSON_INVALID', 'Invalid Miora request JSON');
    return { value:result, bytes };
  } catch (error) {
    if (error instanceof SystemError) throw error;
    if (idle.signal.aborted) throw new SystemError(499, 'MIORA_REQUEST_CANCELLED', 'Miora request was cancelled');
    throw new SystemError(400, 'MIORA_REQUEST_JSON_INVALID', 'Invalid Miora request JSON');
  } finally {
    idle.close(); idle.signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {}); void iterator.return?.().catch(() => {});
  }
}
