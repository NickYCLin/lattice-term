import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("reports an explicit skip instead of passing database acceptance when Docker is unavailable", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./test-databases.mjs", import.meta.url))], {
    env: { ...process.env, PATH: join(tmpdir(), `unavailable-${randomUUID()}`) },
    encoding: "utf8", timeout: 20000,
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("SKIP: Docker is unavailable");
  expect(result.stdout).toContain("did not run");
  expect(result.stdout).not.toContain("Testing");
  expect(result.stderr).toBe("");
});
