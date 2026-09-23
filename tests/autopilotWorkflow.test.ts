import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKFLOW_OUTPUT_SCHEMA_JSON,
  buildWorkflowGeneratorPrompt,
} from "../src/autopilot/prompts.ts";

test("workflow planning carries the task, prior results, and repair feedback", () => {
  const prompt = buildWorkflowGeneratorPrompt({
    task: "Do X",
    carrySummary: "Existing review found issue A",
    iteration: 1,
    attempt: 2,
    previousError: "Dependency missing",
  });

  assert.ok(prompt.includes("Do X"));
  assert.ok(prompt.includes("Existing review found issue A"));
  assert.ok(prompt.includes("Dependency missing"));
  assert.match(prompt, /Output ONLY valid JSON/i);
});

test("workflow output schema is valid JSON schema shape", () => {
  const schema = JSON.parse(WORKFLOW_OUTPUT_SCHEMA_JSON) as {
    type?: string;
    required?: string[];
    properties?: {
      steps?: {
        items?: {
          required?: string[];
          properties?: {
            necessaryContext?: {
              anyOf?: Array<{
                type?: string;
                items?: {
                  required?: string[];
                  properties?: Record<string, unknown>;
                };
              }>;
            };
          };
        };
      };
    };
  };

  assert.equal(schema.type, "object");
  assert.deepEqual(schema.required, ["version", "id", "steps"]);
  assert.ok(schema.properties);

  const stepSchema = schema.properties?.steps?.items;
  assert.ok(stepSchema);
  assert.deepEqual(stepSchema?.required, [
    "id",
    "type",
    "goal",
    "necessaryContext",
    "dependsOn",
  ]);

  const necessaryContext = stepSchema?.properties?.necessaryContext;
  assert.ok(Array.isArray(necessaryContext?.anyOf));
  assert.equal(necessaryContext?.anyOf?.[0]?.type, "array");
  assert.equal(necessaryContext?.anyOf?.[1]?.type, "null");
  assert.deepEqual(necessaryContext?.anyOf?.[0]?.items?.required, [
    "fullFilePath",
    "detailedRelevantInformation",
  ]);
  assert.ok(necessaryContext?.anyOf?.[0]?.items?.properties?.fullFilePath);
  assert.ok(
    necessaryContext?.anyOf?.[0]?.items?.properties
      ?.detailedRelevantInformation,
  );
});
