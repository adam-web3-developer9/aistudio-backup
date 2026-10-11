import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
const origin = "http://127.0.0.1:5277";
const fixture = () =>
  JSON.parse(
    readFileSync(
      path.join(process.env.ADMIN_E2E_DIR!, "fixtures.json"),
      "utf8",
    ),
  );
async function login(page: Page, role: string) {
  const f = fixture();
  await page.goto("./");
  await page.getByLabel("邮箱", { exact: true }).fill(f.users[role].email);
  await page.getByLabel("密码", { exact: true }).fill(f.password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "账户管理", exact: true }),
  ).toBeVisible();
}
async function apiLogin(request: APIRequestContext, role: string) {
  const f = fixture();
  const result = await request.post(`${origin}/api/auth/sign-in/email`, {
    headers: { origin },
    data: { email: f.users[role].email, password: f.password },
  });
  expect(result.status()).toBe(200);
}
test.describe.configure({ mode: "serial" });
test("真实Cookie登录、激活码一次性显示、用户兑换与ACL授权", async ({
  page,
  playwright,
}) => {
  const f = fixture();
  await login(page, "superadmin");
  const cookies = await page.context().cookies();
  const session = cookies.find((c) => c.name.includes("session_token"));
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe("Lax");
  const me = await page.request.get(`${origin}/api/admin/me`);
  expect(me.status()).toBe(200);
  expect(await me.json()).toMatchObject({
    role: "superadmin",
    id: f.users.superadmin.id,
  });
  await page.getByRole("menuitem", { name: /激活码/ }).click();
  await page.getByRole("button", { name: "创建激活码", exact: true }).click();
  await expect(page.getByLabel("激活有效天数")).toHaveValue("365");
  const createdPromise = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/admin/activation-codes" &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: /确定$/ }).click();
  const created = await createdPromise;
  expect(created.status()).toBe(201);
  const code = (await created.json()).data[0].code;
  await expect(page.getByText(code, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "已保存，关闭" }).click();
  await expect(page.getByText(code, { exact: true })).toHaveCount(0);
  const list = await page.request.get(`${origin}/api/admin/activation-codes`);
  expect(JSON.stringify(await list.json())).not.toContain(code);
  const redeemer = await playwright.request.newContext();
  await apiLogin(redeemer, "redeemer");
  const redeemed = await redeemer.post(`${origin}/api/system/activate`, {
    headers: { origin },
    data: { code },
  });
  expect(redeemed.status()).toBe(200);
  const identity = await redeemer.get(`${origin}/api/system/me`);
  expect(await identity.json()).toMatchObject({
    everActivated: true,
    cloudEligible: true,
    role: null,
  });
  await redeemer.dispose();
  await page.getByRole("menuitem", { name: /项目成员权限/ }).click();
  await expect(
    page.getByText("integration-project", { exact: true }),
  ).toBeVisible();
  expect(await page.locator("body").innerText()).not.toContain(
    "PRIVATE-BODY-MUST-NOT-LEAK",
  );
  await page.getByRole("button", { name: "成员权限", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "添加 / 修改成员" }),
  ).toHaveCount(0);
  const aclPromise = page.waitForResponse(
    (r) =>
      r.url().includes(`/members/${f.users.member.id}`) &&
      r.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "降为查看者" }).last().click();
  await page.getByRole("button", { name: /确定$/ }).click();
  expect((await aclPromise).status()).toBe(200);
  await expect(
    page
      .getByRole("row")
      .filter({ hasText: f.users.member.id })
      .getByText("viewer", { exact: true }),
  ).toBeVisible();
  const elevated = await page.request.put(
    `${origin}/api/admin/projects/integration-project/members/${f.users.member.id}`,
    { headers: { origin }, data: { role: "editor" } },
  );
  expect(elevated.status()).toBe(403);
  expect((await elevated.json()).error.code).toBe(
    "OWNER_AUTHORIZATION_REQUIRED",
  );
  const selfGrant = await page.request.put(
    `${origin}/api/admin/projects/integration-project/members/${f.users.superadmin.id}`,
    { headers: { origin }, data: { role: "viewer" } },
  );
  expect(selfGrant.status()).toBe(403);
  expect((await selfGrant.json()).error.code).toBe(
    "OWNER_AUTHORIZATION_REQUIRED",
  );
  const denied = await page.request.get(
    `${origin}/api/system/projects/integration-project/snapshot`,
  );
  expect(denied.status()).toBe(403);
  const revokedPromise = page.waitForResponse(
    (r) =>
      r.url().includes(`/members/${f.users.member.id}`) &&
      r.request().method() === "DELETE",
  );
  await page
    .getByRole("row")
    .filter({ hasText: f.users.member.id })
    .getByRole("button", { name: /移除$/ })
    .click();
  await page.getByRole("button", { name: /确定$/ }).click();
  expect((await revokedPromise).status()).toBe(200);
  await expect(
    page.getByRole("row").filter({ hasText: f.users.member.id }),
  ).toHaveCount(0);

  await page
    .locator(".ant-modal-footer")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.screenshot({
    path: "evidence/real-project-acl.png",
    fullPage: true,
  });
});
test("真实凭据格式拒绝、加密持久化、未知远端验证和可恢复归档", async ({
  page,
}) => {
  const f = fixture();
  await login(page, "superadmin");
  await page.getByRole("menuitem", { name: /渠道账户/ }).click();
  await page.getByRole("button", { name: "导入 Miora 凭据" }).click();
  await page.getByLabel("Miora 导出 JSON 或 Cookie 文本").fill("NOT-A-COOKIE");
  const invalidPromise = page.waitForResponse((r) =>
    r.url().endsWith("/miora/import"),
  );
  await page.getByRole("button", { name: /确定$/ }).click();
  expect((await invalidPromise).status()).toBe(400);
  await expect(page.getByLabel("Miora 导出 JSON 或 Cookie 文本")).toHaveValue(
    "",
  );
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "A valid Miora export or token is required" })
      .last(),
  ).toBeVisible();
  await page.getByLabel("账户标签").fill("真实服务假渠道");
  await page.getByLabel("Miora 导出 JSON 或 Cookie 文本").fill(
    JSON.stringify({
      authToken: f.token,
      email: "fake-channel@example.invalid",
    }),
  );
  const importedPromise = page.waitForResponse((r) =>
    r.url().endsWith("/miora/import"),
  );
  await page.getByRole("button", { name: /确定$/ }).click();
  const imported = await importedPromise;
  expect(imported.status()).toBe(200);
  const account = await imported.json();
  expect(account.validationStatus).toBe("unknown");
  expect(JSON.stringify(account)).not.toContain(f.token);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("真实服务假渠道", { exact: true })).toBeVisible();
  await expect(page.getByText("远端会话未验证", { exact: true })).toBeVisible();
  const db = new Database(f.databasePath, { readonly: true });
  try {
    const row = db
      .prepare("SELECT encrypted FROM managed_channel_accounts WHERE id=?")
      .get(account.id) as { encrypted: string };
    expect(row.encrypted).not.toContain(f.token);
    expect(
      db.prepare("SELECT count(*) AS n FROM managed_channel_accounts").get(),
    ).toMatchObject({ n: 1 });
  } finally {
    db.close();
  }
  const validated = await page.request.post(
    `${origin}/api/admin/channels/accounts/${account.id}/validate`,
    { headers: { origin }, data: {} },
  );
  expect(validated.status()).toBe(200);
  expect(await validated.json()).toMatchObject({
    validationStatus: "unknown",
    localCredentialStatus: "format-and-decryption-passed",
    remoteValidationPerformed: false,
  });
  await page.getByRole("button", { name: "导入 Miora 凭据" }).click();
  await expect(page.getByLabel("Miora 导出 JSON 或 Cookie 文本")).toHaveValue(
    "",
  );
  await page.getByRole("button", { name: "取消", exact: true }).click();
  expect(
    await page.evaluate(
      () =>
        Object.values(localStorage).join("") +
        Object.values(sessionStorage).join(""),
    ),
  ).not.toContain(f.token);
  await page.getByRole("button", { name: "关联任务" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("dialog").locator(".ant-empty-description"),
  ).toBeVisible();
  await page
    .locator(".ant-modal-footer")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  const archivedPromise = page.waitForResponse(
    (r) => r.url().endsWith(account.id) && r.request().method() === "DELETE",
  );
  await page.getByRole("button", { name: "归档", exact: true }).click();
  await page.getByRole("button", { name: /确定$/ }).click();
  expect((await archivedPromise).status()).toBe(200);
  await expect(page.getByRole("button", { name: /恢复$/ })).toBeVisible();
  const restoredPromise = page.waitForResponse((r) =>
    r.url().endsWith("/restore"),
  );
  await page.getByRole("button", { name: /恢复$/ }).click();
  await page.getByRole("button", { name: /确定$/ }).click();
  expect((await restoredPromise).status()).toBe(200);
  await expect(page.getByRole("button", { name: /启用$/ })).toBeVisible();
  await expect(page.locator(".ant-popover:visible")).toHaveCount(0);
  await page.locator(".ant-table-content").evaluateAll((elements) =>
    elements.forEach((el) => {
      el.scrollLeft = 0;
    }),
  );
  await page.screenshot({
    path: "evidence/real-channel-unknown.png",
    fullPage: true,
  });
});
test("只读UI和真实服务拒写；运营无权读取任意项目正文", async ({
  page,
  playwright,
}) => {
  const f = fixture();
  await login(page, "readonly");
  await expect(
    page.getByRole("button", { name: "禁用", exact: true }).first(),
  ).toBeDisabled();
  const code = await page.request.post(`${origin}/api/admin/activation-codes`, {
    headers: { origin },
    data: {},
  });
  expect(code.status()).toBe(403);
  const user = await page.request.patch(
    `${origin}/api/admin/users/${f.users.member.id}`,
    { headers: { origin }, data: { disabled: true } },
  );
  expect(user.status()).toBe(403);
  const acl = await page.request.put(
    `${origin}/api/admin/projects/integration-project/members/${f.users.member.id}`,
    { headers: { origin }, data: { role: "editor" } },
  );
  expect(acl.status()).toBe(403);
  await page.getByRole("menuitem", { name: /渠道账户/ }).click();
  await expect(
    page.getByRole("button", { name: "导入 Miora 凭据" }),
  ).toBeDisabled();
  const imported = await page.request.post(
    `${origin}/api/admin/channels/accounts/miora/import`,
    {
      headers: { origin },
      data: { credentials: JSON.stringify({ authToken: f.token }) },
    },
  );
  expect(imported.status()).toBe(403);
  const operator = await playwright.request.newContext();
  await apiLogin(operator, "operator");
  const body = await operator.get(
    `${origin}/api/system/projects/integration-project/snapshot`,
  );
  expect(body.status()).toBe(403);
  const projects = await operator.get(`${origin}/api/admin/projects`);
  expect(projects.status()).toBe(200);
  expect(JSON.stringify(await projects.json())).not.toContain(
    "PRIVATE-BODY-MUST-NOT-LEAK",
  );
  await operator.dispose();
  const audit = await page.request.get(`${origin}/api/admin/audit`);
  const entries = JSON.stringify(await audit.json());
  expect(entries).toContain("channel.credentials.import");
  expect(entries).not.toContain(f.token);
});
