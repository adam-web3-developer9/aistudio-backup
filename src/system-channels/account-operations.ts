import { MioraClient } from '../adapters/miora-client.js';
import { MioraApiError, readMioraTokens, tokenExpiresAt, useMioraProxy, type MioraTokens } from '../adapters/miora-api.js';
import type { BrowserCookie, CreditBalance } from '../types.js';
import { SystemError } from '../system/types.js';
import { assertVideoGatewayProxyConfiguration } from './video-gateway.js';
import { ChannelStore, type ChannelAccountRow } from './store.js';

type Outcome = { success:boolean; archived:boolean; failed:boolean };
export type ManagedArchiveReason = 'insufficient-credits'|'credentials-expired';
export type ManagedAccountCreditReader=(tokens:MioraTokens,onTokens:(previous:MioraTokens,renewed:MioraTokens)=>Promise<void>)=>Promise<CreditBalance>;
interface Options {
  minimumCredits?:number;
  busy:(id:string)=>boolean;
  changed?:()=>Promise<void>;
  onArchive?:(id:string,reason:ManagedArchiveReason)=>void;
  proxyUrl?:string;
  proxyAddress?:string;
  readCredits?:ManagedAccountCreditReader;
}
const sameTokens=(a:MioraTokens,b:MioraTokens)=>a.authToken===b.authToken&&a.refreshToken===b.refreshToken&&a.cookie===b.cookie;
function errorCode(error:unknown):string {
  if(error instanceof MioraApiError){if(error.status===429)return 'RATE_LIMITED';if(error.apiCode==='REFRESH_TOKEN_DEAD'&&error.path==='/api/auth/refresh-token')return 'REFRESH_TOKEN_DEAD';if(error.status===401||error.status===403)return 'AUTH_UNAVAILABLE';if(error.status>=200&&error.status<300)return 'INVALID_CREDIT_RESPONSE';}
  if(error instanceof SystemError&&['ACCOUNT_CHANGED','INVALID_CREDIT_RESPONSE','VIDEO_GATEWAY_PROXY_CONFIGURATION_INVALID'].includes(error.code))return error.code;
  return 'CREDIT_READ_FAILED';
}

/** Administrative balance reads use the same Miora API and proxy, never generation APIs. */
export class ManagedAccountOperations {
  private active=0;
  private waiters:Array<()=>void>=[];
  private pending=new Map<string,Promise<Outcome>>();
  private background?:Promise<void>;
  private closed=false;
  readonly cleanupMinimumCredits:number|null;
  constructor(private store:ChannelStore,private options:Options){
    this.cleanupMinimumCredits=options.minimumCredits??null;
    if(!options.readCredits&&options.proxyUrl){assertVideoGatewayProxyConfiguration(true,options.proxyUrl);useMioraProxy(options.proxyUrl,'',options.proxyAddress,true);}
  }
  private selected(ids?:readonly string[]) { const selected=[...new Set(ids??this.store.ids())];for(const id of selected)if(!this.store.row(id))throw new SystemError(404,'ACCOUNT_UNAVAILABLE','Channel account is unavailable');return selected; }
  private async bounded<T>(work:()=>Promise<T>):Promise<T>{if(this.active>=2)await new Promise<void>(resolve=>this.waiters.push(resolve));else this.active++;try{return await work();}finally{const next=this.waiters.shift();if(next)next();else this.active--;}}
  private async archive(row:ChannelAccountRow,reason:ManagedArchiveReason):Promise<boolean>{
    if(this.options.busy(row.id)||!this.store.archiveIfCurrent(row,reason))return false;
    // Archival is already committed; callback failures must not rewrite a successful balance as a failed read.
    try{this.options.onArchive?.(row.id,reason);}catch{}
    try{await this.options.changed?.();}catch{}
    return true;
  }
  private async inspect(id:string,skipBusy:boolean):Promise<Outcome>{
    const {row,tokens}=this.store.credentials(id);
    if(row.archived_at||skipBusy&&this.options.busy(id))return {success:false,archived:false,failed:false};
    let expected=row;
    let currentTokens=tokens;
    const expired=()=>{const expiry=tokenExpiresAt(currentTokens.authToken);return expiry!==undefined&&Number.isFinite(expiry)&&expiry<=Date.now();};
    if(expired()&&!tokens.refreshToken){this.store.recordCredits(id,expected.encrypted,{errorCode:'AUTH_EXPIRED'});const archived=await this.archive(expected,'credentials-expired');return {success:false,archived,failed:false};}
    try {
      const onTokens=async(previous:MioraTokens,renewed:MioraTokens)=>{
        if(!sameTokens(previous,currentTokens)||!this.store.renewIfCurrent(id,expected.encrypted,renewed))throw new SystemError(409,'ACCOUNT_CHANGED','Channel credentials changed during the check');
        expected=this.store.row(id)!;
        currentTokens=renewed;
      };
      if(!this.options.readCredits)assertVideoGatewayProxyConfiguration(true,this.options.proxyUrl);
      const balance=await (this.options.readCredits?this.options.readCredits(tokens,onTokens):new MioraClient(tokens,onTokens).getCredits(AbortSignal.timeout(15000)));
      if(typeof balance?.totalCredits!=='number'||!Number.isFinite(balance.totalCredits)||balance.totalCredits<0)throw new SystemError(400,'INVALID_CREDIT_RESPONSE','Provider balance is invalid');
      if(!this.store.recordCredits(id,expected.encrypted,{credits:balance.totalCredits,checkedAt:new Date().toISOString()}))return {success:false,archived:false,failed:true};
      const archived=this.cleanupMinimumCredits!==null&&balance.totalCredits<this.cleanupMinimumCredits?await this.archive(expected,'insufficient-credits'):false;
      return {success:true,archived,failed:false};
    } catch(error){
      const code=errorCode(error);this.store.recordCredits(id,expected.encrypted,{errorCode:code});
      const dead=expired()&&error instanceof MioraApiError&&error.apiCode==='REFRESH_TOKEN_DEAD'&&error.path==='/api/auth/refresh-token'&&error.status!==429;
      const archived=dead?await this.archive(expected,'credentials-expired'):false;
      return {success:false,archived,failed:!archived};
    }
  }
  private one(id:string,skipBusy=false):Promise<Outcome>{
    const existing=this.pending.get(id);if(existing)return existing;
    const operation=this.bounded(()=>this.inspect(id,skipBusy)).catch(()=>({success:false,archived:false,failed:true}));
    this.pending.set(id,operation);void operation.finally(()=>{if(this.pending.get(id)===operation)this.pending.delete(id);});return operation;
  }
  async refresh(ids?:readonly string[]){const selected=this.selected(ids),outcomes=await Promise.all(selected.map(id=>this.one(id)));return {checked:selected.length,succeeded:outcomes.filter(item=>item.success).length,failed:outcomes.filter(item=>!item.success).length};}
  async cleanup(ids?:readonly string[]){const selected=this.selected(ids),outcomes=await Promise.all(selected.map(id=>this.one(id,true)));const archived=outcomes.filter(item=>item.archived).length,failed=outcomes.filter(item=>item.failed).length;return {checked:selected.length,archived,retained:selected.length-archived,failed};}
  async confirmedBalance(id:string,cookies:readonly BrowserCookie[],credits:number,checkedAt:string):Promise<boolean>{
    const current=this.store.credentials(id),expected=readMioraTokens(cookies);if(current.row.archived_at||!expected||!sameTokens(expected,current.tokens)||!Number.isFinite(credits)||credits<0)return false;
    this.store.recordCredits(id,current.row.encrypted,{credits,checkedAt});
    return this.cleanupMinimumCredits!==null&&credits<this.cleanupMinimumCredits?this.archive(current.row,'insufficient-credits'):false;
  }
  schedule(ids?:readonly string[]):void {if(this.closed||this.background)return;this.background=this.cleanup(ids).then(()=>undefined).catch(()=>undefined).finally(()=>{this.background=undefined;});}
  async close():Promise<void>{this.closed=true;await this.background;await Promise.allSettled([...this.pending.values()]);}
}
