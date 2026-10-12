import { test, expect, type Page } from "@playwright/test";
type Role = "superadmin" | "operator" | "readonly";
async function fakeApi(page: Page, role: Role, loggedIn = true) {
  const calls: { path: string; method: string; body: any }[] = [];
  let signedIn = loggedIn;
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname,
      body = req.postDataJSON(),
      method = req.method();
    calls.push({ path, method, body });
    const reply = (data: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(data),
      });
    if (
      method !== "GET" &&
      (req.headers()["content-type"] !== "application/json" || body === null)
    )
      return reply({ message: "mutation requires JSON body" }, 415);
    if (path === "/api/admin/me")
      return reply(
        signedIn
          ? {
              id: "admin-one",
              email: "admin@example.com",
              name: "测试管理员",
              role,
            }
          : { message: "请登录" },
        signedIn ? 200 : 401,
      );
    if (path === "/api/auth/sign-in/email") {
      signedIn = true;
      return reply({ user: { id: "admin-one" } });
    }
    if (path === "/api/auth/sign-out") {
      signedIn = false;
      return reply({ success: true });
    }
    if (path === "/api/admin/users" || path === "/api/admin/sharing-whitelist")
      return reply({
        data: [
          {
            id: "user-one",
            email: "user@example.com",
            name: "测试账户",
            emailVerified: true,
            disabled: false,
            sharingEligible: true,
            validUntil: "2027-10-11T00:00:00Z",
          },
        ],
        total: 1,
      });
    if (path === "/api/admin/activation-codes" && method === "POST")
      return reply(
        {
          data: [
            {
              id: "code-one",
              code: "ONCE-ONLY-FAKE-CODE",
              status: "available",
              validityDays: body.validityDays,
            },
          ],
        },
        201,
      );
    if (path === "/api/admin/activation-codes")
      return reply({
        data: [
          {
            id: "code-one",
            status: "available",
            validityDays: 365,
            createdAt: "2026-10-11T00:00:00Z",
          },
        ],
        total: 1,
      });
    if (path === "/api/admin/projects")
      return reply({
        data: [
          {
            projectId: "project-one",
            ownerId: "user-one",
            shared: true,
            revision: 3,
            canManageMembers: role !== "readonly",
            members: [
              { userId: "user-one", role: "owner" },
              { userId: "member-one", role: "editor" },
            ],
          },
        ],
        total: 1,
      });
    if (path === "/api/admin/channels/accounts")
      return reply({
        data: [
          {
            id: "channel-one",
            label: "演示渠道",
            provider: "miora",
            enabled: true,
            validationStatus: "unknown",
            localCredentialStatus: "imported",
            remoteValidationPerformed: false,
          },
        ],
        total: 1,
      });
    if (
      path.endsWith("/jobs") &&
      path.startsWith("/api/admin/channels/accounts/")
    )
      return reply({
        data: [
          {
            id: "fake-job-one",
            kind: "image",
            status: "failed",
            errorCode: "FAKE_UPSTREAM_ERROR",
            resultAvailable: false,
            createdAt: "2026-10-11T00:00:00Z",
          },
        ],
        total: 1,
      });
    if (path.includes("/members/"))
      return reply({
        members: [
          { userId: "user-one", role: "owner" },
          { userId: "member-one", role: "viewer" },
        ],
      });
    if (
      path.startsWith("/api/admin/channels/accounts") ||
      path.startsWith("/api/admin/users/") ||
      path.startsWith("/api/admin/projects/")
    )
      return reply({ success: true });
    if (path === "/api/admin/audit") return reply({ data: [], total: 0 });
    return reply({ message: "假 API 未实现此路由" }, 404);
  });
  return calls;
}

test("凭据文件多选批量导入超过20份，独立失败与结果清空", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const calls = await fakeApi(page, "superadmin");
  const imported: string[] = [];
  await page.route("**/api/admin/channels/accounts/miora/import", async (route) => {
    const credentials = route.request().postDataJSON().credentials;
    imported.push(credentials);
    await route.fulfill({
      status: credentials === "FAKE-REJECTED" ? 400 : 200,
      contentType: "application/json",
      body: JSON.stringify(credentials === "FAKE-REJECTED"
        ? { code: "INVALID_CREDENTIALS", message: "无效的凭据" }
        : { id: `channel-${imported.length}` }),
    });
  });
  await page.goto("./");
  await page.getByRole("menuitem", { name: /渠道账户/ }).click();
  await page.getByRole("button", { name: "导入 Miora 凭据" }).click();
  const dialog = page.getByRole("dialog");
  const files = Array.from({ length: 23 }, (_, index) => ({
    name: `account-${index + 1}.json`,
    mimeType: "application/json",
    buffer: Buffer.from(index === 1 ? "FAKE-REJECTED" : `FAKE-CREDENTIAL-${index + 1}`),
  }));
  await page.getByLabel("更新账户 ID（新导入留空）").fill("channel-one");
  await page.getByLabel("账户标签", { exact: true }).fill("批量账户");
  await page.getByLabel("选择本地凭据文件").setInputFiles([
    ...files,
    { name: "empty.txt", mimeType: "text/plain", buffer: Buffer.alloc(0) },
    { name: "wrong.csv", mimeType: "text/csv", buffer: Buffer.from("FAKE-WRONG") },
  ]);
  await expect(dialog.getByText("已选择 25 个文件，待导入 23 份")).toBeVisible();
  expect(imported).toHaveLength(0);
  await dialog.getByRole("button", { name: "批量导入（23）" }).click();
  await expect(dialog.getByText("批量导入时请留空更新账户 ID。")).toBeVisible();
  expect(imported).toHaveLength(0);
  await page.getByLabel("更新账户 ID（新导入留空）").fill("");
  await dialog.getByRole("button", { name: "批量导入（23）" }).click();
  await expect(dialog.getByText("导入完成：成功 22 份，失败 3 份。新账户已自动启用，已有账户保留原状态。请重新选择失败文件后导入。")).toBeVisible();
  expect(imported).toEqual(files.map((file) => file.buffer.toString()));
  await expect(dialog.getByText("导入成功", { exact: true })).toHaveCount(22);
  await expect(dialog.getByText("导入失败", { exact: true })).toHaveCount(1);
  await expect(dialog.getByText("文件无效", { exact: true })).toHaveCount(2);
  await expect(dialog.getByRole("button", { name: "批量导入", exact: true })).toBeDisabled();
  expect(await dialog.innerText()).not.toContain("FAKE-CREDENTIAL");
  expect(await page.evaluate(() => Object.values(localStorage).join(""))).not.toContain("FAKE-CREDENTIAL");
  await page.screenshot({ path: "evidence/batch-credential-import.png", fullPage: true });
  await dialog.locator(".ant-modal-footer").getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "导入 Miora 凭据" }).click();
  await expect(page.getByLabel("Miora 导出 JSON 或 Cookie 文本")).toHaveValue("");
  await expect(page.getByLabel("选择本地凭据文件")).toHaveValue("");
  await expect(dialog.getByText("account-1.json", { exact: true })).toHaveCount(0);
  // Single-file import still supports updating a specified account.
  await page.getByLabel("更新账户 ID（新导入留空）").fill("channel-one");
  await page.getByLabel("选择本地凭据文件").setInputFiles(files[0]);
  await expect(page.getByLabel("Miora 导出 JSON 或 Cookie 文本")).toHaveValue("FAKE-CREDENTIAL-1");
  await expect(dialog.getByRole("button", { name: /确定$/ })).toBeEnabled();
  await dialog.getByRole("button", { name: /确定$/ }).click();
  await expect(dialog).toHaveCount(0);
  expect(calls.find((call) => call.method === "PATCH" && call.path.endsWith("/channel-one"))?.body)
    .toEqual({ credentials: "FAKE-CREDENTIAL-1" });
});
test("渠道全局统计不随搜索或分页改变", async ({ page }) => {
  await page.setViewportSize({ width: 1720, height: 1080 });
  await fakeApi(page, "superadmin");
  const statistics = {
    total: 27, enabled: 10, disabled: 4, archived: 13,
    usable: 8, usableCredits: 2000.25, unchecked: 1, failed: 1, lowCredit: 0,
    minimumCredits: 26.48, minimumVideoCount: 73,
    lastCheckedAt: "2026-10-12T12:30:00Z",
  };
  const queries: URLSearchParams[] = [];
  await page.route("**/api/admin/channels/accounts?*", async route => {
    const query = new URL(route.request().url()).searchParams;
    queries.push(query);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      data: [{ id: "managed-miora-" + "1".repeat(24), label: "统计测试账号", provider: "miora", enabled: true, credits: 100, creditStatus: "ok" }],
      total: query.get("q") ? 1 : 27, statistics,
    }) });
  });
  await page.goto("./");
  await page.getByRole("menuitem", { name: /渠道账户/ }).click();
  await expect(page.getByText("总账号", { exact: true })).toBeVisible();
  await expect(page.getByText("可用账号", { exact: true })).toBeVisible();
  await expect(page.getByText("可用积分", { exact: true })).toBeVisible();
  await expect(page.getByText("2,000.25", { exact: true })).toBeVisible();
  await page.getByRole("listitem", { name: "2", exact: true }).click();
  await expect.poll(() => queries.some(query => query.get("page") === "2")).toBe(true);
  await expect(page.getByText("2,000.25", { exact: true })).toBeVisible();
  await page.getByRole("searchbox", { name: "搜索记录" }).fill("统计测试");
  await page.getByRole("searchbox", { name: "搜索记录" }).press("Enter");
  await expect(page.getByText("匹配 1 个账户", { exact: true })).toBeVisible();
  await expect(page.getByText("2,000.25", { exact: true })).toBeVisible();
  await expect(page.locator(".channel-summary-grid .ant-card").first().getByText("27", { exact: true })).toBeVisible();
  await page.screenshot({ path: "../../tmp/admin-channel-statistics.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText("总账号", { exact: true })).toBeVisible();
  await expect(page.getByText("可用账号", { exact: true })).toBeVisible();
  await expect(page.getByText("可用积分", { exact: true })).toBeVisible();
  await expect(page.getByText("估算最短视频数", { exact: true })).toBeVisible();
  await page.screenshot({ path: "../../tmp/admin-channel-statistics-mobile.png", fullPage: true });
});

test("渠道批量管理、真实积分状态和可恢复清理", async ({ page }) => {
  await page.setViewportSize({ width: 1720, height: 1080 });
  await fakeApi(page, "superadmin");
  const ids = ["1", "2", "3"].map(value => `managed-miora-${value.repeat(24)}`);
  const rows: any[] = [
    { id: ids[0], label: "一号 Miora", provider: "miora", enabled: true, credits: 100, creditStatus: "ok", creditsCheckedAt: "2026-10-12T12:00:00Z", localCredentialStatus: "imported" },
    { id: ids[1], label: "二号 Miora", provider: "miora", enabled: true, credits: null, creditStatus: "unknown", localCredentialStatus: "imported" },
    { id: ids[2], label: "三号 Miora", provider: "miora", enabled: true, credits: 31.5, creditStatus: "error", lastErrorCode: "CREDIT_READ_FAILED", creditsCheckedAt: "2026-10-12T11:00:00Z", localCredentialStatus: "imported" },
  ];
  const operations: { path: string; body: any }[] = [];
  await page.route("**/api/admin/channels/accounts**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const body = request.postDataJSON();
    let result: unknown = { data: rows, total: rows.length };
    if (request.method() !== "GET") {
      operations.push({ path, body });
      if (path.endsWith("/batch")) {
        for (const row of rows) if (body.ids.includes(row.id)) row.enabled = body.action === "enable";
        result = { updated: body.ids.length, accounts: rows.filter(row => body.ids.includes(row.id)) };
      } else if (path.endsWith("/credits/refresh")) {
        rows[1].credits = 15.52; rows[1].creditStatus = "ok";
        result = { checked: 3, succeeded: 2, failed: 1 };
      } else if (path.endsWith("/cleanup")) {
        rows[1].enabled = false; rows[1].archivedAt = "2026-10-12T12:01:00Z";
        rows[1].cleanupReason = "insufficient-credits";
        result = { checked: 3, archived: 1, retained: 2, failed: 1 };
      }
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(result) });
  });
  await page.goto("./");
  await page.getByRole("menuitem", { name: /渠道账户/ }).click();
  await expect(page.getByText("未查询", { exact: true })).toBeVisible();
  await expect(page.getByText("读取失败", { exact: true })).toBeVisible();
  await expect(page.getByText("上次成功：31.5 积分", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "批量停用", exact: true })).toBeDisabled();
  await page.getByRole("row").filter({ hasText: "一号 Miora" }).getByRole("checkbox").check();
  await expect(page.getByText("已选 1 个", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "批量停用", exact: true }).click();
  await page.getByRole("button", { name: "确定", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: "一号 Miora" }).getByText("已停用", { exact: true })).toBeVisible();
  expect(operations[0]).toEqual({ path: "/api/admin/channels/accounts/batch", body: { ids: [ids[0]], action: "disable" } });
  await expect(page.getByText("已选 0 个", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /刷新全部积分$/ }).click();
  await expect(page.getByRole("row").filter({ hasText: "二号 Miora" }).getByText("15.52", { exact: true })).toBeVisible();
  expect(operations[1]).toEqual({ path: "/api/admin/channels/accounts/credits/refresh", body: {} });
  await page.getByRole("button", { name: "清理无效账户", exact: true }).click();
  await page.getByRole("button", { name: "确定", exact: true }).click();
  const archivedRow = page.getByRole("row").filter({ hasText: "二号 Miora" });
  await expect(archivedRow.getByText("已归档", { exact: true })).toBeVisible();
  await expect(archivedRow.getByText("不足最低生成额度", { exact: true })).toBeVisible();
  await expect(page.getByText(/检查 3 个，归档 1 个，保留 2 个，读取失败 1 个/).first()).toBeVisible();
  expect(operations).toHaveLength(3);
  await page.screenshot({ path: "../../tmp/admin-channel-management.png", fullPage: true });
});

test("登录、账户操作、激活码只显示一次", async ({ page }) => {
  const calls = await fakeApi(page, "operator", false);
  await page.goto("./");
  await expect(
    page.getByRole("heading", { name: "登录管理后台" }),
  ).toBeVisible();
  await page.getByLabel("邮箱", { exact: true }).fill("admin@example.com");
  await page.getByLabel("密码", { exact: true }).fill("fake-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByText("user@example.com", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "撤销会话", exact: true }).click();
  await page.getByRole("button", { name: "确定", exact: true }).click();
  await expect
    .poll(() =>
      calls.some(
        (c) => c.path.endsWith("/revoke-sessions") && c.method === "POST",
      ),
    )
    .toBe(true);
  await page.getByRole("menuitem", { name: /激活码/ }).click();
  await page.getByRole("button", { name: "创建激活码", exact: true }).click();
  await expect(page.getByLabel("激活有效天数")).toHaveValue("365");
  await page.getByRole("button", { name: "确定", exact: true }).click();
  await expect(
    page.getByText("ONCE-ONLY-FAKE-CODE", { exact: true }),
  ).toBeVisible();
  expect(
    calls.find(
      (c) => c.path === "/api/admin/activation-codes" && c.method === "POST",
    )?.body,
  ).toMatchObject({ count: 1, validityDays: 365, redeemBefore: null });
  await page.getByRole("button", { name: "已保存，关闭" }).click();
  await expect(
    page.getByText("ONCE-ONLY-FAKE-CODE", { exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: "evidence/operator-codes.png",
    fullPage: true,
  });
});
test("只读角色禁止写入，渠道凭据仅超级管理员可导入", async ({ page }) => {
  const calls = await fakeApi(page, "readonly");
  await page.goto("./");
  await expect(
    page.getByRole("button", { name: "禁用", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: /管理员/ })).toHaveCount(0);
  await page.getByRole("menuitem", { name: /渠道账户/ }).click();
  await expect(
    page.getByRole("button", { name: "导入 Miora 凭据" }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: "更新凭据" })).toBeDisabled();
  expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
});
test("假渠道凭据导入与清空、成员权限修改、API 错误可见", async ({ page }) => {
  const calls = await fakeApi(page, "superadmin");
  await page.goto("./");
  await page.getByRole("menuitem", { name: /渠道账户/ }).click();
  await expect(page.getByText("未查询", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "导入 Miora 凭据" }).click();
  const fileInput = page.getByLabel("选择本地凭据文件");
  await fileInput.setInputFiles({
    name: "too-large.txt",
    mimeType: "text/plain",
    buffer: Buffer.alloc(512 * 1024 + 1, 65),
  });
  await expect(
    page.getByText("文件不能超过 512 KiB。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Miora 导出 JSON 或 Cookie 文本")).toHaveValue(
    "",
  );
  await expect(fileInput).toHaveValue("");
  await fileInput.setInputFiles({
    name: "credentials.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"token":"FAKE-COOKIE-ONLY"}'),
  });
  await expect(page.getByLabel("Miora 导出 JSON 或 Cookie 文本")).toHaveValue(
    '{"token":"FAKE-COOKIE-ONLY"}',
  );
  await expect(fileInput).toHaveValue("");
  expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  await page.getByRole("dialog").getByRole("button", { name: /确定$/ }).click();
  await expect
    .poll(() =>
      calls.some(
        (c) =>
          c.path === "/api/admin/channels/accounts/miora/import" &&
          c.body?.credentials,
      ),
    )
    .toBe(true);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "导入 Miora 凭据" }).click();
  await expect(page.getByLabel("Miora 导出 JSON 或 Cookie 文本")).toHaveValue(
    "",
  );
  await expect(page.getByLabel("选择本地凭据文件")).toHaveValue("");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  expect(
    await page.evaluate(() => Object.values(localStorage).join("")),
  ).not.toContain("FAKE-COOKIE-ONLY");
  await page.getByRole("button", { name: "关联任务" }).click();
  await expect(
    page.getByText("FAKE_UPSTREAM_ERROR", { exact: true }),
  ).toBeVisible();
  await page
    .locator(".ant-modal-footer")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.getByRole("button", { name: "归档", exact: true }).click();
  await page.getByRole("button", { name: "确定", exact: true }).click();
  await expect
    .poll(() =>
      calls.some(
        (c) =>
          c.path === "/api/admin/channels/accounts/channel-one" &&
          c.method === "DELETE",
      ),
    )
    .toBe(true);
  expect(
    calls.find(
      (c) =>
        c.path === "/api/admin/channels/accounts/channel-one" &&
        c.method === "DELETE",
    )?.body,
  ).toEqual({});
  await page.getByRole("menuitem", { name: /项目成员权限/ }).click();
  await page.getByRole("button", { name: "成员权限", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "添加 / 修改成员" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "降为查看者" }).last().click();
  await page.getByRole("button", { name: /确定$/ }).click();
  await expect
    .poll(() =>
      calls.some(
        (c) =>
          c.path.endsWith("/members/member-one") &&
          c.method === "PUT" &&
          c.body.role === "viewer",
      ),
    )
    .toBe(true);
  await page
    .locator(".ant-modal-footer")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.route("**/api/admin/system-jobs?*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ message: "测试渠道不可用" }),
    }),
  );
  await page.getByRole("menuitem", { name: /渠道任务/ }).click();
  await expect(page.getByText("测试渠道不可用")).toBeVisible();
  await expect(page.getByRole("button", { name: "重新加载" })).toBeVisible();
});
