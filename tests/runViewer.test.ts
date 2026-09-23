/**
 * Run viewer API + UI contract tests for the autopilot viewer.
 *
 * Business intent:
 * - Guard file boundaries, transcript lookup, static assets, and HTTP access rules.
 *
 * Gotchas:
 * - HTTP tests bind only to loopback and use a temporary run root.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { test } from "node:test";

import {
  createRunViewerServer,
  parseArgs,
  renderHtml,
  routeRequest,
} from "../src/viewer.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "run-viewer-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

class MockResponse extends Writable {
  statusCode = 200;
  headers: Record<string, string> = {};
  private chunks: Buffer[] = [];

  writeHead(statusCode: number, headers?: Record<string, string>): this {
    this.statusCode = statusCode;
    if (headers) {
      Object.assign(this.headers, headers);
    }
    return this;
  }

  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }

  _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }

  bodyText(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

async function invokeRoute(
  url: string,
  baseDir: string,
  codexHome: string,
): Promise<{
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}> {
  const req = { url, headers: { host: "localhost" } } as http.IncomingMessage;
  const res = new MockResponse() as unknown as http.ServerResponse &
    MockResponse;
  await routeRequest(
    req,
    res,
    codexHome,
    path.join(baseDir, "runs", "autopilot"),
  );
  if (!res.writableEnded) {
    await new Promise<void>((resolve) => res.on("finish", () => resolve()));
  }
  return {
    statusCode: res.statusCode,
    headers: res.headers,
    body: res.bodyText(),
  };
}

test("run viewer rejects traversal and returns 404 for missing artifacts", async () => {
  await withTempDir(async (dir) => {
    const runDir = path.join(dir, "runs", "autopilot", "run-1");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      path.join(runDir, "manifest.json"),
      JSON.stringify({
        runId: "run-1",
        startedAt: new Date().toISOString(),
        execs: [],
      }),
    );
    const traversal = await invokeRoute(
      "/api/runs/run-1/file?path=../secret.txt",
      dir,
      dir,
    );
    assert.equal(traversal.statusCode, 400);
    const secretPath = path.join(dir, "secret.txt");
    await writeFile(secretPath, "secret");
    await symlink(secretPath, path.join(runDir, "leak.txt"));
    const symlinkEscape = await invokeRoute(
      "/api/runs/run-1/file?path=leak.txt",
      dir,
      dir,
    );
    assert.equal(symlinkEscape.statusCode, 400);
    const strict = await invokeRoute(
      "/api/runs/run-1/manifest/extra",
      dir,
      dir,
    );
    assert.equal(strict.statusCode, 404);
    const missing = await invokeRoute(
      "/api/runs/run-1/file?path=missing.txt",
      dir,
      dir,
    );
    assert.equal(missing.statusCode, 404);
  });
});

test("run viewer transcript lookup uses --codex-home override", async () => {
  await withTempDir(async (dir) => {
    const codexHome = path.join(dir, "codex-home");
    const sessionsDir = path.join(codexHome, "sessions", "2026", "02", "03");
    await mkdir(sessionsDir, { recursive: true });
    const threadId = "thread-abc";
    const transcriptPath = path.join(
      sessionsDir,
      `rollout-xyz-${threadId}.jsonl`,
    );
    await writeFile(
      transcriptPath,
      JSON.stringify({ type: "session_meta" }) + "\n",
    );
    const meta = await invokeRoute(
      `/api/transcript/${threadId}?meta=1`,
      dir,
      codexHome,
    );
    assert.equal(meta.statusCode, 200);
    const payload = JSON.parse(meta.body) as { path?: string };
    assert.equal(payload.path, transcriptPath);
    const transcript = await invokeRoute(
      `/api/transcript/${threadId}`,
      dir,
      codexHome,
    );
    assert.equal(transcript.statusCode, 200);
    assert.ok(transcript.body.includes("session_meta"));
  });
});

test("run viewer HTML references external UI assets", () => {
  const html = renderHtml();
  assert.ok(html.includes('rel="stylesheet"'));
  assert.ok(html.includes('src="/assets/app.js"'));
  assert.ok(html.includes('href="/assets/styles.css"'));
});

test("run viewer serves UI assets with expected client logic", async () => {
  await withTempDir(async (dir) => {
    const js = await invokeRoute("/assets/app.js", dir, dir);
    assert.equal(js.statusCode, 200);
    assert.ok(js.body.includes("AbortController"));
    assert.ok(js.body.includes("abortEventsStream"));
    assert.ok(js.body.includes("state.eventsAbortController.abort()"));
  });
});

test("run viewer sets security headers on HTML responses", async () => {
  await withTempDir(async (dir) => {
    const res = await invokeRoute("/", dir, dir);
    assert.equal(res.statusCode, 200);
    assert.ok(
      res.headers["content-security-policy"]?.includes("default-src 'none'"),
    );
    assert.ok(
      res.headers["content-security-policy"]?.includes("script-src 'self'"),
    );
  });
});

test("viewer rejects symlinked run directories and manifests outside the run root", async () => {
  await withTempDir(async (dir) => {
    const runs = path.join(dir, "runs", "autopilot");
    const external = path.join(dir, "external");
    await mkdir(runs, { recursive: true });
    await mkdir(external);
    await writeFile(path.join(external, "manifest.json"), '{"secret":true}');
    await writeFile(path.join(external, "secret.txt"), "secret");
    await symlink(external, path.join(runs, "escape"));
    await mkdir(path.join(runs, "valid"));
    await symlink(
      path.join(external, "manifest.json"),
      path.join(runs, "valid", "manifest.json"),
    );
    for (const url of [
      "/api/runs/escape/manifest",
      "/api/runs/escape/file?path=secret.txt",
      "/api/runs/valid/manifest",
    ]) {
      const response = await invokeRoute(url, dir, dir);
      assert.ok(response.statusCode >= 400, url);
      assert.ok(!response.body.includes("secret"));
    }
    assert.deepEqual(
      JSON.parse((await invokeRoute("/api/runs", dir, dir)).body),
      [],
    );
  });
});

test("transcript lookup matches a complete ID and supports archived sessions", async () => {
  await withTempDir(async (dir) => {
    const sessions = path.join(dir, "sessions");
    const archived = path.join(dir, "archived_sessions");
    await mkdir(sessions);
    await mkdir(archived);
    await writeFile(
      path.join(sessions, "rollout-thread-a.jsonl.backup"),
      "wrong",
    );
    await writeFile(path.join(archived, "rollout-thread-a.jsonl"), "archived");
    const response = await invokeRoute("/api/transcript/thread-a", dir, dir);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, "archived");
  });
});

test("viewer serves a complete UI over HTTP and rejects cross-site, Host and method violations", async () => {
  await withTempDir(async (dir) => {
    const server = createRunViewerServer({ baseDir: dir, codexHome: dir });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address() as { port: number };
      const origin = `http://127.0.0.1:${address.port}`;
      const page = await fetch(origin);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /assets\/app.js/);
      for (const asset of [
        "app.js",
        "commands.js",
        "styles.css",
        "favicon.svg",
      ]) {
        const response = await fetch(`${origin}/assets/${asset}`);
        assert.equal(response.status, 200, asset);
        assert.ok((await response.text()).length > 0);
      }
      assert.equal(
        (await fetch(origin, { headers: { "sec-fetch-site": "cross-site" } }))
          .status,
        403,
      );
      assert.equal((await fetch(origin, { method: "POST" })).status, 405);
      const hostileHost = await new Promise<number | undefined>((resolve) => {
        http.get(
          origin,
          { headers: { host: "attacker.example" } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
      });
      assert.equal(hostileHost, 403);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

test("viewer validates ports and accepts an explicit capture directory", () => {
  for (const port of ["0", "-1", "65536", "12.5", "abc"])
    assert.equal(parseArgs(["--port", port]), null);
  assert.equal(
    parseArgs(["--runs-dir", "/tmp/captures"])?.runsDir,
    "/tmp/captures",
  );
});
