import { rmSync } from "node:fs";
export default function cleanup() {
  const directory = process.env.ADMIN_E2E_DIR;
  if (!directory?.startsWith("/tmp/aistudio-admin-integration-"))
    throw new Error("Unexpected fixture directory");
  rmSync(directory, { recursive: true, force: true });
}
