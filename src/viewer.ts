#!/usr/bin/env node
/**
 * Run Viewer (autopilot capture UI)
 *
 * Business intent:
 * - Provide a zero-deps, no-build-step viewer for autopilot run captures under runs/autopilot/.
 * - Serve a tiny static HTML UI plus read-only JSON/file streaming APIs to inspect runs locally.
 *
 * Gotchas:
 * - This serves local files from the run folder; keep it bound to localhost when possible.
 * - Transcript lookup is best-effort and depends on Codex home/session layout.
 */
import { createReadStream, readFileSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import { isMainModule, printVersion } from "./cli.ts";
import {
  findTranscriptPath,
  codexHome as defaultCodexHome,
} from "./transcripts.ts";

import type { RunManifest } from "./autopilot/artifacts.ts";

type Args = {
  port: number;
  host: string;
  codexHome: string;
  runsDir: string;
};

const DEFAULT_PORT = 4141;
const DEFAULT_HOST = "127.0.0.1";

const UI_INDEX_HTML = readFileSync(
  fileURLToPath(new URL("./viewer-ui/index.html", import.meta.url)),
  "utf8",
);
const UI_ASSETS = new Map<string, { contentType: string; body: Buffer }>([
  [
    "/assets/commands.js",
    {
      contentType: "text/javascript; charset=utf-8",
      body: readFileSync(
        fileURLToPath(new URL("./viewer-ui/commands.js", import.meta.url)),
      ),
    },
  ],
  [
    "/assets/app.js",
    {
      contentType: "text/javascript; charset=utf-8",
      body: readFileSync(
        fileURLToPath(new URL("./viewer-ui/app.js", import.meta.url)),
      ),
    },
  ],
  [
    "/assets/styles.css",
    {
      contentType: "text/css; charset=utf-8",
      body: readFileSync(
        fileURLToPath(new URL("./viewer-ui/styles.css", import.meta.url)),
      ),
    },
  ],
  [
    "/assets/favicon.svg",
    {
      contentType: "image/svg+xml; charset=utf-8",
      body: readFileSync(
        fileURLToPath(new URL("./viewer-ui/favicon.svg", import.meta.url)),
      ),
    },
  ],
]);

if (
  isMainModule(import.meta.url) &&
  process.argv.length === 3 &&
  process.argv[2] === "--version"
) {
  printVersion();
} else if (isMainModule(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    printHelp();
    process.exit(
      process.argv.includes("--help") || process.argv.includes("-h") ? 0 : 1,
    );
  }
  const baseDir = args.runsDir;
  const server = createRunViewerServer({
    codexHome: args.codexHome,
    baseDir,
    host: args.host,
  });
  // GOTCHA: bind failures arrive as events, outside the synchronous startup path.
  server.once("error", (error) => {
    console.error(`[viewer] ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(args.port, args.host, () => {
    const address = `http://${args.host}:${args.port}`;
    console.log(`Run viewer listening on ${address}`);
    console.log(`Runs dir: ${baseDir}`);
    console.log(`Codex home: ${args.codexHome}`);
  });
}

export async function routeRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  codexHome: string,
  baseDir: string,
): Promise<void> {
  applySecurityHeaders(res);
  if (!req.url) {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }
  if (req.method && req.method !== "GET") {
    res.writeHead(405, { allow: "GET" });
    res.end("Method not allowed");
    return;
  }
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;
  const segments = pathname.split("/").filter(Boolean);

  if (pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  const asset = UI_ASSETS.get(pathname);
  if (asset) {
    res.writeHead(200, { "content-type": asset.contentType });
    res.end(asset.body);
    return;
  }

  if (pathname === "/" || pathname === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderHtml());
    return;
  }

  if (
    segments.length === 2 &&
    segments[0] === "api" &&
    segments[1] === "runs"
  ) {
    await handleRunsList(res, baseDir);
    return;
  }

  if (
    segments.length === 4 &&
    segments[0] === "api" &&
    segments[1] === "runs" &&
    segments[3] === "manifest"
  ) {
    const runId = segments[2];
    if (!isSafeRunId(runId)) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "invalid_run_id" }));
      return;
    }
    await handleManifest(res, baseDir, runId);
    return;
  }

  if (
    segments.length === 4 &&
    segments[0] === "api" &&
    segments[1] === "runs" &&
    segments[3] === "file"
  ) {
    const runId = segments[2];
    if (!isSafeRunId(runId)) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "invalid_run_id" }));
      return;
    }
    const relPath = url.searchParams.get("path");
    if (!relPath) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "missing_path" }));
      return;
    }
    await handleRunFile(res, baseDir, runId, relPath);
    return;
  }

  if (
    segments.length === 3 &&
    segments[0] === "api" &&
    segments[1] === "transcript"
  ) {
    const threadId = segments[2];
    const metaOnly = url.searchParams.get("meta") === "1";
    await handleTranscript(res, threadId, codexHome, metaOnly);
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

export function isSafeRunId(runId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId);
}

export function parseArgs(argv: string[]): Args | null {
  let port = DEFAULT_PORT;
  let host = DEFAULT_HOST;
  let codexHome = defaultCodexHome();
  let runsDir = path.resolve("runs/autopilot");

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      return null;
    }
    if (arg === "--port") {
      const next = argv[i + 1];
      if (!next) return null;
      port = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--host") {
      const next = argv[i + 1];
      if (!next) return null;
      host = next;
      i += 1;
      continue;
    }
    if (arg === "--runs-dir") {
      const next = argv[++i];
      if (!next) return null;
      runsDir = path.resolve(next);
      continue;
    }
    if (arg === "--codex-home") {
      const next = argv[i + 1];
      if (!next) return null;
      codexHome = next;
      i += 1;
      continue;
    }
    return null;
  }

  if (!Number.isInteger(port) || port <= 0 || port > 65535 || !host.trim())
    return null;
  return { port, host, codexHome, runsDir };
}

export function printHelp(): void {
  console.log(
    `Usage: codex-autopilot-viewer [--port <port>] [--host <host>] [--runs-dir <path>] [--codex-home <path>]\n       codex-autopilot-viewer --help | --version`,
  );
}

export function renderHtml(): string {
  return UI_INDEX_HTML;
}

export async function handleRunsList(
  res: http.ServerResponse,
  baseDir: string,
): Promise<void> {
  const runsDir = baseDir;
  let entries: Array<{
    runId: string;
    startedAt: string;
    finishedAt?: string;
  }> = [];
  let dirents: Array<import("node:fs").Dirent> = [];
  try {
    dirents = await readdir(runsDir, { withFileTypes: true });
  } catch {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify([]));
    return;
  }
  await Promise.all(
    dirents.map(async (entry) => {
      if (!entry.isDirectory()) return;
      const runId = entry.name;
      try {
        const manifestPath = await resolveRunFile(
          runsDir,
          runId,
          "manifest.json",
        );
        const payload = JSON.parse(
          await readFile(manifestPath, "utf8"),
        ) as RunManifest;
        entries.push({
          runId,
          startedAt: payload.startedAt,
          finishedAt: payload.finishedAt,
        });
      } catch {
        return;
      }
    }),
  );
  entries = entries.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(entries));
}

export async function handleManifest(
  res: http.ServerResponse,
  baseDir: string,
  runId: string,
): Promise<void> {
  try {
    const manifestPath = await resolveRunFile(baseDir, runId, "manifest.json");
    const payload = await readFile(manifestPath, "utf8");
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(payload);
  } catch {
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "manifest_not_found" }));
  }
}

export async function handleRunFile(
  res: http.ServerResponse,
  baseDir: string,
  runId: string,
  relPath: string,
): Promise<void> {
  let realFilePath: string;
  try {
    realFilePath = await resolveRunFile(baseDir, runId, relPath);
  } catch (error) {
    const invalid = error instanceof InvalidPathError;
    res.writeHead(invalid ? 400 : 404, {
      "content-type": "application/json; charset=utf-8",
    });
    res.end(
      JSON.stringify({ error: invalid ? "invalid_path" : "file_not_found" }),
    );
    return;
  }
  try {
    const stats = await stat(realFilePath);
    if (!stats.isFile()) {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "file_not_found" }));
      return;
    }
    const stream = createReadStream(realFilePath, { encoding: "utf8" });
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.once("close", () => stream.destroy());
    stream.pipe(res);
    stream.on("error", () => {
      res.end();
    });
  } catch {
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "file_not_found" }));
  }
}

export async function handleTranscript(
  res: http.ServerResponse,
  threadId: string,
  codexHome: string,
  metaOnly: boolean,
): Promise<void> {
  const transcriptPath = await findTranscriptPath(threadId, codexHome);
  if (!transcriptPath) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end(`Transcript not found for thread ${threadId}.`);
    return;
  }
  if (metaOnly) {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ path: transcriptPath }));
    return;
  }
  try {
    const stats = await stat(transcriptPath);
    if (!stats.isFile()) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end(`Transcript not found for thread ${threadId}.`);
      return;
    }
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end(`Transcript not found for thread ${threadId}.`);
    return;
  }
  res.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
    "x-transcript-path": transcriptPath,
  });
  const stream = createReadStream(transcriptPath, { encoding: "utf8" });
  res.once("close", () => stream.destroy());
  stream.pipe(res);
  stream.on("error", () => res.end());
}

export function createRunViewerServer(options: {
  codexHome: string;
  baseDir: string;
  host?: string;
}): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const hostname = new URL(`http://${req.headers.host || ""}`).hostname;
      const allowedHosts = new Set([
        "localhost",
        "127.0.0.1",
        "[::1]",
        options.host,
      ]);
      if (
        !allowedHosts.has(hostname) ||
        req.headers["sec-fetch-site"] === "cross-site"
      ) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      await routeRequest(req, res, options.codexHome, options.baseDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "internal_error", message }));
    }
  });
}

function applySecurityHeaders(res: http.ServerResponse): void {
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("cross-origin-resource-policy", "same-origin");
  res.setHeader("cross-origin-opener-policy", "same-origin");
  res.setHeader(
    "content-security-policy",
    [
      "default-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
    ].join("; "),
  );
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  if (!relative || relative === "") return false;
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

class InvalidPathError extends Error {}

async function resolveRunFile(
  runsDir: string,
  runId: string,
  relative: string,
): Promise<string> {
  if (
    !isSafeRunId(runId) ||
    path.isAbsolute(relative) ||
    relative.includes("\0")
  )
    throw new InvalidPathError();
  const root = await realpath(runsDir);
  const run = await realpath(path.join(root, runId));
  // GOTCHA: checking only the file beneath a realpath(run) trusts an escaped run symlink.
  if (!isWithin(root, run)) throw new InvalidPathError();
  const candidate = path.resolve(run, relative);
  if (!isWithin(run, candidate)) throw new InvalidPathError();
  const file = await realpath(candidate);
  if (!isWithin(run, file)) throw new InvalidPathError();
  return file;
}
