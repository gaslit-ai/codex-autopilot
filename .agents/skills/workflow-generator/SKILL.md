---
name: workflow-generator
description: Generate a workflow JSON plan for the Autopilot runner from a natural-language task. Use when asked to generate a workflow or when the runner invokes planning.
---

# Workflow Generator

Inspect the task and relevant repository context, then return one JSON object. Plan the work; do not execute the task or create files during this planning call.

Include exactly `version: 1`, a non-empty `id`, and `steps` with 1–8 entries. Each step contains exactly:

- `id`: unique, non-empty string.
- `type`: `"agent.run"`.
- `goal`: concrete instructions and an observable deliverable.
- `dependsOn`: array of existing step IDs; no cycles or duplicates.
- `necessaryContext`: `null` or an array of `{ "fullFilePath": string | null, "detailedRelevantInformation": string }`.

Use only skills available in the current environment. Invoke a skill in the goal when it helps; direct implementation or verification instructions are also valid. Do not invent missing skills or model settings.

Dependencies pass upstream outputs into each step's prompt. Steps share a checkout: serialize changes that may touch the same files. Parallelize independent inspection or disjoint work only. On follow-up iterations, focus on remaining work and use the supplied results and validation errors.

Return JSON only, without prose or Markdown fences. Do not add adapter, profile, model, or permission fields: those belong to the runner's CLI configuration.
