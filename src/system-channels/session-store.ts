import { SessionStore } from '../stores/session-store.js';
import { readMioraTokens } from '../adapters/miora-api.js';
import type { BrowserCookie } from '../types.js';
import type { ChannelStore } from './store.js';
/** Existing channel workers use this store; managed cookies never go to JSON files. */
export class ManagedSessionStore extends SessionStore {
  constructor(dataDir:string,private readonly channels:ChannelStore){super(dataDir);}
  override async get(id:string){return this.channels.row(id)?this.channels.session(id):super.get(id);}
  override async list(){const managed=this.channels.sessions();const credentials=new Set(managed.map(session=>readMioraTokens(session.cookies)?.authToken));const legacy=(await super.list()).filter(session=>session.adapterId!=='miora-v1'||!credentials.has(readMioraTokens(session.cookies)?.authToken));return [...legacy,...managed];}
  override async put(id:string,adapterId:string,cookies:BrowserCookie[]){if(this.channels.row(id)){const tokens=readMioraTokens(cookies);if(adapterId!=='miora-v1'||!tokens)throw new Error('Managed account accepts only Miora credentials');this.channels.renew(id,tokens);return this.channels.session(id)!;}return super.put(id,adapterId,cookies);}
  override async delete(id:string){if(this.channels.row(id)){this.channels.update(id,{enabled:false});return;}return super.delete(id);}
}
