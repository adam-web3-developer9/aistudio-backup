import { SystemError } from './types.js';
/** Per-principal budgets apply before parsing large project bodies. No caller-supplied IP key. */
export class SystemRequestBudget {
  private buckets=new Map<string,{until:number;count:number}>();
  constructor(private clock:()=>number=Date.now){}
  consume(userId:string,group:string,max:number){
    const now=this.clock();
    for(const [key,value]of this.buckets)if(value.until<=now)this.buckets.delete(key);
    const key=userId+':'+group;const current=this.buckets.get(key);
    if(!current&&this.buckets.size>=50000)throw new SystemError(429,'RATE_LIMITED','Request capacity reached');
    const bucket=current??{until:now+60000,count:0};
    if(bucket.count>=max)throw new SystemError(429,'RATE_LIMITED','Too many project requests; retry later');
    bucket.count++;this.buckets.set(key,bucket);
  }
}
