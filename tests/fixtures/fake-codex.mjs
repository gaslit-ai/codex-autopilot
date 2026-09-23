#!/usr/bin/env node
// A deterministic CLI peer: exercises real subprocess, stdin, JSONL and capture I/O.
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const output = args[args.indexOf("--output-last-message") + 1];
const label = path.basename(path.dirname(output));
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString("utf8");
const mode = process.env.FAKE_CODEX_MODE;
if (mode === "collab-events") {
  const sessions = path.join(process.env.CODEX_HOME, "sessions");
  await mkdir(sessions, { recursive: true });
  const events = [
    { type: "collab_agent_interaction_begin", status: "begin" },
    { type: "collab_agent_interaction_end", status: "completed" },
  ].map((event) => ({
    type: "event_msg",
    payload: {
      ...event,
      sender_thread_id: `test-${label}`,
      receiver_thread_id: `worker-${label}`,
      call_id: `call-${label}`,
    },
  }));
  await writeFile(
    path.join(sessions, `rollout-test-${label}.jsonl`),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
}
if (mode === "hold") {
  await writeFile(
    path.join(process.env.CODEX_HOME, "ready"),
    String(process.pid),
  );
  await new Promise(() => setInterval(() => {}, 1000));
}
if (!prompt || args.at(-1) !== "-") {
  console.error("Expected prompt on stdin");
  process.exit(3);
}
const event = (value) => console.log(JSON.stringify(value));
if (mode !== "missing-thread")
  event({ type: "thread.started", thread_id: `test-${label}` });
if (mode === "null-event") console.log("null");
if (mode === "transient-error")
  event({ type: "error", message: "Reconnecting..." });
if (mode === "turn-failed") {
  event({
    type: "turn.failed",
    error: { message: "Action failed with useful detail" },
  });
  process.exit(1);
}
let result = "Work complete.";
if (label.includes("workflow-gen")) {
  const schema = JSON.parse(
    await readFile(args[args.indexOf("--output-schema") + 1], "utf8"),
  );
  if (!schema.properties.steps) throw new Error("Workflow schema missing");
  const steps = [
    {
      id: "inspect",
      type: "agent.run",
      goal: "Inspect the repository",
      necessaryContext: null,
      dependsOn: [],
    },
    {
      id: "review",
      type: "agent.run",
      goal: "Review inspection",
      necessaryContext: null,
      dependsOn: ["inspect"],
    },
  ];
  if (mode === "cycle") steps[0].dependsOn = ["review"];
  result = JSON.stringify({
    version: 1,
    id: "test-workflow",
    steps:
      mode === "parallel"
        ? Array.from({ length: 4 }, (_, i) => ({
            ...steps[0],
            id: `task-${i}`,
          }))
        : steps,
  });
} else if (label.includes("completion-check")) {
  result = JSON.stringify(
    mode === "incomplete"
      ? {
          done: false,
          summary: null,
          reason: "More work needed",
          nextWorkflow: null,
        }
      : { done: true, summary: "Verified", reason: null, nextWorkflow: null },
  );
}
if (mode === "step-failed" && label.includes("step-inspect")) {
  event({ type: "turn.failed", error: { message: "Inspection failed" } });
  process.exit(1);
}
if (mode === "invalid-review" && label.includes("completion-check"))
  result = '{"done":true,"summary":42,"reason":null,"nextWorkflow":null}';
if (mode === "follow-up" && label.includes("completion-check-iteration-1"))
  result = JSON.stringify({
    done: false,
    summary: null,
    reason: "Finish remaining work",
    nextWorkflow: {
      version: 1,
      id: "follow-up",
      steps: [
        {
          id: "finish",
          type: "agent.run",
          goal: "Finish",
          dependsOn: [],
          necessaryContext: null,
        },
      ],
    },
  });
if (mode === "parallel" && label.includes("step-")) {
  const timeline = path.join(process.env.CODEX_HOME, "timeline.jsonl");
  await appendFile(timeline, JSON.stringify({ phase: "start", label }) + "\n");
  await new Promise((resolve) => setTimeout(resolve, 180));
  await appendFile(timeline, JSON.stringify({ phase: "end", label }) + "\n");
}
await writeFile(output, result);
event({
  type: "item.completed",
  item: { type: "agent_message", text: result },
});
if (mode !== "missing-completion")
  event({
    type: "turn.completed",
    usage: { input_tokens: 1, output_tokens: 1 },
  });
