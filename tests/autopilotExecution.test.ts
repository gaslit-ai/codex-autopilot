import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { RunManifest } from "../src/autopilot/artifacts.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const binary = path.join(root, "tests/fixtures/fake-codex.mjs");

async function runFake(mode = "", bin = binary, extraArgs: string[] = []) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "autopilot-test-"));
  await chmod(binary, 0o755);
  try {
    const child = spawn(
      process.execPath,
      [
        "src/autopilot.ts",
        "--out-dir",
        dir,
        "--max-iterations",
        "1",
        "--effort",
        "low",
        ...extraArgs,
        "Inspect repository; preserve $(literal) text",
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          CODEX_BIN: bin,
          CODEX_HOME: dir,
          FAKE_CODEX_MODE: mode,
        },
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.resume();
    const closed = new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    if (mode === "hold") {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          await readFile(path.join(dir, "ready"));
          ready = true;
          break;
        } catch {
          await delay(20);
        }
      }
      if (!ready) {
        child.kill("SIGKILL");
        throw new Error("Fixture did not start");
      }
      child.kill("SIGTERM");
    }
    const code = await closed;
    const runId = (await readdir(dir, { withFileTypes: true })).find((e) =>
      e.isDirectory(),
    )!.name;
    const runDir = path.join(dir, runId);
    const manifest = JSON.parse(
      await readFile(path.join(runDir, "manifest.json"), "utf8"),
    ) as RunManifest;
    const artifacts = await Promise.all(
      manifest.execs.map(
        async (entry: {
          artifacts: { argvJson: string; promptTxt: string };
        }) => ({
          argv: JSON.parse(
            await readFile(path.join(runDir, entry.artifacts.argvJson), "utf8"),
          ) as string[],
          prompt: await readFile(
            path.join(runDir, entry.artifacts.promptTxt),
            "utf8",
          ),
        }),
      ),
    );
    const timeline =
      mode === "parallel"
        ? (await readFile(path.join(dir, "timeline.jsonl"), "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { phase: string })
        : [];
    const workerPid =
      mode === "hold"
        ? Number(await readFile(path.join(dir, "ready"), "utf8"))
        : undefined;
    return { code, stderr, manifest, artifacts, timeline, workerPid };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("runner completes with stdin prompts, inherited model, explicit sandbox/search and durable graph", async () => {
  const { code, stderr, manifest, artifacts } = await runFake();
  assert.equal(code, 0, stderr);
  assert.equal(manifest.status, "succeeded");
  assert.ok(manifest.finishedAt);
  assert.equal(manifest.execs.length, 4);
  assert.ok(
    manifest.graph.edges.some(
      (edge: { type: string }) => edge.type === "dependsOn",
    ),
  );
  for (const { argv } of artifacts) {
    assert.equal(argv.at(-1), "-");
    assert.ok(argv.includes('web_search="disabled"'));
    assert.ok(argv.includes("read-only"));
    assert.ok(argv.includes('model_reasoning_effort="low"'));
    assert.ok(!argv.includes("-m"));
    assert.ok(!argv.some((arg: string) => arg.includes("$(literal)")));
  }
  assert.match(artifacts[2].prompt, /Work complete/);
  assert.match(artifacts[0].prompt, /# Workflow Generator/);
  assert.match(artifacts[3].prompt, /# Reviewer/);
});

test("recoverable error events do not override a completed turn", async () => {
  assert.equal((await runFake("transient-error")).code, 0);
});

test("collaboration status updates share a call identity without graph warnings", async () => {
  const { code, stderr, manifest } = await runFake("collab-events");
  assert.equal(code, 0, stderr);
  assert.deepEqual(manifest.graph.warnings, []);
  const interactions = manifest.graph.edges.filter(
    (edge) => edge.type === "interact",
  );
  assert.equal(interactions.length, 8);
  assert.deepEqual(
    new Set(interactions.map((edge) => edge.status)),
    new Set(["begin", "completed"]),
  );
});

test("incomplete review exits distinctly and finalizes captures", async () => {
  const result = await runFake("incomplete");
  assert.equal(result.code, 2);
  assert.equal(result.manifest.status, "incomplete");
  assert.ok(result.manifest.finishedAt);
});

for (const mode of [
  "cycle",
  "turn-failed",
  "missing-thread",
  "missing-completion",
  "null-event",
]) {
  test(`runner finalizes failed captures: ${mode}`, async () => {
    const result = await runFake(mode);
    assert.equal(result.code, 1);
    assert.equal(result.manifest.status, "failed");
    assert.ok(result.manifest.finishedAt);
    if (mode === "turn-failed")
      assert.match(result.stderr, /Action failed with useful detail/);
    assert.ok(
      result.manifest.execs.every(
        (exec: { label: string }) => !exec.label.startsWith("step:"),
      ),
    );
  });
}

test("missing executable records failure without an unhandled process error", async () => {
  const result = await runFake("", "/does-not-exist/codex");
  assert.equal(result.code, 1);
  assert.equal(result.manifest.status, "failed");
  assert.match(result.stderr, /Codex executable not found/);
  assert.match(result.stderr, /npm install -g @openai\/codex/);
  assert.match(result.stderr, /CODEX_BIN/);
});

test("failed prerequisite skips dependents and cannot be reported as done", async () => {
  const result = await runFake("step-failed");
  assert.equal(result.code, 2);
  assert.equal(result.manifest.status, "incomplete");
  assert.ok(
    !result.manifest.execs.some(
      (entry: { label: string }) => entry.label === "step:review",
    ),
  );
});

test("workspace-write and search apply only to execution steps", async () => {
  const result = await runFake("", binary, [
    "--sandbox",
    "workspace-write",
    "--search",
  ]);
  assert.equal(result.code, 0, result.stderr);
  for (const [index, artifact] of result.artifacts.entries()) {
    const step = index === 1 || index === 2;
    assert.ok(artifact.argv.includes(step ? "workspace-write" : "read-only"));
    assert.ok(
      artifact.argv.includes(
        step ? 'web_search="live"' : 'web_search="disabled"',
      ),
    );
  }
});

test("invalid review cannot falsely mark completion", async () => {
  assert.equal((await runFake("invalid-review")).code, 2);
});

test("reviewer's next workflow executes without another generator call", async () => {
  const result = await runFake("follow-up", binary, ["--max-iterations", "2"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    result.manifest.execs.filter((entry) =>
      entry.label.startsWith("workflow-gen"),
    ).length,
    1,
  );
  assert.equal(result.manifest.execs.length, 6);
});

test("independent steps respect the concurrency bound", async () => {
  const result = await runFake("parallel", binary, ["--concurrency", "2"]);
  assert.equal(result.code, 0, result.stderr);
  let active = 0;
  let peak = 0;
  for (const event of result.timeline) {
    active += event.phase === "start" ? 1 : -1;
    peak = Math.max(peak, active);
  }
  assert.equal(active, 0);
  assert.equal(peak, 2);
});

test(
  "SIGTERM cancels the active child and finalizes the run",
  { timeout: 10000 },
  async () => {
    const result = await runFake("hold");
    assert.equal(result.code, 143, result.stderr);
    assert.equal(result.manifest.status, "cancelled");
    assert.ok(result.manifest.finishedAt);
    assert.throws(() => process.kill(result.workerPid!, 0), { code: "ESRCH" });
  },
);
