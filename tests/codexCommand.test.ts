import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { resolveCodexCommand } from "../src/autopilot/codex-command.ts";

const run = promisify(execFile);

async function temporaryDirectory<T>(
  run: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-command-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function npmShim(
  directory: string,
  local = false,
): Promise<{ shim: string; entry: string }> {
  const modules = path.join(directory, "node_modules");
  const bin = local ? path.join(modules, ".bin") : directory;
  const pkg = path.join(modules, "@openai", "codex");
  await mkdir(path.join(pkg, "bin"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(
    path.join(pkg, "package.json"),
    JSON.stringify({ name: "@openai/codex", bin: { codex: "bin/codex.js" } }),
  );
  const entry = path.join(pkg, "bin", "codex.js");
  await writeFile(entry, "console.log(JSON.stringify(process.argv.slice(2)));");
  const relative = path.relative(bin, entry).split(path.sep).join("\\");
  const shim = path.join(bin, "codex.cmd");
  await writeFile(
    shim,
    `@ECHO off\r\nSET dp0=%~dp0\r\nSET \"_prog=node\"\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\${relative}\" %*\r\n`,
  );
  return { shim, entry };
}

test("JavaScript CODEX_BIN runs through Node with literal argument boundaries", async () => {
  await temporaryDirectory(async (directory) => {
    const entry = path.join(directory, "fake codex.mjs");
    await writeFile(
      entry,
      "console.log(JSON.stringify(process.argv.slice(2)));",
    );
    const args = ["exec", "--model", 'literal & echo "no"', "$(literal)"];
    const result = await resolveCodexCommand(entry, args);
    assert.equal(result.command, process.execPath);
    assert.deepEqual(result.args, [entry, ...args]);
    assert.deepEqual(
      JSON.parse((await run(result.command, result.args)).stdout),
      args,
    );
  });
});

for (const local of [false, true]) {
  test(`Windows resolves the standard ${local ? "local" : "global"} npm Codex shim without a shell`, async () => {
    await temporaryDirectory(async (directory) => {
      const { shim, entry } = await npmShim(directory, local);
      const args = ["exec", "-"];
      const result = await resolveCodexCommand("codex", args, {
        platform: "win32",
        cwd: directory,
        env: { Path: path.dirname(shim) },
      });
      assert.deepEqual(result, {
        command: process.execPath,
        args: [entry, ...args],
      });
      assert.deepEqual(
        JSON.parse((await run(result.command, result.args)).stdout),
        args,
      );
      assert.deepEqual(
        await resolveCodexCommand(shim, args, { platform: "win32" }),
        result,
      );
    });
  });
}

test("Windows native Codex executables remain directly executable", async () => {
  await temporaryDirectory(async (directory) => {
    await npmShim(directory);
    const executable = path.join(directory, "codex.exe");
    await writeFile(executable, "native executable fixture");
    assert.deepEqual(
      await resolveCodexCommand("codex", ["exec"], {
        platform: "win32",
        cwd: directory,
        env: { PATH: directory },
      }),
      { command: executable, args: ["exec"] },
    );
  });
});

test("Windows refuses arbitrary batch wrappers instead of evaluating shell code", async () => {
  await temporaryDirectory(async (directory) => {
    const { shim } = await npmShim(directory);
    await writeFile(shim, "@echo off\r\necho arbitrary wrapper\r\n");
    await assert.rejects(
      resolveCodexCommand(shim, ["exec"], { platform: "win32" }),
      /CODEX_BIN.*JavaScript.*native/i,
    );
  });
});

test("a missing ordinary executable remains a spawn error for durable failure capture", async () => {
  assert.deepEqual(
    await resolveCodexCommand("missing-codex", ["exec"], {
      platform: "win32",
      env: { PATH: "" },
    }),
    { command: "missing-codex", args: ["exec"] },
  );
});
