# Workflow contract

A workflow is a JSON plan with `version`, `id`, and 1–8 `steps`. The CLI starts with a natural-language task and generates this plan. The schema used for structured generation is in [prompts.ts](../../src/autopilot/prompts.ts); runtime validation and types are in [workflow.ts](../../src/autopilot/workflow.ts).

```json
{
  "version": 1,
  "id": "review-viewer",
  "steps": [
    {
      "id": "inspect",
      "type": "agent.run",
      "goal": "Inspect the viewer and identify concrete defects with file references and reproduction steps.",
      "necessaryContext": null,
      "dependsOn": []
    },
    {
      "id": "review",
      "type": "agent.run",
      "goal": "Verify and prioritize the findings using the source code and relevant tests.",
      "necessaryContext": null,
      "dependsOn": ["inspect"]
    }
  ]
}
```

## Validation and execution

All fields shown are required. Unknown fields are rejected. IDs and goals are non-empty strings without surrounding whitespace; IDs are unique. Dependencies must reference existing steps, contain no duplicates, and form an acyclic graph. The runner validates the entire plan before launching any step.

`necessaryContext` is either `null` or an array of objects containing exactly:

- `fullFilePath`: non-empty string or `null`.
- `detailedRelevantInformation`: non-empty string.

File paths label prompt context; the runner does not automatically read those files. The step's agent can inspect them using its tools.

Successful dependency outputs are included in downstream prompts. A failed dependency skips its dependents. Independent steps execute in waves up to `--concurrency`. Steps share a checkout and should express dependencies for overlapping edits.

A goal can invoke an available skill or give direct task instructions. Skill selection must reflect the current environment. Model, effort, sandbox, search, and concurrency belong to CLI configuration and cannot be changed by a generated plan.

## Completion response

The reviewer uses structured output with exactly four fields:

```json
{
  "done": true,
  "summary": "Verified the requested outcome.",
  "reason": null,
  "nextWorkflow": null
}
```

For incomplete work, `done` is `false`, `summary` is `null`, `reason` is a non-empty string, and `nextWorkflow` is either a valid workflow or `null`. A supplied workflow is validated using the same contract as the initial plan. Without one, the next iteration generates a plan from the task and previous results.

Malformed or inconsistent responses are treated as incomplete, with a validation reason. The runner rejects `done: true` if any step failed or was skipped. See [operating guidance](operating-autopilot.md) for exit codes.
