import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

/** Session rollouts are optional Codex diagnostics, not a stable application API. */
export async function findTranscriptPath(
  threadId: string,
  home = codexHome(),
): Promise<string | null> {
  if (!/^[a-zA-Z0-9_-]+$/.test(threadId)) return null;
  let newest: { file: string; mtime: number } | undefined;
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(file);
        continue;
      }
      // GOTCHA: substring matching also selects .jsonl.backup files. Do not follow
      // symlinks when inspecting the session store, and match the complete suffix.
      if (
        !entry.isFile() ||
        !entry.name.startsWith("rollout-") ||
        !entry.name.endsWith(`-${threadId}.jsonl`)
      )
        continue;
      try {
        const { mtimeMs } = await stat(file);
        if (!newest || mtimeMs > newest.mtime)
          newest = { file, mtime: mtimeMs };
      } catch {
        /* A session may disappear during the scan. */
      }
    }
  }
  await walk(path.join(home, "sessions"));
  await walk(path.join(home, "archived_sessions"));
  return newest?.file ?? null;
}
