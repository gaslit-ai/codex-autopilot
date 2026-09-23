/** Codex CLI adapter. Prompts travel over stdin; raw JSONL and stderr stay on disk. */
import { spawn } from "node:child_process";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReasoningEffort, Sandbox } from "./options.ts";
import type { CaptureContext, ExecManifestEntry } from "./artifacts.ts";
import {
  allocateExecIndex,
  recordExecGraphNode,
  enrichGraphFromTranscript,
  writeManifest,
} from "./artifacts.ts";
import { isPlainObject } from "./shared.ts";
import { resolveCodexCommand } from "./codex-command.ts";

export type CodexRunResult = {
  execId: string;
  threadId: string;
  outputText: string;
  usage?: unknown;
};
export class CodexExecError extends Error {
  execId: string;
  threadId: string;
  exitCode: number;
  constructor(
    message: string,
    params: { execId: string; threadId: string; exitCode: number },
  ) {
    super(message);
    this.name = "CodexExecError";
    this.execId = params.execId;
    this.threadId = params.threadId;
    this.exitCode = params.exitCode;
  }
}

type ExecParams = {
  label: string;
  prompt: string;
  model?: string;
  effort?: ReasoningEffort;
  unsafe: boolean;
  sandbox?: Sandbox;
  search: boolean;
  outputSchemaJson?: string;
  captureContext: CaptureContext;
};

export function buildCodexArgs(
  params: Omit<ExecParams, "captureContext">,
  lastMessagePath: string,
  schemaPath?: string,
): string[] {
  const args = ["exec", "--json", "--output-last-message", lastMessagePath];
  if (schemaPath) args.push("--output-schema", schemaPath);
  if (params.model) args.push("-m", params.model);
  if (params.effort)
    args.push("-c", `model_reasoning_effort=${JSON.stringify(params.effort)}`);
  // GOTCHA: omitting --search inherits cached/live search from user config; off
  // must explicitly disable it, including during planning and completion checks.
  args.push(
    "-c",
    `web_search=${JSON.stringify(params.search ? "live" : "disabled")}`,
  );
  if (params.unsafe) args.push("--dangerously-bypass-approvals-and-sandbox");
  else
    args.push(
      "--sandbox",
      params.sandbox ?? "read-only",
      "-c",
      'approval_policy="never"',
    );
  args.push("-");
  return args;
}

export async function codexExec(params: ExecParams): Promise<CodexRunResult> {
  const capture = params.captureContext;
  capture.signal?.throwIfAborted();
  const execId = `exec-${String(allocateExecIndex(capture)).padStart(3, "0")}`;
  const label =
    params.label
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, "-")
      .replace(/^-|-$/g, "") || "exec";
  const execDir = path.join(capture.runDir, `${execId}-${label}`);
  await mkdir(execDir, { recursive: true });
  const files = {
    eventsJsonl: path.join(execDir, "events.jsonl"),
    stderrTxt: path.join(execDir, "stderr.txt"),
    lastMessageTxt: path.join(execDir, "last_message.txt"),
    promptTxt: path.join(execDir, "prompt.txt"),
    argvJson: path.join(execDir, "argv.json"),
    schemaJson: params.outputSchemaJson
      ? path.join(execDir, "schema.json")
      : undefined,
  };
  const args = buildCodexArgs(params, files.lastMessageTxt, files.schemaJson);
  const binary = process.env.CODEX_BIN || "codex";
  const command = await resolveCodexCommand(binary, args);
  await writeFile(files.promptTxt, params.prompt);
  await writeFile(
    files.argvJson,
    JSON.stringify([command.command, ...command.args], null, 2),
  );
  if (files.schemaJson)
    await writeFile(files.schemaJson, params.outputSchemaJson!);

  const startedAt = new Date().toISOString();
  const eventsFile = await open(files.eventsJsonl, "w");
  const stderrFile = await open(files.stderrTxt, "w");
  let threadId = "";
  let outputText = "";
  let usage: unknown;
  let fatalError = "";
  let lastError = "";
  let stderrTail = "";
  let completed = false;
  const child = spawn(command.command, command.args, {
    stdio: ["pipe", "pipe", "pipe"],
    // GOTCHA: killing only the CLI leaves its commands alive and can keep these
    // capture pipes open forever. A POSIX process group owns the whole tree.
    detached: process.platform !== "win32",
  });
  const closed = new Promise<number>((resolve) => {
    child.on("error", (error: NodeJS.ErrnoException) => {
      fatalError =
        error.code === "ENOENT"
          ? `Codex executable not found: ${binary}. Install it with npm install -g @openai/codex and run codex login, or set CODEX_BIN to your Codex executable.`
          : error.message;
    });
    // GOTCHA: exit can precede stderr/stdout draining. close is the completion boundary.
    child.on("close", (code) => resolve(code ?? 1));
  });
  function killChild(signal: NodeJS.Signals): void {
    try {
      child.kill(signal);
    } catch (error) {
      fatalError ||= String(error);
    }
  }
  function killProcesses(signal: NodeJS.Signals): void {
    if (!child.pid) return;
    if (process.platform === "win32") {
      // Windows has no POSIX process groups or graceful SIGTERM. taskkill is
      // the native tree-termination fallback; retain child cleanup if it fails.
      const cleanup = spawn(
        "taskkill",
        ["/PID", String(child.pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true },
      );
      cleanup.once("error", () => killChild("SIGKILL"));
      cleanup.once("close", (code) => {
        if (code !== 0) killChild("SIGKILL");
      });
      return;
    }
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        fatalError ||= String(error);
        killChild(signal);
      }
    }
  }
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  function abort(): void {
    killProcesses("SIGTERM");
    killTimer = setTimeout(() => killProcesses("SIGKILL"), 3000);
    killTimer.unref();
  }
  capture.signal?.addEventListener("abort", abort, { once: true });
  // Capture files are prepared asynchronously before spawn, so cancellation can
  // arrive between the initial throwIfAborted check and listener registration.
  if (capture.signal?.aborted) abort();
  child.stdin.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") fatalError = error.message;
  });
  child.stdin.end(params.prompt);

  function parseLine(line: string): void {
    if (!line.trim()) return;
    let evt: unknown;
    try {
      evt = JSON.parse(line);
    } catch {
      fatalError ||= "Codex emitted malformed JSONL.";
      return;
    }
    if (!isPlainObject(evt) || typeof evt.type !== "string") {
      fatalError ||= "Codex emitted an invalid JSON event.";
      return;
    }
    if (evt.type === "thread.started" && typeof evt.thread_id === "string")
      threadId = evt.thread_id;
    if (
      evt.type === "item.completed" &&
      isPlainObject(evt.item) &&
      evt.item.type === "agent_message" &&
      typeof evt.item.text === "string"
    )
      outputText = evt.item.text;
    if (evt.type === "turn.completed") {
      completed = true;
      usage = evt.usage;
    }
    if (evt.type === "turn.failed")
      fatalError = errorMessage(evt.error, "Codex turn failed.");
    // Error events can describe retryable connection problems before a successful turn.
    if (evt.type === "error")
      lastError = errorMessage(evt.message, "Codex error.");
  }

  async function readEvents(): Promise<void> {
    let pending = "";
    child.stdout.setEncoding("utf8");
    for await (const chunk of child.stdout) {
      await eventsFile.write(chunk);
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        parseLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
    }
    if (pending.trim()) parseLine(pending);
  }
  async function readStderr(): Promise<void> {
    for await (const chunk of child.stderr) {
      await stderrFile.write(chunk);
      stderrTail = (stderrTail + chunk.toString()).slice(-16000);
    }
  }
  let exitCode = 1;
  try {
    const streams = await Promise.allSettled(
      [readEvents(), readStderr()].map(async (stream) => {
        try {
          await stream;
        } catch (error) {
          // Stop the producer immediately if capture I/O fails; do not wait on its other pipe.
          killProcesses("SIGKILL");
          throw error;
        }
      }),
    );
    for (const result of streams) {
      if (result.status === "rejected") {
        fatalError ||= String(result.reason);
      }
    }
    exitCode = await closed;
  } finally {
    capture.signal?.removeEventListener("abort", abort);
    if (killTimer) clearTimeout(killTimer);
    // A descendant may close its capture pipes before exiting. Do not leave it
    // alive when the CLI closes early and cancels the escalation timer.
    if (capture.signal?.aborted && process.platform !== "win32")
      killProcesses("SIGKILL");
    await Promise.all([eventsFile.close(), stderrFile.close()]);
  }
  if (capture.signal?.aborted) fatalError ||= "Codex execution cancelled.";
  if (exitCode !== 0)
    fatalError ||=
      stderrTail.trim() || lastError || `Codex exited with code ${exitCode}.`;
  if (!threadId) fatalError ||= "Codex did not emit thread.started.";
  if (!completed)
    fatalError ||= lastError || "Codex did not emit turn.completed.";
  try {
    outputText = await readFile(files.lastMessageTxt, "utf8");
  } catch {
    // GOTCHA: some CLI failures omit this file; preserve the streamed final message.
    await writeFile(files.lastMessageTxt, outputText);
  }
  const artifacts = Object.fromEntries(
    Object.entries(files).map(([key, value]) => [
      key,
      value ? path.relative(capture.runDir, value) : undefined,
    ]),
  );
  const entry: ExecManifestEntry = {
    execId,
    label: params.label,
    threadId: threadId || "unknown",
    exitCode,
    status: fatalError ? "failed" : "succeeded",
    startedAt,
    finishedAt: new Date().toISOString(),
    artifacts: artifacts as ExecManifestEntry["artifacts"],
  };
  capture.runManifest.execs.push(entry);
  recordExecGraphNode(entry, capture);
  if (threadId && !capture.signal?.aborted)
    await enrichGraphFromTranscript(threadId, capture);
  await writeManifest(capture);
  if (fatalError)
    throw new CodexExecError(fatalError, {
      execId,
      threadId: threadId || "unknown",
      exitCode,
    });
  return { execId, threadId, outputText, usage };
}

function errorMessage(value: unknown, fallback: string): string {
  if (typeof value === "string") return value;
  if (isPlainObject(value) && typeof value.message === "string")
    return value.message;
  return fallback;
}
