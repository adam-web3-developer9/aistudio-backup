import { expect, test } from 'vitest';
import { SystemRequestBudget } from './request-budget.js';
test('project budgets isolate authenticated users and expire without trusting caller network headers',()=>{
 let now=0;const budget=new SystemRequestBudget(()=>now);
 budget.consume('verified-A','media',1);
 expect(()=>budget.consume('verified-A','media',1)).toThrow('Too many');
 expect(()=>budget.consume('verified-B','media',1)).not.toThrow();
 expect(()=>budget.consume('verified-A','jobs',1)).not.toThrow();
 now=60000;expect(()=>budget.consume('verified-A','media',1)).not.toThrow();
});
