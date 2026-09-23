import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

async function markdownFiles(dir: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) paths.push(...(await markdownFiles(file)));
    else if (entry.name.endsWith(".md")) paths.push(file);
  }
  return paths;
}
const files = [
  "README.md",
  "AGENTS.md",
  ...(await markdownFiles("docs")),
  ...(await markdownFiles(".agents/skills")),
];
const failures: string[] = [];
for (const file of files) {
  const body = await readFile(file, "utf8");
  for (const match of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].split("#")[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    try {
      await access(
        path.resolve(path.dirname(file), decodeURIComponent(target)),
      );
    } catch {
      failures.push(`${file}: broken link ${target}`);
    }
  }
  if (
    /\.codex\/skills|examples\/(?:codex-autopilot|run-viewer)|src\/workflowSpec|gpt-5\.3-codex|Node\.js 18/.test(
      body,
    )
  ) {
    failures.push(`${file}: obsolete repository reference`);
  }
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else console.log(`Checked ${files.length} documentation files.`);
