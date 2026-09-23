# Operating Autopilot

## Prerequisites

Use Node.js 24 LTS or newer, Git, and a current authenticated Codex CLI on `PATH`. Install with `npm install -g codex-autopilot`, or use `npx codex-autopilot`. Run commands from the Git repository you want the agents to inspect. Planning and review skills ship with the package; target repositories need no Autopilot skill files. See the [root quickstart](../../README.md).

`CODEX_BIN` selects the executable. `CODEX_HOME` selects configuration, authentication, and supplemental transcripts. The runner and viewer both honor it; the viewer also accepts `--codex-home`.

## Task and configuration

Start with a natural-language task:

```sh
codex-autopilot --concurrency 3 --max-iterations 4 "Inspect the viewer and report concrete defects"
```

The runner generates its workflow internally. It does not accept a workflow-file input. Each validated plan is captured as `workflow-N.json` before execution.

Model and reasoning effort default to Codex configuration. Explicit overrides are available:

```sh
codex-autopilot --model YOUR_MODEL --effort high "Your task"
```

Available reasoning levels depend on the selected model. The CLI recognizes `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`; Codex determines whether the chosen model supports the value.

## Permissions and search

- Default: `--sandbox read-only`, with unattended approval policy `never`.
- Repository edits: explicitly use `--sandbox workspace-write`. Planning and completion checks stay read-only.
- `--unsafe`: bypasses the sandbox and approvals for all calls. Only use in an externally isolated environment.
- `--search`: enables live web search in execution steps. Without it, search is explicitly disabled. Planning and completion checks always disable search.

All steps share the same checkout. Dependencies must serialize overlapping edits. Concurrency only bounds the number of workers; it does not isolate their files.

## Results and exit codes

| Exit          | Meaning                                                                           |
| ------------- | --------------------------------------------------------------------------------- |
| `0`           | The reviewer accepted completion, and every step succeeded.                       |
| `1`           | Invalid invocation, planning failure, process/protocol failure, or capture error. |
| `2`           | The iteration limit was reached without accepted completion.                      |
| `130` / `143` | Interrupted with SIGINT / SIGTERM.                                                |

The runner captures process errors, finalizes run status, and forwards cancellation to active Codex processes. On POSIX systems, cancellation signals each Codex process group and kills remaining descendants within three seconds. On Windows, native `taskkill /T /F` stops the process tree immediately; if that command fails, cleanup falls back to the direct child. A failed prerequisite prevents its dependents from running. Failed execution steps are not replayed automatically; the reviewer can propose a new plan.

Workflow validation failures get up to three planning attempts with the validation error as feedback. Process failures do not trigger a planning retry. Invalid reviewer output cannot mark a task complete.

## Inspect and intervene

```sh
codex-autopilot-viewer
codex-autopilot-viewer --runs-dir /path/to/captures --codex-home /path/to/codex-home
```

Read `manifest.json`, then the failed exec's `stderr.txt`, `events.jsonl`, and `last_message.txt`. The viewer's resume command is a POSIX shell command with both the thread ID and prompt quoted. To give a new instruction manually:

```sh
codex exec resume THREAD_ID "Your follow-up instruction"
```

If Codex cannot launch, first check the selected executable with `codex --version` and repair its installation or set `CODEX_BIN`. Changing the workflow cannot repair a missing executable or authentication failure.

From a source checkout, use `npm ci`, `npm run verify`, and `npm run build`. Source-only equivalents are `npm run autopilot -- "Your task"` and `npm run viewer`. The distributed package runs precompiled JavaScript and requires neither TypeScript nor development dependencies.

Completion is a model judgment. Inspect the reported checks and actual changes before treating the outcome as verified. The runner enforces graph, process, and status contracts; it cannot establish arbitrary task correctness itself.
