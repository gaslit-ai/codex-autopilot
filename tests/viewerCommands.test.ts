import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { buildResumeCommand, quoteShell } from "../src/viewer-ui/commands.js";

test("resume command quotes both inputs and preserves multiline prompts literally", () => {
  const thread = "id; echo injected";
  const prompt = 'line one\n$(echo injected) `echo no` "$HOME" it\'s literal';
  const command = buildResumeCommand(thread, prompt);
  assert.equal(
    command,
    `codex exec resume ${quoteShell(thread)} ${quoteShell(prompt)}`,
  );
  for (const input of [thread, prompt, "", "--help"]) {
    const actual = execFileSync(
      "/bin/sh",
      ["-c", `printf '%s' ${quoteShell(input)}`],
      { encoding: "utf8" },
    );
    assert.equal(actual, input);
  }
});
