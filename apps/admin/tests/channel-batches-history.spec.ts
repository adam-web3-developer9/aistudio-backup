import {test, expect} from "@playwright/test";

test("跨页全选超过500账户自动分批，部分失败和请求失败只重试未完成项", async ({page}) => {
  await page.setViewportSize({width: 1800, height: 1200});
  const rows = Array.from({length: 501}, (_,i) => ({id: `managed-miora-${(i+1).toString(16).padStart(24,"0")}`, label: `批账户 ${i+1}`, enabled: true}));
  const batches: string[][] = [];
  let retry = false;
  await page.route("**/api/**", async route => {
    const req=route.request(), url=new URL(req.url());
    let data: unknown={data:[],total:0}, status=200;
    if(url.pathname==="/api/admin/me")data={id:"admin-fixture",email:"admin@invalid.test",role:"superadmin"};
    else if(url.pathname==="/api/admin/channels/accounts"){
      const page=Number(url.searchParams.get("page")),size=Number(url.searchParams.get("pageSize"));
      data={data:rows.slice((page-1)*size,page*size),total:rows.length};
    }else if(url.pathname.endsWith("/batch")){
      const body=req.postDataJSON();expect(body.partial).toBe(true);expect(body.ids.length).toBeLessThanOrEqual(500);
      batches.push(body.ids);
      if(!retry&&batches.length===2){status=503;data={message:"测试请求失败"};}
      else {
        data={updated:body.ids.length-(retry?0:1),results:body.ids.map((id:string)=>({id,status:!retry&&id===rows[6].id?"failed":"succeeded",...(!retry&&id===rows[6].id?{code:"ACCOUNT_ARCHIVED",message:"测试逐项失败"}:{})}))};
      }
    }
    await route.fulfill({status,contentType:"application/json",body:JSON.stringify(data)});
  });
  await page.goto("./");await page.getByRole("menuitem",{name:/渠道账户/}).click();
  const table=page.locator(".resource-card");
  await table.getByRole("row").filter({has:page.getByText("批账户 1",{exact:true})}).getByRole("checkbox").check();
  await table.getByTitle("下一页").click();
  await expect(page.getByText("已选 1 个",{exact:true})).toBeVisible();
  await table.getByRole("row").filter({hasText:"批账户 21"}).getByRole("checkbox").check();
  await expect(page.getByText("已选 2 个",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"选择全部匹配账户",exact:true}).click();
  await expect(page.getByText("已选 501 个",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"批量停用",exact:true}).click();
  await page.getByRole("button",{name:"确定",exact:true}).click();
  await expect(page.getByText("停用结果：成功 499 个，失败 1 个，尚未确认 1 个。",{exact:true}).first()).toBeVisible();
  expect(batches.map(ids=>ids.length)).toEqual([500,1]);
  await expect(page.getByText("已选 2 个",{exact:true})).toBeVisible();
  await expect(page.getByText(/测试逐项失败/)).toBeVisible();
  retry=true;
  await page.getByRole("button",{name:"仅重试未完成账户",exact:true}).click();
  await page.getByRole("button",{name:"确定",exact:true}).click();
  await expect(page.getByText("停用结果：成功 501 个，失败 0 个，尚未确认 0 个。",{exact:true}).first()).toBeVisible();
  expect(batches[2]).toEqual([rows[6].id,rows[500].id]);
  await expect(page.getByText("已选 0 个",{exact:true})).toBeVisible();
});

test("关联任务翻页发送真实页码并显示全部205条总数", async ({page}) => {
  const pages:number[]=[];
  await page.route("**/api/**",async route=>{
    const url=new URL(route.request().url());let data:unknown={data:[],total:0};
    if(url.pathname==="/api/admin/me")data={id:"test-admin",email:"test@invalid.test",role:"superadmin"};
    else if(url.pathname==="/api/admin/channels/accounts")data={data:[{id:"managed-miora-"+"1".repeat(24),label:"分页账户",enabled:true}],total:1};
    else if(url.pathname.endsWith("/jobs")){
      const page=Number(url.searchParams.get("page")),size=Number(url.searchParams.get("pageSize"));pages.push(page);
      data={data:Array.from({length:Math.min(size,205-(page-1)*size)},(_,index)=>({id:`test-job-${(page-1)*size+index+1}`,kind:"miora.video",status:"failed"})),total:205};
    }
    await route.fulfill({contentType:"application/json",body:JSON.stringify(data)});
  });
  await page.goto("./");await page.getByRole("menuitem",{name:/渠道账户/}).click();
  await page.getByRole("button",{name:"关联任务",exact:true}).click();
  const modal=page.getByRole("dialog");await expect(modal.getByText("test-job-1",{exact:true})).toBeVisible();
  await modal.getByTitle("下一页").click();
  await expect(modal.getByText("test-job-11",{exact:true})).toBeVisible();
  await expect(modal.getByText("test-job-1",{exact:true})).toHaveCount(0);
  expect([...new Set(pages)]).toEqual([1,2]);
});
