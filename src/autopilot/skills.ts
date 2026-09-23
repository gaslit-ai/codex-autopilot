import { readFileSync } from "node:fs";

export function bundledSkill(name: "workflow-generator" | "reviewer"): string {
  // GOTCHA: the target checkout need not contain Autopilot's own planning skills.
  // Resolve our bundled copies from this package, never from the working directory.
  const skill = readFileSync(
    new URL(`../../.agents/skills/${name}/SKILL.md`, import.meta.url),
    "utf8",
  );
  return `Use the following bundled ${name} skill instructions:\n\n${skill}\n\nThe call-specific instructions and response contract below take precedence.\n`;
}
