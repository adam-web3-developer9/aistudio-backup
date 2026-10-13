import {test, expect} from '@playwright/test';

test('超过512KiB凭据文件流式提取真实账户字段再提交，不保留无关容器正文',async({page})=>{
  test.setTimeout(60000);
  const payloads:any[]=[];
  const authToken='eyJhbGciOiJub25lIn0.'+Buffer.from(JSON.stringify({sub:'fixture',exp:4102444800})).toString('base64url')+'.fake';
  await page.route('**/api/**',async route=>{
    const req=route.request(),path=new URL(req.url()).pathname;let body:unknown={data:[],total:0};
    if(path==='/api/admin/me')body={id:'fixture-admin',email:'fixture@invalid.test',role:'superadmin'};
    if(path.endsWith('/miora/import')){payloads.push(req.postDataJSON());body={id:'managed-miora-'+'1'.repeat(24)};}
    await route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto('./');await page.getByRole('menuitem',{name:/渠道账户/}).click();
  await page.getByRole('button',{name:'导入 Miora 凭据',exact:true}).click();
  await page.getByLabel('选择本地凭据文件').setInputFiles({name:'large-export.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({authToken,padding:'irrelevant-container-'.repeat(100000)}))});
  await expect(page.getByLabel('Miora 导出 JSON 或 Cookie 文本')).toHaveValue(JSON.stringify({authToken}));
  await page.getByRole('dialog').getByRole('button',{name:/确定$/}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(payloads).toHaveLength(1);expect(payloads[0]).toEqual({credentials:JSON.stringify({authToken})});
  expect(await page.evaluate(()=>Object.values(localStorage).join('')+Object.values(sessionStorage).join(''))).not.toContain(authToken);
});

test('激活码一次创建250份内部分窗100，默认365天和一次显示保留',async({page})=>{
  const counts:number[]=[];
  await page.route('**/api/**',async route=>{
    const req=route.request(),path=new URL(req.url()).pathname;let body:unknown={data:[],total:0};
    if(path==='/api/admin/me')body={id:'fixture-admin',email:'fixture@invalid.test',role:'superadmin'};
    if(path==='/api/admin/activation-codes'&&req.method()==='POST'){
      const input=req.postDataJSON();counts.push(input.count);expect(input.validityDays).toBe(365);
      body={data:Array.from({length:input.count},(_,i)=>({id:`test-code-${counts.length}-${i}`,code:`ONCE-${counts.length}-${i}`}))};
    }
    await route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto('./');await page.getByRole('menuitem',{name:/激活码/}).click();
  await page.getByRole('button',{name:'创建激活码',exact:true}).click();
  await page.getByLabel('数量',{exact:true}).fill('250');
  await page.getByRole('dialog').getByRole('button',{name:'确定',exact:true}).click();
  const output=page.getByRole('dialog');await expect(output.getByText('ONCE-3-49',{exact:true})).toBeVisible();
  expect(counts).toEqual([100,100,50]);
  await output.getByRole('button',{name:'已保存，关闭',exact:true}).click();
  await expect(page.getByText('ONCE-3-49',{exact:true})).toHaveCount(0);
});

test('激活码创建未知窗停止，保留已收到明文和准确未提交数量',async({page})=>{
  let calls=0;
  await page.route('**/api/**',async route=>{
    const req=route.request(),path=new URL(req.url()).pathname;let body:unknown={data:[],total:0},status=200;
    if(path==='/api/admin/me')body={id:'fixture-admin',email:'fixture@invalid.test',role:'superadmin'};
    if(path==='/api/admin/activation-codes'&&req.method()==='POST'){
      calls++;if(calls===2){status=503;body={message:'测试回执丢失'};}else body={data:Array.from({length:100},(_,i)=>({id:`first-${i}`,code:`SAVE-FIRST-${i}`}))};
    }
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto('./');await page.getByRole('menuitem',{name:/激活码/}).click();
  await page.getByRole('button',{name:'创建激活码',exact:true}).click();
  await page.getByLabel('数量',{exact:true}).fill('250');await page.getByRole('dialog').getByRole('button',{name:'确定',exact:true}).click();
  const output=page.getByRole('dialog');await expect(output.getByText('SAVE-FIRST-99',{exact:true})).toBeVisible();
  await expect(output.getByText(/当前批次 100 个结果尚未确认，后续 50 个未提交/)).toBeVisible();
  expect(calls).toBe(2);
});
