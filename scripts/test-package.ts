/** Exercise the published tarball from an unrelated repository, without dev dependencies. */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { RunManifest } from "../src/autopilot/artifacts.ts";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "Run this check with npm run test:package.");
const temp = await mkdtemp(path.join(os.tmpdir(), "autopilot-install-"));
let viewer: ReturnType<typeof spawn> | undefined;
try {
  const env = {
    ...process.env,
    npm_config_cache: path.join(temp, "npm-cache"),
  };
  const npm = async (args: string[], cwd = root) =>
    exec(process.execPath, [npmCli, ...args], { cwd, env, timeout: 120_000 });
  const packed = await npm(["pack", "--json", "--pack-destination", temp]);
  const [tarball] = JSON.parse(packed.stdout) as Array<{
    filename: string;
    files: Array<{ path: string }>;
  }>;
  const shipped = tarball.files.map((file) => file.path);
  for (const file of shipped) {
    assert.ok(
      /^(?:package\.json|README\.md|LICENSE|dist\/.+\.(?:js|html|css|svg)|\.agents\/skills\/(?:workflow-generator|reviewer)\/SKILL\.md)$/.test(
        file,
      ),
      `Unexpected published file: ${file}`,
    );
  }
  for (const file of [
    "dist/autopilot.js",
    "dist/viewer.js",
    "dist/viewer-ui/index.html",
    ".agents/skills/workflow-generator/SKILL.md",
    ".agents/skills/reviewer/SKILL.md",
  ])
    assert.ok(shipped.includes(file), `Missing published file: ${file}`);

  const install = path.join(temp, "installation");
  const target = path.join(temp, "unrelated repository");
  const codexHome = path.join(temp, "codex home");
  await Promise.all([install, target, codexHome].map((dir) => mkdir(dir)));
  await writeFile(path.join(install, "package.json"), '{"private":true}');
  await npm([
    "install",
    "--prefix",
    install,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--offline",
    path.join(temp, tarball.filename),
  ]);
  await exec("git", ["init", "--quiet", target]);
  const fakeCodex = path.join(temp, "fake codex.mjs");
  await copyFile(path.join(root, "tests/fixtures/fake-codex.mjs"), fakeCodex);
  const runtimeEnv = {
    ...env,
    CODEX_BIN: fakeCodex,
    CODEX_HOME: codexHome,
    FAKE_CODEX_MODE: "",
  };
  const binary = (name: string) =>
    process.platform === "win32"
      ? path.join(
          install,
          "node_modules/codex-autopilot/dist",
          name === "codex-autopilot" ? "autopilot.js" : "viewer.js",
        )
      : path.join(install, "node_modules/.bin", name);
  const cli = (name: string, args: string[]) =>
    exec(process.execPath, [binary(name), ...args], {
      cwd: target,
      env: runtimeEnv,
      timeout: 30_000,
    });
  const metadata = JSON.parse(
    await readFile(
      path.join(install, "node_modules/codex-autopilot/package.json"),
      "utf8",
    ),
  ) as { version: string; dependencies?: object };
  assert.equal(Object.keys(metadata.dependencies ?? {}).length, 0);
  for (const name of ["codex-autopilot", "codex-autopilot-viewer"]) {
    assert.equal(
      (await cli(name, ["--version"])).stdout.trim(),
      metadata.version,
    );
    assert.ok((await cli(name, ["--help"])).stdout.includes(`Usage: ${name}`));
  }
  const task = "Inspect this unrelated repository; preserve $(literal) text";
  await cli("codex-autopilot", ["--max-iterations", "1", task]);
  const runs = path.join(target, "runs/autopilot");
  const [runId] = await readdir(runs);
  const runDir = path.join(runs, runId);
  const manifest = JSON.parse(
    await readFile(path.join(runDir, "manifest.json"), "utf8"),
  ) as RunManifest;
  assert.equal(manifest.status, "succeeded");
  // GOTCHA: Windows short and long native paths can name the same directory.
  assert.equal(await realpath(manifest.cwd), await realpath(target));
  assert.equal(manifest.execs.length, 4);
  const prompts = await Promise.all(
    manifest.execs.map((entry) =>
      readFile(path.join(runDir, entry.artifacts.promptTxt), "utf8"),
    ),
  );
  assert.ok(prompts[0].includes(task));
  assert.match(prompts[0], /# Workflow Generator/);
  assert.match(prompts.at(-1)!, /# Reviewer/);
  await assert.rejects(access(path.join(target, ".agents")), {
    code: "ENOENT",
  });

  const portProbe = net.createServer();
  portProbe.listen(0, "127.0.0.1");
  await once(portProbe, "listening");
  const port = (portProbe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    portProbe.close((error) => (error ? reject(error) : resolve())),
  );
  viewer = spawn(
    process.execPath,
    [binary("codex-autopilot-viewer"), "--port", String(port)],
    { cwd: target, env: runtimeEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error(`Viewer did not start: ${output}`)),
      10_000,
    );
    viewer!.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    viewer!.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Viewer exited with ${code}: ${output}`));
    });
    viewer!.stdout!.on("data", (chunk) => {
      output += chunk;
      if (output.includes("Run viewer listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    viewer!.stderr!.on("data", (chunk) => {
      output += chunk;
    });
  });
  const base = `http://127.0.0.1:${port}`;
  for (const route of [
    "/",
    "/assets/app.js",
    "/assets/commands.js",
    "/assets/styles.css",
    "/assets/favicon.svg",
  ]) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200, route);
    assert.ok((await response.text()).length > 0, route);
  }
  const listing = (await (await fetch(base + "/api/runs")).json()) as Array<{
    runId: string;
  }>;
  assert.deepEqual(
    listing.map((run) => run.runId),
    [runId],
  );
  const served = (await (
    await fetch(`${base}/api/runs/${runId}/manifest`)
  ).json()) as RunManifest;
  assert.equal(served.status, "succeeded");
  console.log(
    `Packed ${shipped.length} allowlisted files; installed runner and viewer passed in an unrelated git repository.`,
  );
} finally {
  if (viewer && viewer.exitCode === null && viewer.signalCode === null) {
    const closed = once(viewer, "close");
    viewer.kill();
    await closed;
  }
  await rm(temp, { recursive: true, force: true });
}
