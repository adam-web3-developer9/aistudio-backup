import parser, {type Token} from 'stream-json/web/parser.js';

type Part = string | number;
type Frame = {path: Part[]; kind: 'object' | 'array'; key: string; index: number};
export type CredentialBytes = AsyncIterable<Uint8Array | string>;

/** JSON syntax is validated by the library; only selected scalar fields are assembled. */
export async function readJsonFields(source: CredentialBytes, handlers: {
  string: (path: Part[]) => ((text: string, end: boolean) => void | Promise<void>) | undefined;
  scalar?: (path: Part[], value: boolean | null | number) => void;
  container?: (path: Part[], kind: 'object' | 'array', end: boolean) => void;
  key?: (path: Part[], key: string) => void;
}) {
  const iterator = source[Symbol.asyncIterator](), decoder = new TextDecoder('utf-8', {fatal: true});
  let first = true;
  const stream = new ReadableStream<string>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) {const tail=decoder.decode();if(tail)controller.enqueue(tail);controller.close();return;}
      let text=typeof next.value==='string'?next.value:decoder.decode(next.value,{stream:true});
      if(first&&text){first=false;text=text.replace(/^\uFEFF/,'');}controller.enqueue(text);
    },
    async cancel() {await iterator.return?.();},
  }).pipeThrough(parser.asWebStream({packValues: false, jsonStreaming: true}));
  const reader=stream.getReader(), stack: Frame[]=[];
  let key=false, keyText='', active: ((text: string, end: boolean)=>void | Promise<void>)|undefined;
  const path=()=>{const frame=stack.at(-1);return frame?[...frame.path,frame.kind==='array'?frame.index:frame.key]:[];};
  const complete=()=>{const frame=stack.at(-1);if(frame?.kind==='array')frame.index++;};
  try {
    while(true){
      const next=await reader.read();if(next.done)break;const token=next.value as Token;
      switch(token.name){
        case 'startObject':case 'startArray':{const nextPath=path(),kind=token.name==='startObject'?'object':'array';handlers.container?.(nextPath,kind,false);stack.push({path:nextPath,kind,key:'',index:0});break;}
        case 'endObject':case 'endArray':{const frame=stack.pop()!;handlers.container?.(frame.path,frame.kind,true);complete();break;}
        case 'startKey':key=true;keyText='';break;
        case 'endKey':{key=false;const frame=stack.at(-1)!;frame.key=keyText;handlers.key?.(frame.path,keyText);break;}
        case 'startString':active=handlers.string(path());break;
        case 'stringChunk':if(key){if(keyText.length<128)keyText+=token.value.slice(0,129-keyText.length);}else await active?.(token.value,false);break;
        case 'endString':await active?.('',true);active=undefined;complete();break;
        case 'trueValue':case 'falseValue':case 'nullValue':handlers.scalar?.(path(),token.value);complete();break;
        case 'startNumber':handlers.scalar?.(path(),Number.NaN);break;
        case 'endNumber':complete();break;
      }
    }
  } finally {await reader.cancel();reader.releaseLock();}
}

const jwt=/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const refresh=/^def50200[A-Za-z0-9_+/=-]{80,}$/;
function age(token: string): [number, number] {
  try {const claims=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(token.split('.')[1]!.replace(/-/g,'+').replace(/_/g,'/')),char=>char.charCodeAt(0))));return [typeof claims.iat==='number'?claims.iat:0,typeof claims.exp==='number'?claims.exp:0];}catch{return [0,0];}
}
const newer=(candidate: string, previous?: string)=>{if(!previous)return true;const a=age(candidate),b=age(previous);return a[0]>b[0]||a[0]===b[0]&&a[1]>b[1];};
class Candidates {
  best?: string;
  firstRefresh?: string;
  private tail='';
  write(text: string, end=false) {
    text=this.tail+text;this.tail='';
    const pattern=/eyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){0,2}|def50200[A-Za-z0-9_+/=-]*/g;
    for(const match of text.matchAll(pattern)){
      if(!end&&match.index!+match[0].length===text.length){this.tail=match[0];break;}
      if(jwt.test(match[0])&&newer(match[0],this.best))this.best=match[0];
      if(!this.firstRefresh&&refresh.test(match[0]))this.firstRefresh=match[0];
    }
    if(!end&&!this.tail)this.tail=text.slice(-7);
  }
}

/** Compact only the existing account fields, retaining original token/cookie selection. */
export async function extractCredentialText(source: CredentialBytes): Promise<string> {
  const iterator=source[Symbol.asyncIterator](), decoder=new TextDecoder('utf-8',{fatal:true});
  let first='', comment=false;
  while(!first){
    const chunk=await iterator.next();if(chunk.done)throw new Error('凭据为空。');
    const text=typeof chunk.value==='string'?chunk.value:decoder.decode(chunk.value,{stream:true});
    for(let i=0;i<text.length;i++){
      const char=text[i]!;
      if(comment){if(char==='\n'||char==='\r')comment=false;continue;}
      if(/[\s\uFEFF]/.test(char))continue;
      if(char==='#'){comment=true;continue;}
      first=text.slice(i);break;
    }
  }
  first=first.replace(/^\uFEFF/,'');
  async function* textSource(){try{yield first;while(true){const next=await iterator.next();if(next.done)break;yield typeof next.value==='string'?next.value:decoder.decode(next.value,{stream:true});}const tail=decoder.decode();if(tail)yield tail;}finally{await iterator.return?.();}}
  if(!/^[\s]*[\[{]/.test(first)){
    // The established text form is one account per line, with ---- separated parts.
    let part='', probe='', dashes=0, active=false, discarded=false, comment=false;
    let authToken:string|undefined, refreshToken:string|undefined, found:string|undefined;
    const piece=(char:string)=>{
      if(discarded||comment||found)return;
      if(active){part+=char;return;}
      if(!probe&&!char.trim())return;
      probe+=char;
      if(probe.startsWith('#')){comment=true;return;}
      if('eyJ'.startsWith(probe)||'def50200'.startsWith(probe)){
        if(probe==='eyJ'||probe==='def50200'){active=true;part=probe;}
      }else discarded=true;
    };
    const finishPart=()=>{const value=part.trim();if(!authToken&&jwt.test(value))authToken=value;if(!refreshToken&&/^def50200[A-Za-z0-9_+/=-]+$/.test(value))refreshToken=value;part='';probe='';active=false;discarded=false;};
    const finishLine=()=>{if(dashes===1)piece('-');dashes=0;finishPart();if(authToken&&!comment&&!found)found=JSON.stringify({authToken,...(refreshToken?{refreshToken}:{})});authToken=undefined;refreshToken=undefined;comment=false;};
    for await(const chunk of textSource()){
      for(const char of chunk){if(found)continue;if(char==='\n'||char==='\r'){finishLine();continue;}if(char==='-'){dashes++;continue;}if(dashes>=2)finishPart();else if(dashes===1)piece('-');dashes=0;piece(char);}
    }
    finishLine();if(!found)throw new Error('凭据中没有有效的 Miora 账户。');return found;
  }
  const top: Record<string,string>={}, local: Record<string,string>={}, cookies: Record<string,string>[]=[];
  let fallbackEmail:string|undefined;
  const candidates=new Candidates();let currentCookie:Record<string,string>|undefined;
  let rootCount=0, rootDepth=0, inString=false, escaped=false, prettyFirst=false, firstClosed=false;
  let firstLineEnded=false, suffixInvalid=false, laterContent=false;
  async function* observed(){for await(const chunk of textSource()){
    if(firstLineEnded){laterContent ||= !!chunk.trim();continue;}
    let end=chunk.length;
    for(let i=0;i<chunk.length;i++){
      const char=chunk[i]!;
      if(firstClosed&&!prettyFirst){
        if(char==='\n'||char==='\r'){firstLineEnded=true;end=i+1;laterContent ||= !!chunk.slice(end).trim();break;}
        if(char.trim())suffixInvalid=true;
      }
      if(inString){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')inString=false;}
      else if(char==='"')inString=true;
      else if(char==='{'||char==='[')rootDepth++;
      else if(char==='}'||char===']'){rootDepth--;if(rootDepth===0)firstClosed=true;}
      else if((char==='\n'||char==='\r')&&rootDepth>0&&!firstClosed)prettyFirst=true;
    }
    yield chunk.slice(0,end);
  }}
  const cookiePath=(path: Part[])=>path.length===2&&path[0]==='cookies'&&typeof path[1]==='number'||path.length===1&&typeof path[0]==='number';
  await readJsonFields(observed(),{
    container(path,kind,end){if(path.length===0&&!end)rootCount++;if(kind==='object'&&cookiePath(path)){if(!end)currentCookie={};else if(currentCookie){if(currentCookie.name==='authToken'||currentCookie.name==='refreshToken'||/(^|\.)miora\.design$/.test(currentCookie.domain??''))cookies.push(currentCookie);currentCookie=undefined;}}},
    string(path){
      let value='';const field=String(path.at(-1));
      const target=path.length===1&&rootCount===1&&['authToken','refreshToken','cookie','email','id'].includes(field)?top:path.length===2&&path[0]==='localStorage'&&['authToken','refreshToken','miora__user_info'].includes(field)?local:cookiePath(path.slice(0,-1))&&['name','value','domain'].includes(field)?currentCookie:undefined;
      return (chunk,end)=>{candidates.write(chunk,end);if(target||field==='email')value+=chunk;if(end){if(target)target[field]=value;if(!fallbackEmail&&field==='email')fallbackEmail=value.match(/[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/)?.[0];}};
    },
  });
  if(top.authToken&&!prettyFirst&&!suffixInvalid)return JSON.stringify(top);
  if(suffixInvalid||firstLineEnded&&laterContent)throw new Error('凭据 JSON 格式无效。');
  if(rootCount>1)throw new Error('多行账户文件中没有有效的普通账户 JSON。');
  const cookieValue=(name: string)=>cookies.find(cookie=>cookie.name===name)?.value;
  let authToken: string|undefined;
  for(const candidate of [local.authToken,cookieValue('authToken'),candidates.best])if(candidate&&newer(candidate,authToken))authToken=candidate;
  if(!authToken)throw new Error('凭据中没有 Miora authToken。');
  const refreshToken=local.refreshToken||cookieValue('refreshToken')||candidates.firstRefresh;
  const cookie=cookies.filter(entry=>entry.name!==undefined&&entry.value!==undefined&&/(^|\.)miora\.design$/.test(entry.domain??'')).map(entry=>`${entry.name}=${entry.value}`).join('; ');
  let email:unknown;try{email=JSON.parse(local.miora__user_info||'{}').email;}catch{}
  email=typeof email==='string'&&email?email:fallbackEmail;
  return JSON.stringify({authToken,...(refreshToken?{refreshToken}:{}),...(cookie?{cookie}:{}),...(typeof email==='string'?{email}:{})});
}

export async function* readableChunks(stream: ReadableStream<Uint8Array|string>): CredentialBytes {
  const reader=stream.getReader();try{while(true){const next=await reader.read();if(next.done)break;yield next.value;}}finally{await reader.cancel();reader.releaseLock();}
}

/** The wire envelope is streamed too: its credentials string feeds the inner parser with backpressure. */
export async function readCredentialMutation(source: CredentialBytes) {
  const body: {credentials?:string;label?:string;enabled?:boolean}={};
  let writer: WritableStreamDefaultWriter<string>|undefined, extraction:Promise<string>|undefined, normalized:string|undefined, rootCount=0;
  try {
    await readJsonFields(source,{
      container(path,kind,end){if(path.length===0&&!end){if(kind!=='object'||++rootCount!==1)throw new Error('Invalid credential request');}else if(path.length>0)throw new Error('Invalid credential field');},
      key(path,key){if(path.length!==0||!['credentials','label','enabled'].includes(key)||Object.hasOwn(body,key))throw new Error('Invalid credential field');},
      string(path){
        if(path.length!==1)throw new Error('Invalid credential field');
        if(path[0]==='credentials'){
          if(extraction)throw new Error('Duplicate credentials');
          const stream=new TransformStream<string,string>();writer=stream.writable.getWriter();
          extraction=extractCredentialText(readableChunks(stream.readable)).then(value=>{normalized=value;return value;});void extraction.catch(()=>{});
          return async(chunk,end)=>{
            if(end){if(normalized===undefined){try{await writer!.close();}catch{await extraction;}}body.credentials=await extraction;}
            else if(normalized===undefined){try{await writer!.write(chunk);}catch{await extraction;}}
          };
        }
        if(path[0]!=='label')throw new Error('Invalid credential field');
        let label='', pending='', excessWhitespace=false;
        return(chunk,end)=>{
          for(const char of chunk){
            if(!char.trim()){if(label){if(pending.length<121)pending+=char;else excessWhitespace=true;}continue;}
            if(excessWhitespace||label.length+pending.length+char.length>120)throw new Error('Invalid credential label');
            label+=pending+char;pending='';
          }
          if(end)body.label=label;
        };
      },
      scalar(path,value){if(path.length!==1||path[0]!=='enabled'||typeof value!=='boolean')throw new Error('Invalid credential field');body.enabled=value;},
    });
    if(rootCount!==1)throw new Error('Invalid credential request');
    return body;
  }catch{
    await writer?.abort().catch(()=>{});await extraction?.catch(()=>{});throw new Error('凭据格式无效，请检查导出文件或令牌。');
  }
}
