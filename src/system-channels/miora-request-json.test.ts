import { expect, test } from 'vitest';
import { readMioraRequestJson } from './miora-request-json.js';

async function* bytes(text:string) { const data = Buffer.from(text); for (let offset=0;offset<data.length;offset+=7) yield data.subarray(offset,offset+7); }
test('token JSON preserves numbers, split UTF8, last keys and own proto without a raw envelope', async () => {
  const input = '{"__proto__":{"polluted":true},"x":1,"x":2,"n":0.125e2,"arr":[true,null,"😀\\n"]}';
  const parsed = await readMioraRequestJson(bytes(input));
  expect(parsed.value).toEqual(JSON.parse(input));
  expect(Object.hasOwn(parsed.value as object, '__proto__')).toBe(true);
  expect(Object.getPrototypeOf(parsed.value)).toBe(Object.prototype);
  expect(({} as {polluted?:boolean}).polluted).toBeUndefined();
  expect(parsed.bytes).toBe(Buffer.byteLength(input));
});
test('token JSON rejects malformed syntax and low physical memory with safe errors', async () => {
  for (const input of ['{} {}', '{"text":', '{"n":01}', '']) await expect(readMioraRequestJson(bytes(input))).rejects.toMatchObject({code:'MIORA_REQUEST_JSON_INVALID'});
  await expect(readMioraRequestJson(bytes('{"text":"secret"}'), {admit:()=>{throw new Error('secret allocation detail');}}))
    .rejects.toMatchObject({statusCode:507,code:'MIORA_REQUEST_MEMORY_UNAVAILABLE',message:'Available memory cannot hold this Miora request'});
});
test('cancelled and idle pending token reads settle and release the source', async () => {
  const source = () => {
    let entered!:() => void; const start = new Promise<void>(resolve => {entered=resolve;}); let returned=false;
    return {start, get returned(){return returned;}, [Symbol.asyncIterator]() {return {next:()=>{entered();return new Promise<IteratorResult<Uint8Array>>(()=>{});},return:async()=>{returned=true;return {done:true as const,value:undefined};}};}};
  };
  const cancelled=source(), controller=new AbortController();
  const read=readMioraRequestJson(cancelled,{signal:controller.signal}); await cancelled.start; controller.abort();
  await expect(read).rejects.toMatchObject({code:'MIORA_REQUEST_CANCELLED'}); expect(cancelled.returned).toBe(true);
  const idle=source();
  await expect(readMioraRequestJson(idle,{idleTimeoutMs:20})).rejects.toMatchObject({code:'MIORA_REQUEST_IDLE_TIMEOUT'});
  expect(idle.returned).toBe(true);
});
