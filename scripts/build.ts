import { execFileSync } from "node:child_process";
import { chmod, cp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = new URL("../dist/", import.meta.url);
await rm(dist, { recursive: true, force: true });
execFileSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"],
  { cwd: root, stdio: "inherit" },
);
await cp(
  new URL("../src/viewer-ui/", import.meta.url),
  new URL("viewer-ui/", dist),
  {
    recursive: true,
  },
);
for (const file of ["autopilot.js", "viewer.js"]) {
  await chmod(new URL(file, dist), 0o755);
}
