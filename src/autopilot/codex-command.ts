import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export type CodexCommand = { command: string; args: string[] };
export type CodexCommandOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  nodePath?: string;
};

export async function resolveCodexCommand(
  binary: string,
  args: string[],
  options: CodexCommandOptions = {},
): Promise<CodexCommand> {
  const platform = options.platform ?? process.platform;
  const cwd = options.cwd ?? process.cwd();
  const nodePath = options.nodePath ?? process.execPath;
  const javascript = /\.(?:c|m)?js$/i;
  if (platform !== "win32" && !javascript.test(binary))
    return { command: binary, args };

  const command = await findCommand(
    binary,
    platform,
    options.env ?? process.env,
    cwd,
  );
  if (javascript.test(command))
    return { command: nodePath, args: [path.resolve(cwd, command), ...args] };
  if (!/\.(cmd|bat)$/i.test(command)) return { command, args };

  // GOTCHA: .cmd files require a shell on Windows, which would reinterpret
  // arguments. Resolve only the npm Codex shim to its declared JavaScript bin.
  const entry = await npmCodexEntry(command);
  if (entry) return { command: nodePath, args: [entry, ...args] };
  throw new Error(
    `Unsupported Codex batch shim: ${command}. Set CODEX_BIN to the Codex JavaScript entry or native executable.`,
  );
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function findCommand(
  binary: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<string> {
  const explicitPath = /[\\/]/.test(binary);
  const searchPath =
    Object.entries(env).find(([key]) =>
      platform === "win32" ? key.toLowerCase() === "path" : key === "PATH",
    )?.[1] ?? "";
  const directories = explicitPath
    ? [cwd]
    : [
        cwd,
        ...searchPath.split(platform === "win32" ? ";" : ":").filter(Boolean),
      ];
  const extensions =
    platform === "win32" && !path.extname(binary)
      ? [".exe", ".com", ".cmd", ".bat", ""]
      : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.resolve(cwd, directory, `${binary}${extension}`);
      if (await isFile(candidate)) return candidate;
    }
  }
  // Leave ordinary missing executables to spawn so execution failure is captured.
  return binary;
}

async function npmCodexEntry(shim: string): Promise<string | null> {
  if (path.basename(shim).toLowerCase() !== "codex.cmd") return null;
  let source: string;
  try {
    source = await readFile(shim, "utf8");
  } catch {
    return null;
  }
  const shimDirectory = path.dirname(shim);
  for (const packageDirectory of [
    path.join(shimDirectory, "node_modules", "@openai", "codex"),
    path.join(shimDirectory, "..", "@openai", "codex"),
  ]) {
    try {
      const metadata = JSON.parse(
        await readFile(path.join(packageDirectory, "package.json"), "utf8"),
      );
      const bin: unknown = metadata?.bin?.codex;
      if (
        metadata?.name !== "@openai/codex" ||
        typeof bin !== "string" ||
        !/\.(?:c|m)?js$/i.test(bin)
      )
        continue;
      const entry = path.resolve(packageDirectory, bin);
      const withinPackage = path.relative(packageDirectory, entry);
      if (
        !withinPackage ||
        withinPackage === ".." ||
        withinPackage.startsWith(`..${path.sep}`) ||
        path.isAbsolute(withinPackage)
      )
        continue;
      const relative = path
        .relative(shimDirectory, entry)
        .split(path.sep)
        .join("\\");
      const targets = source.matchAll(
        /"%_prog%"\s+"%dp0%\\([^"\r\n]+)"\s+%\*(?:\r?\n|$)/gi,
      );
      if (
        Array.from(targets).some(
          (match) => match[1].toLowerCase() === relative.toLowerCase(),
        ) &&
        (await isFile(entry))
      )
        return entry;
    } catch {
      // Only recognized npm layouts can be translated without executing a shell.
    }
  }
  return null;
}
