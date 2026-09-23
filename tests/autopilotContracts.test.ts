import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../src/autopilot/options.ts";
import { validateWorkflow } from "../src/autopilot/workflow.ts";

test("CLI inherits Codex model settings and validates explicit overrides", () => {
  const options = parseArgs(["inspect this repository"]);
  assert.equal(options?.model, undefined);
  assert.equal(options?.effort, undefined);
  assert.equal(options?.sandbox, "read-only");
  assert.equal(parseArgs(["--effort", "ultra", "inspect"])?.effort, "ultra");
  assert.equal(parseArgs(["--", "--literal task"])?.task, "--literal task");
  for (const args of [
    ["--concurrency", "0", "task"],
    ["--concurrency", "2x", "task"],
    ["--max-iterations", "1.5", "task"],
    ["--model"],
    ["--effort", "typo", "task"],
    ["--unknown", "task"],
    ["--sandbox", "danger-full-access", "task"],
  ])
    assert.throws(() => parseArgs(args), Error, args.join(" "));
});

const step = (id: string, dependsOn: string[] = []) => ({
  id,
  type: "agent.run",
  goal: "Inspect",
  necessaryContext: null,
  dependsOn,
});
test("workflow rejects invalid graphs before any step can run", () => {
  for (const steps of [
    [],
    [step("a"), step("a")],
    [step("a", ["missing"])],
    [step("a", ["a"])],
    [step("a", ["b"]), step("b", ["a"])],
    [{ ...step("a"), dependsOn: [42] }],
  ])
    assert.throws(() => validateWorkflow({ version: 1, id: "test", steps }));
});

test("workflow rejects obsolete fields and missing IDs instead of normalizing them", () => {
  assert.throws(() =>
    validateWorkflow({
      version: 1,
      id: "test",
      steps: [{ type: "agent.run", goal: "Inspect", context: "Old capture" }],
    }),
  );
  assert.throws(() =>
    validateWorkflow({
      version: 1,
      id: "test",
      defaults: {},
      steps: [step("a")],
    }),
  );
  const workflow = {
    version: 1,
    id: "test",
    steps: [step("a"), step("b", ["a"])],
  };
  assert.deepEqual(validateWorkflow(workflow), workflow);
});
