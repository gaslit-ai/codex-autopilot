export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export type Sandbox = "read-only" | "workspace-write";
export type RunnerOptions = {
  task: string;
  model?: string;
  effort?: ReasoningEffort;
  sandbox: Sandbox;
  concurrency: number;
  maxIterations: number;
  unsafe: boolean;
  search: boolean;
  outDir: string;
};

export function parseEffort(value: unknown): ReasoningEffort | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value === "string" &&
    REASONING_EFFORTS.includes(value as ReasoningEffort)
  ) {
    return value as ReasoningEffort;
  }
  throw new Error(
    `Invalid reasoning effort: ${String(value)}. Expected ${REASONING_EFFORTS.join(", ")}.`,
  );
}

export function parseArgs(argv: string[]): RunnerOptions | null {
  const options: RunnerOptions = {
    task: "",
    sandbox: "read-only",
    concurrency: 3,
    maxIterations: 4,
    unsafe: false,
    search: false,
    outDir: "runs/autopilot",
  };
  const taskParts: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      taskParts.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "--help" || arg === "-h") return null;
    if (arg === "--unsafe") {
      options.unsafe = true;
      continue;
    }
    if (arg === "--search") {
      options.search = true;
      continue;
    }
    if (!arg.startsWith("-")) {
      taskParts.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    const known = [
      "--model",
      "--effort",
      "--sandbox",
      "--concurrency",
      "--max-iterations",
      "--out-dir",
    ];
    if (!known.includes(flag))
      throw new Error(`Unknown option: ${flag}. Use --help for usage.`);
    const value = equals === -1 ? argv[++i] : arg.slice(equals + 1);
    if (!value?.trim() || value.startsWith("--"))
      throw new Error(`${flag} requires a value.`);
    switch (flag) {
      case "--model":
        options.model = value;
        break;
      case "--effort":
        options.effort = parseEffort(value);
        break;
      case "--sandbox":
        if (value !== "read-only" && value !== "workspace-write") {
          throw new Error(
            "--sandbox must be read-only or workspace-write. Use --unsafe only for an isolated environment.",
          );
        }
        options.sandbox = value;
        break;
      case "--out-dir":
        options.outDir = value;
        break;
      default: {
        const n = Number(value);
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < 1) {
          throw new Error(`${flag} requires a positive integer.`);
        }
        if (flag === "--concurrency") options.concurrency = n;
        else options.maxIterations = n;
      }
    }
  }
  options.task = taskParts.join(" ").trim();
  if (!options.task)
    throw new Error("A task is required. Use --help for usage.");
  return options;
}

export function printHelp(): void {
  console.log(
    [
      'Usage: codex-autopilot [options] "<task>"',
      "",
      "Options:",
      "  --help                   Show usage",
      "  --version                Show package version",
      "  --model <model>           Override the configured Codex model",
      `  --effort <level>          ${REASONING_EFFORTS.join(" | ")} (Codex default if omitted)`,
      "  --sandbox <mode>          read-only (default) | workspace-write",
      "  --concurrency <n>         Maximum parallel steps (default: 3)",
      "  --max-iterations <n>      Plan/execute cycles (default: 4)",
      "  --search                 Live web search for execution steps (otherwise disabled)",
      "  --unsafe                 Bypass sandbox/approvals in an isolated environment",
      "  --out-dir <dir>          Capture directory (default: runs/autopilot)",
      "  --                       Treat remaining arguments as task text",
      "",
      "CODEX_BIN selects a Codex executable (default: codex on PATH).",
      "CODEX_HOME selects the Codex configuration and transcript directory.",
    ].join("\n"),
  );
}
