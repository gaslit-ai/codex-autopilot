import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isMainModule(moduleUrl: string): boolean {
  if (!process.argv[1]) return false;
  // GOTCHA: npm bin links remain symlinks in argv, while ESM resolves the module.
  return realpathSync(process.argv[1]) === fileURLToPath(moduleUrl);
}

export function printVersion(): void {
  const metadata = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  console.log(metadata.version);
}
