#!/usr/bin/env node
/** Plan, execute, and review bounded workflows in a shared repository checkout. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { isMainModule, printVersion } from "./cli.ts";
import { bundledSkill } from "./autopilot/skills.ts";
import {
  WORKFLOW_OUTPUT_SCHEMA_JSON,
  COMPLETION_OUTPUT_SCHEMA_JSON,
  buildWorkflowGeneratorPrompt,
} from "./autopilot/prompts.ts";
import { parseArgs, printHelp } from "./autopilot/options.ts";
import type { RunnerOptions, ReasoningEffort } from "./autopilot/options.ts";
import {
  buildStepPrompt,
  parseWorkflowJson,
  parseCompletionJson,
} from "./autopilot/workflow.ts";
import type {
  Workflow,
  StepResult,
  CompletionCheck,
} from "./autopilot/workflow.ts";
import { truncate } from "./autopilot/shared.ts";
import { codexExec, CodexExecError } from "./autopilot/codex-process.ts";
import {
  writeManifest,
  recordCompletionToWorkflowEdge,
  recordWorkflowDependsOnEdges,
  recordInvokesEdges,
} from "./autopilot/artifacts.ts";
import type {
  CaptureContext,
  RunManifest,
  GraphNode,
  GraphEdge,
} from "./autopilot/artifacts.ts";

const WORKFLOW_GEN_MAX_ATTEMPTS = 3;

if (isMainModule(import.meta.url)) {
  try {
    if (process.argv.length === 3 && process.argv[2] === "--version") {
      printVersion();
    } else {
      const parsed = parseArgs(process.argv.slice(2));
      if (!parsed) printHelp();
      else await run(parsed);
    }
  } catch (error) {
    console.error(
      `[autopilot] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode ||= 1;
  }
}

async function run(options: RunnerOptions): Promise<void> {
  const controller = new AbortController();
  const onInterrupt = () => {
    process.exitCode = 130;
    controller.abort();
  };
  const onTerminate = () => {
    process.exitCode = 143;
    controller.abort();
  };
  await mkdir(options.outDir, { recursive: true });
  const runId = `autopilot-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const runFile = path.join(options.outDir, runId, "summary.json");
  const runDir = path.join(options.outDir, runId);
  const runManifestPath = path.join(runDir, "manifest.json");
  await mkdir(runDir, { recursive: true });

  const runManifest: RunManifest = {
    runId,
    startedAt: new Date().toISOString(),
    status: "running",
    cwd: process.cwd(),
    options: {
      model: options.model,
      effort: options.effort,
      concurrency: options.concurrency,
      unsafe: options.unsafe,
      search: options.search,
      sandbox: options.unsafe ? "danger-full-access" : options.sandbox,
    },
    execs: [],
    graph: {
      nodes: [],
      edges: [],
      warnings: [],
    },
  };

  await writeFile(
    runManifestPath,
    JSON.stringify(runManifest, null, 2),
    "utf8",
  );

  const runState: {
    task: string;
    model?: string;
    effort?: ReasoningEffort;
    unsafe: boolean;
    search: boolean;
    iterations: Array<{
      index: number;
      workflow: Workflow;
      steps: StepResult[];
      completion: CompletionCheck;
    }>;
  } = {
    task: options.task,
    model: options.model,
    effort: options.effort,
    unsafe: options.unsafe,
    search: options.search,
    iterations: [],
  };

  const captureContext: CaptureContext = {
    signal: controller.signal,
    runDir,
    runManifestPath,
    runManifest,
    nextExecIndex: 1,
    manifestWrite: Promise.resolve(),
    graphIndex: {
      nodes: new Map<string, GraphNode>(),
      edges: new Map<string, GraphEdge>(),
      warnings: new Set<string>(),
      transcriptThreads: new Set<string>(),
      transcriptCallIds: new Map<string, string>(),
    },
  };

  console.log(`[autopilot] Run id: ${runId}`);
  console.log(
    `[autopilot] Settings: model=${options.model ?? "Codex default"} effort=${options.effort ?? "Codex default"} concurrency=${options.concurrency} maxIterations=${options.maxIterations} search=${options.search ? "on" : "off"} unsafe=${options.unsafe ? "on" : "off"}`,
  );
  console.log(`[autopilot] Artifacts: ${runDir}`);

  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  try {
    let carrySummary = "";
    let nextWorkflowOverride: Workflow | null = null;
    let pendingCompletionExecId: string | null = null;
    for (
      let iteration = 1;
      iteration <= options.maxIterations;
      iteration += 1
    ) {
      let workflow: Workflow;
      let workflowGenExecId: string | null = null;
      if (nextWorkflowOverride) {
        workflow = nextWorkflowOverride;
        workflowGenExecId = pendingCompletionExecId;
        pendingCompletionExecId = null;
      } else {
        const workflowGen = await generateWorkflow(
          options,
          carrySummary,
          iteration,
          captureContext,
        );
        workflow = workflowGen.workflow;
        workflowGenExecId = workflowGen.execId;
        if (pendingCompletionExecId && workflowGenExecId) {
          recordCompletionToWorkflowEdge(
            pendingCompletionExecId,
            workflowGenExecId,
            captureContext,
          );
          await writeManifest(captureContext);
        }
      }
      nextWorkflowOverride = null;
      console.log(
        `\n[autopilot] Iteration ${iteration}: workflow=${workflow.id} steps=${workflow.steps.length} concurrency=${options.concurrency}`,
      );
      logWorkflowPlan(workflow);
      await writeFile(
        path.join(runDir, `workflow-${iteration}.json`),
        JSON.stringify(workflow, null, 2),
      );

      const stepResults = await executeWorkflow(
        options,
        workflow,
        captureContext,
      );
      recordWorkflowDependsOnEdges(workflow, stepResults, captureContext);
      const completionRun = await checkCompletion(
        options,
        workflow,
        stepResults,
        iteration,
        captureContext,
      );
      const completion = completionRun.completion;
      recordInvokesEdges(
        workflowGenExecId,
        stepResults,
        completionRun.execId,
        captureContext,
      );
      await writeManifest(captureContext);

      runState.iterations.push({
        index: iteration,
        workflow,
        steps: stepResults,
        completion,
      });
      await writeFile(runFile, JSON.stringify(runState, null, 2), "utf8");

      if (completion.done) {
        runManifest.status = "succeeded";
        runManifest.finishedAt = new Date().toISOString();
        await writeManifest(captureContext);
        console.log("\n[autopilot] Done.");
        console.log(
          completion.summary.trim() ? completion.summary : "(no summary)",
        );
        console.log(`\n[autopilot] Run log: ${runFile}`);
        return;
      }

      console.log(`\n[autopilot] Not done: ${completion.reason}`);

      if (completion.nextWorkflow) {
        console.log(
          "[autopilot] Reviewer provided next workflow; continuing.\n",
        );
        carrySummary = formatCarrySummary(workflow, stepResults, completion);
        nextWorkflowOverride = completion.nextWorkflow;
        pendingCompletionExecId = completionRun.execId;
        continue;
      }

      carrySummary = formatCarrySummary(workflow, stepResults, completion);
      pendingCompletionExecId = completionRun.execId;
    }

    runManifest.status = "incomplete";
    process.exitCode = 2;
    console.log(
      `\n[autopilot] Stopped after maxIterations=${options.maxIterations}. See run log: ${runFile}`,
    );
  } catch (error) {
    runManifest.status = controller.signal.aborted ? "cancelled" : "failed";
    runManifest.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    runManifest.finishedAt = new Date().toISOString();
    await writeManifest(captureContext);
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  }
}

async function generateWorkflow(
  options: RunnerOptions,
  carrySummary: string,
  iteration: number,
  captureContext: CaptureContext,
): Promise<{ workflow: Workflow; execId: string }> {
  let previousError = "";
  for (let attempt = 1; attempt <= WORKFLOW_GEN_MAX_ATTEMPTS; attempt += 1) {
    const prompt = buildWorkflowGeneratorPrompt({
      task: options.task,
      carrySummary,
      iteration,
      attempt,
      previousError,
    });
    try {
      const run = await codexExec({
        label: `workflow-gen:iteration-${iteration}:attempt-${attempt}`,
        prompt,
        model: options.model,
        effort: options.effort,
        unsafe: options.unsafe,
        // Workflow planning itself does not need web search and is more stable without it.
        search: false,
        outputSchemaJson: WORKFLOW_OUTPUT_SCHEMA_JSON,
        captureContext,
      });
      return {
        workflow: parseWorkflowJson(run.outputText),
        execId: run.execId,
      };
    } catch (error) {
      captureContext.signal?.throwIfAborted();
      if (error instanceof CodexExecError) throw error;
      previousError = error instanceof Error ? error.message : String(error);
      if (attempt >= WORKFLOW_GEN_MAX_ATTEMPTS) {
        throw new Error(
          `Workflow generation failed after ${WORKFLOW_GEN_MAX_ATTEMPTS} attempts: ${previousError}`,
        );
      }
      console.warn(
        `[autopilot] workflow-gen attempt ${attempt} failed; retrying (${previousError})`,
      );
    }
  }
  throw new Error("Workflow generation failed unexpectedly.");
}

function logWorkflowPlan(workflow: Workflow): void {
  for (const step of workflow.steps) {
    const deps = step.dependsOn.length > 0 ? step.dependsOn.join(",") : "none";
    console.log(
      `[autopilot] plan ${step.id}: deps=${deps} goal="${previewForLog(step.goal, 120)}"`,
    );
  }
}

async function executeWorkflow(
  options: RunnerOptions,
  workflow: Workflow,
  captureContext: CaptureContext,
): Promise<StepResult[]> {
  const byId = new Map(workflow.steps.map((step) => [step.id, step]));
  const remaining = new Set(workflow.steps.map((s) => s.id));
  const completed = new Set<string>();
  const results = new Map<string, StepResult>();

  while (remaining.size > 0) {
    captureContext.signal?.throwIfAborted();
    const ready = Array.from(remaining).filter((stepId) => {
      return byId.get(stepId)!.dependsOn.every((dep) => completed.has(dep));
    });

    if (ready.length === 0) {
      const stuck = Array.from(remaining).slice(0, 10).join(", ");
      throw new Error(
        `Workflow is stuck (missing deps or cycle). Remaining: ${stuck}`,
      );
    }

    const wave = ready.slice(0, options.concurrency);
    console.log(
      `[autopilot] Wave start: ${wave.length} step(s) -> ${wave.join(", ")} (remaining=${remaining.size}, concurrency=${options.concurrency})`,
    );

    const waveResults = await Promise.all(
      wave.map(async (stepId) => {
        const startedAtMs = Date.now();
        const step = byId.get(stepId)!;
        const depOutputs = step.dependsOn.map((depId) => results.get(depId)!);
        const failedDeps = depOutputs.filter(
          (dep) => dep.status !== "succeeded",
        );
        if (failedDeps.length) {
          return {
            stepId,
            status: "failed" as const,
            execId: "unknown",
            threadId: "unknown",
            outputText: "",
            error: `Skipped because dependencies failed: ${failedDeps.map((dep) => dep.stepId).join(", ")}`,
          };
        }
        const prompt = buildStepPrompt(options.task, step, depOutputs);
        try {
          const depList = depOutputs.map((dep) => dep.stepId).join(", ");
          console.log(
            `[step:${stepId}] start model=${options.model ?? "Codex default"} effort=${options.effort ?? "Codex default"} search=${options.search ? "on" : "off"} deps=${depList || "none"} goal="${previewForLog(step.goal, 120)}"`,
          );
          const run = await codexExec({
            label: `step:${stepId}`,
            prompt,
            model: options.model,
            effort: options.effort,
            unsafe: options.unsafe,
            sandbox: options.sandbox,
            search: options.search,
            captureContext,
          });
          console.log(
            `[step:${stepId}] completed in ${formatDurationMs(Date.now() - startedAtMs)} exec=${run.execId} thread=${run.threadId} output="${previewForLog(run.outputText, 160)}"`,
          );
          return {
            stepId,
            status: "succeeded" as const,
            execId: run.execId,
            threadId: run.threadId,
            outputText: run.outputText,
            usage: run.usage,
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (error instanceof CodexExecError) {
            return {
              stepId,
              status: "failed" as const,
              execId: error.execId,
              threadId: error.threadId,
              outputText: "",
              error: message,
            };
          }
          return {
            stepId,
            status: "failed" as const,
            execId: "unknown",
            threadId: "unknown",
            outputText: "",
            error: message,
          };
        }
      }),
    );

    for (const result of waveResults) {
      results.set(result.stepId, result);
      completed.add(result.stepId);
      remaining.delete(result.stepId);
      const outputSnippet =
        result.status === "succeeded"
          ? ` output="${previewForLog(result.outputText, 160)}"`
          : "";
      const errorSnippet = result.error
        ? ` error="${previewForLog(result.error, 180)}"`
        : "";
      console.log(
        `[step:${result.stepId}] ${result.status} exec=${result.execId} thread=${result.threadId}${outputSnippet}${errorSnippet}`,
      );
    }
  }

  return workflow.steps.map((step) => results.get(step.id)!);
}

function previewForLog(text: string, maxChars: number): string {
  const normalized = String(text).replace(/\s+/g, " ").trim();
  if (!normalized) return "(empty)";
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 3))}...`;
}

function formatDurationMs(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "unknown";
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

async function checkCompletion(
  options: RunnerOptions,
  workflow: Workflow,
  results: StepResult[],
  iteration: number,
  captureContext: CaptureContext,
): Promise<{ completion: CompletionCheck; execId: string }> {
  const condensed = results.map((r) => ({
    stepId: r.stepId,
    status: r.status,
    threadId: r.threadId,
    output: truncate(r.outputText, 18_000),
    error: r.error,
  }));

  const promptParts: string[] = [];
  promptParts.push(bundledSkill("reviewer"));
  promptParts.push("");
  promptParts.push(
    "Evaluate the task against evidence. The JSON response contract below overrides skill formatting preferences.",
  );
  promptParts.push("");
  promptParts.push(`Task: ${options.task}`);
  promptParts.push(`Iteration: ${iteration}`);
  promptParts.push("");
  promptParts.push("Here are the workflow results (JSON):");
  promptParts.push(
    JSON.stringify({ workflowId: workflow.id, results: condensed }, null, 2),
  );
  promptParts.push("");
  promptParts.push("Return JSON ONLY with one of these shapes:");
  promptParts.push(
    '1) {"done":true,"summary":"...","reason":null,"nextWorkflow":null}',
  );
  promptParts.push(
    '2) {"done":false,"summary":null,"reason":"...","nextWorkflow":{...workflow json...}}',
  );
  promptParts.push("");
  promptParts.push("Rules:");
  promptParts.push(
    "- Be strict: done=true only if the task is actually completed.",
  );
  promptParts.push(
    "- If not done, provide a small nextWorkflow (<= 6 steps) that finishes the remaining work.",
  );

  const run = await codexExec({
    outputSchemaJson: COMPLETION_OUTPUT_SCHEMA_JSON,
    label: `completion-check:iteration-${iteration}`,
    prompt: promptParts.join("\n"),
    model: options.model,
    effort: options.effort,
    unsafe: options.unsafe,
    search: false,
    captureContext,
  });

  let completion: CompletionCheck;
  try {
    completion = parseCompletionJson(run.outputText);
  } catch (error) {
    completion = {
      done: false,
      reason: `Invalid completion response: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (
    completion.done &&
    results.some((result) => result.status !== "succeeded")
  ) {
    completion = {
      done: false,
      reason:
        "Workflow has failed or skipped steps; completion cannot be accepted.",
    };
  }
  return { completion, execId: run.execId };
}

function formatCarrySummary(
  workflow: Workflow,
  results: StepResult[],
  completion: CompletionCheck,
): string {
  const lines: string[] = [];
  lines.push(`Previous workflow: ${workflow.id}`);
  lines.push("Step statuses:");
  for (const r of results) {
    lines.push(`- ${r.stepId}: ${r.status} (thread ${r.threadId})`);
    if (r.error) {
      lines.push(`  error: ${r.error}`);
    }
  }
  if (!completion.done) {
    lines.push(`Reviewer: not done (${completion.reason})`);
  }
  return lines.join("\n");
}
