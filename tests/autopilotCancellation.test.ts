import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { CaptureContext } from "../src/autopilot/artifacts.ts";
import { codexExec, CodexExecError } from "../src/autopilot/codex-process.ts";

for (const inheritPipes of [true, false]) {
  test(
    `cancellation terminates descendants that ignore SIGTERM (${inheritPipes ? "inherited" : "closed"} capture pipes)`,
    { skip: process.platform === "win32", timeout: 10000 },
    async () => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "autopilot-cancel-"),
      );
      const binary = path.join(directory, "fake-codex.mjs");
      const readyPath = path.join(directory, "ready.json");
      const heartbeatPath = path.join(directory, "heartbeat");
      const previousBinary = process.env.CODEX_BIN;
      const controller = new AbortController();
      let pids: { parent: number; descendant: number } | undefined;
      let execution: Promise<unknown> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const descendant = `
        const { writeFileSync } = require("node:fs");
        process.on("SIGTERM", () => {});
        let ticks = 0;
        writeFileSync(${JSON.stringify(heartbeatPath)}, String(ticks));
        writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({ parent: process.ppid, descendant: process.pid }));
        setInterval(() => writeFileSync(${JSON.stringify(heartbeatPath)}, String(++ticks)), 20);
      `;
        await writeFile(
          binary,
          `#!/usr/bin/env node
import { spawn } from "node:child_process";
process.stdin.resume();
${inheritPipes ? 'process.on("SIGTERM", () => {});' : ""}
spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: ${inheritPipes ? '["ignore", "inherit", "inherit"]' : '"ignore"'} });
setInterval(() => {}, 1000);
`,
        );
        await chmod(binary, 0o755);
        process.env.CODEX_BIN = binary;
        const capture: CaptureContext = {
          signal: controller.signal,
          runDir: directory,
          runManifestPath: path.join(directory, "manifest.json"),
          nextExecIndex: 1,
          manifestWrite: Promise.resolve(),
          runManifest: {
            runId: "cancellation-test",
            status: "running",
            startedAt: new Date().toISOString(),
            cwd: directory,
            options: {
              concurrency: 1,
              unsafe: false,
              search: false,
              sandbox: "read-only",
            },
            execs: [],
            graph: { nodes: [], edges: [], warnings: [] },
          },
          graphIndex: {
            nodes: new Map(),
            edges: new Map(),
            warnings: new Set(),
            transcriptThreads: new Set(),
            transcriptCallIds: new Map(),
          },
        };
        execution = codexExec({
          label: "cancellation-test",
          prompt: "Inspect the repository",
          unsafe: false,
          search: false,
          captureContext: capture,
        }).catch((error: unknown) => error);
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            pids = JSON.parse(await readFile(readyPath, "utf8"));
            break;
          } catch {
            await delay(20);
          }
        }
        assert.ok(pids, "The subprocess must start before cancellation");
        controller.abort();
        const result = await Promise.race([
          execution,
          new Promise<"timeout">((resolve) => {
            deadline = setTimeout(() => resolve("timeout"), 4500);
          }),
        ]);
        assert.notEqual(
          result,
          "timeout",
          "Descendants must not keep cancellation waiting on capture pipes",
        );
        assert.ok(result instanceof CodexExecError);
        assert.equal(capture.runManifest.execs[0].status, "failed");
        const finalHeartbeat = await readFile(heartbeatPath, "utf8");
        await delay(100);
        assert.equal(
          await readFile(heartbeatPath, "utf8"),
          finalHeartbeat,
          "Descendants must stop changing files before cancellation finishes",
        );
      } finally {
        if (deadline) clearTimeout(deadline);
        controller.abort();
        for (const pid of Object.values(pids ?? {})) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* Already terminated. */
          }
        }
        await execution;
        if (previousBinary === undefined) delete process.env.CODEX_BIN;
        else process.env.CODEX_BIN = previousBinary;
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
