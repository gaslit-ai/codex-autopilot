import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const metadata = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
) as { version: string };

test("both CLIs work through npm-style symlinks outside the source repository", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "autopilot-cli-"));
  try {
    for (const [source, name] of [
      ["autopilot.ts", "codex-autopilot"],
      ["viewer.ts", "codex-autopilot-viewer"],
    ]) {
      const link = path.join(dir, name + ".ts");
      await symlink(path.join(root, "src", source), link);
      const version = await exec(process.execPath, [link, "--version"], {
        cwd: dir,
      });
      assert.equal(version.stdout.trim(), metadata.version);
      const help = await exec(process.execPath, [link, "--help"], {
        cwd: dir,
      });
      assert.ok(help.stdout.includes(`Usage: ${name}`));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
