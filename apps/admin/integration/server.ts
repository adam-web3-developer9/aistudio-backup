import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { buildSystemWebApp } from "../../../src/system/web-app.ts";
import { MemorySystemMailer } from "../../../src/system/mail.ts";
const directory = process.env.ADMIN_E2E_DIR!;
if (!directory?.startsWith("/tmp/aistudio-admin-integration-"))
  throw new Error(
    "Integration fixtures must stay in an isolated /tmp directory",
  );
await mkdir(directory, { recursive: true, mode: 0o700 });
const baseUrl = "http://127.0.0.1:5277";
const mailer = new MemorySystemMailer();
const { app, runtime } = await buildSystemWebApp({
  databasePath: path.join(directory, "system.sqlite"),
  secret: "isolated-admin-e2e-secret-never-for-production",
  baseUrl,
  mailer,
  testMode: true,
  channelsEnabled: false,
  credentialKey: Buffer.alloc(32, 7).toString("base64"),
  mediaDirectory: path.join(directory, "media"),
  adminDirectory: path.resolve("dist"),
});
const password = "Isolated-E2E-Password-2026";
const users: Record<string, { id: string; email: string }> = {};
for (const [label, role] of [
  ["superadmin", "superadmin"],
  ["readonly", "readonly"],
  ["operator", "operator"],
  ["owner", null],
  ["member", null],
  ["redeemer", null],
] as const) {
  const email = `${label}@example.invalid`;
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers: { origin: baseUrl, "content-type": "application/json" },
    payload: { email, name: label, password },
  });
  if (response.statusCode !== 200)
    throw new Error(
      `Fixture signup failed: ${label} HTTP ${response.statusCode}`,
    );
  const id = response.json().user.id;
  const url = new URL(mailer.messages.find((m) => m.to === email)!.url);
  const verified = await app.inject({
    method: "GET",
    url: url.pathname + url.search,
  });
  if (verified.statusCode !== 302)
    throw new Error(`Fixture verification failed: ${label}`);
  const now = new Date().toISOString();
  if (role)
    runtime.db
      .prepare(
        "INSERT INTO system_administrators(user_id,role,created_at,updated_at) VALUES(?,?,?,?)",
      )
      .run(id, role, now, now);
  if (label !== "redeemer")
    runtime.db
      .prepare(
        "UPDATE system_accounts SET ever_activated=1,valid_until=?,sharing_eligible=1 WHERE user_id=?",
      )
      .run(new Date(Date.now() + 86400000 * 365).toISOString(), id);
  users[label] = { id, email };
}
const ownerLogin = await app.inject({
  method: "POST",
  url: "/api/auth/sign-in/email",
  headers: { origin: baseUrl, "content-type": "application/json" },
  payload: { email: users.owner.email, password },
});
if (ownerLogin.statusCode !== 200)
  throw new Error("Fixture owner login failed");
const cookie = ownerLogin.cookies
  .map((cookie) => `${cookie.name}=${cookie.value}`)
  .join("; ");
const shared = await app.inject({
  method: "POST",
  url: "/api/system/projects/integration-project/share",
  headers: { origin: baseUrl, "content-type": "application/json", cookie },
  payload: {
    requestId: "integration-fixture-share",
    snapshot: {
      entities: [
        {
          type: "draft",
          id: "private-draft",
          fields: {
            title: "Private integration draft",
            body: "PRIVATE-BODY-MUST-NOT-LEAK",
          },
        },
      ],
      collections: { drafts: ["private-draft"] },
    },
    members: [{ userId: users.member.id, role: "editor" }],
  },
});
if (shared.statusCode !== 200)
  throw new Error(`Fixture project share failed HTTP ${shared.statusCode}`);
const token = [
  Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
    "base64url",
  ),
  Buffer.from(
    JSON.stringify({
      sub: "isolated-fake-miora-account",
      exp: Math.floor(Date.now() / 1000) + 86400,
      email: "fake-channel@example.invalid",
    }),
  ).toString("base64url"),
  "FAKE_SIGNATURE_FOR_ISOLATED_TEST",
].join(".");
await writeFile(
  path.join(directory, "fixtures.json"),
  JSON.stringify({
    users,
    password,
    token,
    databasePath: path.join(directory, "system.sqlite"),
    mailerCount: mailer.messages.length,
  }),
  { mode: 0o600 },
);
const stop = async () => {
  await app.close();
  await rm(directory, { recursive: true, force: true });
  process.exit(0);
};
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
await app.listen({ host: "127.0.0.1", port: 5277 });
