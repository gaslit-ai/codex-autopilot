import { bundledSkill } from "./skills.ts";

type BuildWorkflowGeneratorPromptArgs = {
  task: string;
  carrySummary: string;
  iteration: number;
  attempt: number;
  previousError?: string;
};

const WORKFLOW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["version", "id", "steps"],
  description:
    "A workflow is a collection of steps to accomplish a task. Each step may depend on the outputs of previous steps.",
  properties: {
    version: { type: "integer", const: 1 },
    id: { type: "string", minLength: 1 },
    steps: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "type", "goal", "necessaryContext", "dependsOn"],
        properties: {
          id: { type: "string", minLength: 1 },
          type: { type: "string", const: "agent.run" },
          goal: { type: "string", minLength: 1 },
          necessaryContext: {
            anyOf: [
              {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["fullFilePath", "detailedRelevantInformation"],
                  properties: {
                    fullFilePath: {
                      anyOf: [
                        { type: "string", minLength: 1 },
                        { type: "null" },
                      ],
                      description:
                        "If relevant information is from a file, provide the full file path, optionally include line number.",
                    },
                    detailedRelevantInformation: {
                      type: "string",
                      minLength: 1,
                    },
                  },
                },
              },
              { type: "null" },
            ],
          },
          dependsOn: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

export const WORKFLOW_OUTPUT_SCHEMA_JSON = JSON.stringify(WORKFLOW_SCHEMA);
export const COMPLETION_OUTPUT_SCHEMA_JSON = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["done", "summary", "reason", "nextWorkflow"],
  properties: {
    done: { type: "boolean" },
    summary: { anyOf: [{ type: "string" }, { type: "null" }] },
    reason: { anyOf: [{ type: "string" }, { type: "null" }] },
    nextWorkflow: { anyOf: [WORKFLOW_SCHEMA, { type: "null" }] },
  },
});

export function buildWorkflowGeneratorPrompt(
  params: BuildWorkflowGeneratorPromptArgs,
): string {
  const promptParts: string[] = [];
  promptParts.push(bundledSkill("workflow-generator"));
  promptParts.push(
    "Inspect the repository and decompose the task into executable steps.",
  );
  promptParts.push(
    "Plan only; do not implement the task during workflow generation.",
  );
  promptParts.push("");
  promptParts.push(
    "This is an unattended planning call. Use the available context; express unresolved prerequisites in the plan.",
  );
  promptParts.push(
    "Return JSON only. Do not include markdown fences or prose.",
  );
  promptParts.push("");
  promptParts.push(`Task: ${params.task}`);
  if (params.carrySummary.trim()) {
    promptParts.push("");
    promptParts.push("Context from previous iterations:");
    promptParts.push(params.carrySummary);
  }
  if (params.previousError?.trim()) {
    promptParts.push("");
    promptParts.push("Previous attempt failed:");
    promptParts.push(params.previousError.trim());
    promptParts.push("Fix the issue and output only valid workflow JSON.");
  }
  promptParts.push("");
  promptParts.push("Output ONLY valid JSON for a workflow object with fields:");
  promptParts.push("- version (1)");
  promptParts.push("- id (string)");
  promptParts.push(
    '- steps: array of { id, type:"agent.run", goal, necessaryContext, dependsOn }',
  );
  promptParts.push(
    "- necessaryContext: array of { fullFilePath: string | null, detailedRelevantInformation: string } OR null",
  );
  promptParts.push("");
  promptParts.push("Rules:");
  promptParts.push(
    "- Keep it small (<= 8 steps). Prefer parallel research -> execute -> verify -> summarize.",
  );

  promptParts.push(
    "- Invoke a skill only when it exists and helps the step. Plain task instructions are valid.",
  );
  promptParts.push(
    "- Steps share one checkout. Serialize edits that can touch the same files.",
  );
  promptParts.push("- Use dependsOn to express data dependencies.");
  promptParts.push(
    "- If iteration > 1, focus only on remaining work (do not repeat completed steps).",
  );
  promptParts.push("");
  promptParts.push(`Iteration: ${params.iteration}`);
  promptParts.push(`Attempt: ${params.attempt}`);
  return promptParts.join("\n");
}
