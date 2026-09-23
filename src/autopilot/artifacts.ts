import { createReadStream } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import readline from "node:readline/promises";
import type { ReasoningEffort } from "./options.ts";
import type { Workflow, StepResult } from "./workflow.ts";
import { findTranscriptPath } from "../transcripts.ts";

export type ExecArtifactPaths = {
  eventsJsonl: string;
  stderrTxt: string;
  lastMessageTxt: string;
  promptTxt: string;
  argvJson: string;
  schemaJson?: string;
};

export type ExecManifestEntry = {
  execId: string;
  label: string;
  threadId: string;
  status: "succeeded" | "failed";
  exitCode: number;
  startedAt: string;
  finishedAt: string;
  artifacts: ExecArtifactPaths;
};

export type GraphNode =
  | {
      id: string;
      type: "exec";
      execId: string;
      label: string;
      threadId: string;
      artifacts: ExecArtifactPaths;
    }
  | {
      id: string;
      type: "thread";
      threadId: string;
    };

export type GraphEdge = {
  type: "dependsOn" | "invokes" | "spawn" | "interact";
  from: string;
  to: string;
  callId?: string;
  status?: string;
  prompt?: string;
  source?: "workflow" | "transcript";
};

export type RunManifest = {
  runId: string;
  status: "running" | "succeeded" | "incomplete" | "failed" | "cancelled";
  error?: string;
  startedAt: string;
  finishedAt?: string;
  cwd: string;
  options: {
    model?: string;
    effort?: ReasoningEffort;
    concurrency: number;
    unsafe: boolean;
    search: boolean;
    sandbox: string;
  };
  execs: ExecManifestEntry[];
  graph: {
    nodes: GraphNode[];
    edges: GraphEdge[];
    warnings: string[];
  };
};

export type CaptureContext = {
  signal?: AbortSignal;
  runDir: string;
  runManifestPath: string;
  runManifest: RunManifest;
  nextExecIndex: number;
  manifestWrite: Promise<void>;
  graphIndex: {
    nodes: Map<string, GraphNode>;
    edges: Map<string, GraphEdge>;
    warnings: Set<string>;
    transcriptThreads: Set<string>;
    transcriptCallIds: Map<string, string>;
  };
};

export function allocateExecIndex(captureContext: CaptureContext): number {
  const index = captureContext.nextExecIndex;
  captureContext.nextExecIndex += 1;
  return index;
}

export async function writeManifest(
  captureContext: CaptureContext,
): Promise<void> {
  syncGraphToManifest(captureContext);
  const snapshot = JSON.stringify(captureContext.runManifest, null, 2);
  captureContext.manifestWrite = captureContext.manifestWrite.then(async () => {
    // GOTCHA: a viewer can read while a worker finishes; publish only complete JSON.
    const temporary = `${captureContext.runManifestPath}.tmp`;
    await writeFile(temporary, snapshot, "utf8");
    await rename(temporary, captureContext.runManifestPath);
  });
  await captureContext.manifestWrite;
}

export function recordExecGraphNode(
  entry: ExecManifestEntry,
  captureContext: CaptureContext,
): void {
  const nodeId = `exec:${entry.execId}`;
  if (!captureContext.graphIndex.nodes.has(nodeId)) {
    captureContext.graphIndex.nodes.set(nodeId, {
      id: nodeId,
      type: "exec",
      execId: entry.execId,
      label: entry.label,
      threadId: entry.threadId,
      artifacts: entry.artifacts,
    });
  }
}

function ensureThreadNode(
  threadId: string,
  captureContext: CaptureContext,
): string {
  const nodeId = `thread:${threadId}`;
  if (!captureContext.graphIndex.nodes.has(nodeId)) {
    captureContext.graphIndex.nodes.set(nodeId, {
      id: nodeId,
      type: "thread",
      threadId,
    });
  }
  return nodeId;
}

function recordGraphEdge(
  edge: GraphEdge,
  captureContext: CaptureContext,
  dedupeKey?: string,
): void {
  const key =
    dedupeKey ??
    [
      edge.type,
      edge.from,
      edge.to,
      edge.callId ?? "",
      edge.status ?? "",
      edge.prompt ?? "",
    ].join("|");
  if (!captureContext.graphIndex.edges.has(key)) {
    captureContext.graphIndex.edges.set(key, edge);
  }
}

function recordWarning(message: string, captureContext: CaptureContext): void {
  captureContext.graphIndex.warnings.add(message);
}

function syncGraphToManifest(captureContext: CaptureContext): void {
  captureContext.runManifest.graph = {
    nodes: Array.from(captureContext.graphIndex.nodes.values()),
    edges: Array.from(captureContext.graphIndex.edges.values()),
    warnings: Array.from(captureContext.graphIndex.warnings.values()),
  };
}

export function recordWorkflowDependsOnEdges(
  workflow: Workflow,
  results: StepResult[],
  captureContext: CaptureContext,
): void {
  const execByStep = new Map<string, string>();
  for (const result of results) {
    if (result.execId && result.execId !== "unknown") {
      execByStep.set(result.stepId, `exec:${result.execId}`);
    }
  }
  for (const step of workflow.steps) {
    const stepNode = execByStep.get(step.id);
    if (!stepNode || !Array.isArray(step.dependsOn)) {
      continue;
    }
    for (const dep of step.dependsOn) {
      const depNode = execByStep.get(dep);
      if (!depNode) continue;
      recordGraphEdge(
        {
          type: "dependsOn",
          from: depNode,
          to: stepNode,
          source: "workflow",
        },
        captureContext,
      );
    }
  }
}

export function recordInvokesEdges(
  workflowGenExecId: string | null,
  stepResults: StepResult[],
  completionExecId: string | null,
  captureContext: CaptureContext,
): void {
  if (workflowGenExecId) {
    const workflowNode = `exec:${workflowGenExecId}`;
    for (const step of stepResults) {
      if (!step.execId || step.execId === "unknown") continue;
      recordGraphEdge(
        {
          type: "invokes",
          from: workflowNode,
          to: `exec:${step.execId}`,
          source: "workflow",
        },
        captureContext,
      );
    }
  }
  if (completionExecId) {
    const completionNode = `exec:${completionExecId}`;
    for (const step of stepResults) {
      if (!step.execId || step.execId === "unknown") continue;
      recordGraphEdge(
        {
          type: "invokes",
          from: `exec:${step.execId}`,
          to: completionNode,
          source: "workflow",
        },
        captureContext,
      );
    }
  }
}

export function recordCompletionToWorkflowEdge(
  completionExecId: string,
  workflowGenExecId: string,
  captureContext: CaptureContext,
): void {
  recordGraphEdge(
    {
      type: "invokes",
      from: `exec:${completionExecId}`,
      to: `exec:${workflowGenExecId}`,
      source: "workflow",
    },
    captureContext,
  );
}

export async function enrichGraphFromTranscript(
  threadId: string,
  captureContext: CaptureContext,
): Promise<void> {
  if (captureContext.graphIndex.transcriptThreads.has(threadId)) {
    return;
  }
  captureContext.graphIndex.transcriptThreads.add(threadId);

  let transcriptPath: string | null = null;
  try {
    transcriptPath = await findTranscriptPath(threadId);
  } catch (error) {
    recordWarning(
      `Failed to scan transcripts for threadId=${threadId}: ${error instanceof Error ? error.message : String(error)}`,
      captureContext,
    );
    return;
  }

  if (!transcriptPath) {
    recordWarning(
      `Transcript not found for threadId=${threadId}`,
      captureContext,
    );
    return;
  }

  try {
    await parseTranscript(transcriptPath, captureContext);
  } catch (error) {
    recordWarning(
      `Failed to parse transcript for threadId=${threadId}: ${error instanceof Error ? error.message : String(error)}`,
      captureContext,
    );
  }
}

async function parseTranscript(
  transcriptPath: string,
  captureContext: CaptureContext,
): Promise<void> {
  const stream = createReadStream(transcriptPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!payload || typeof payload !== "object") continue;
    const record = payload as { type?: unknown; payload?: unknown };
    if (
      record.type !== "event_msg" ||
      !record.payload ||
      typeof record.payload !== "object"
    ) {
      continue;
    }
    const evt = record.payload as Record<string, unknown>;
    const evtType = typeof evt.type === "string" ? evt.type : "";
    if (
      evtType !== "collab_agent_spawn_begin" &&
      evtType !== "collab_agent_spawn_end" &&
      evtType !== "collab_agent_interaction_begin" &&
      evtType !== "collab_agent_interaction_end"
    ) {
      continue;
    }

    const senderThreadId =
      typeof evt.sender_thread_id === "string" ? evt.sender_thread_id : "";
    const newThreadId =
      typeof evt.new_thread_id === "string" ? evt.new_thread_id : "";
    const receiverThreadId =
      typeof evt.receiver_thread_id === "string" ? evt.receiver_thread_id : "";
    const callId = typeof evt.call_id === "string" ? evt.call_id : undefined;
    const prompt = typeof evt.prompt === "string" ? evt.prompt : undefined;
    const status =
      typeof evt.status === "string"
        ? evt.status
        : evtType.endsWith("_begin")
          ? "begin"
          : "end";

    const targetThreadId = newThreadId || receiverThreadId;
    if (!senderThreadId || !targetThreadId) continue;

    const edgeType = evtType.includes("spawn") ? "spawn" : "interact";
    const fromNode = ensureThreadNode(senderThreadId, captureContext);
    const toNode = ensureThreadNode(targetThreadId, captureContext);
    // GOTCHA: begin/end events update one call; status is not part of its identity.
    const callSignature = [edgeType, senderThreadId, targetThreadId].join("|");
    if (callId) {
      const prior = captureContext.graphIndex.transcriptCallIds.get(callId);
      if (prior && prior !== callSignature) {
        recordWarning(
          `Transcript call_id collision for call_id=${callId} (saw ${prior} and ${callSignature})`,
          captureContext,
        );
      } else if (!prior) {
        captureContext.graphIndex.transcriptCallIds.set(callId, callSignature);
      }
    }

    const transcriptKey = [
      edgeType,
      senderThreadId,
      targetThreadId,
      callId ?? "",
      status ?? "",
    ].join("|");
    recordGraphEdge(
      {
        type: edgeType,
        from: fromNode,
        to: toNode,
        callId,
        status,
        prompt,
        source: "transcript",
      },
      captureContext,
      `transcript|${transcriptKey}`,
    );
  }
}
