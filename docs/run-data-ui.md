# Capture and viewer reference

## Capture layout

Each run writes one directory under `--out-dir` (default `runs/autopilot`):

```text
<runId>/
  manifest.json
  workflow-1.json
  summary.json
  exec-001-workflow-gen-iteration-1-attempt-1/
    prompt.txt
    argv.json
    schema.json
    events.jsonl
    stderr.txt
    last_message.txt
```

`manifest.json` contains run ID, timestamps, status, working directory, CLI settings, exec entries, and graph nodes/edges/warnings. The authoritative TypeScript contract is [artifacts.ts](../src/autopilot/artifacts.ts).

Run status is `running`, `succeeded`, `incomplete`, `failed`, or `cancelled`. Terminal runs have `finishedAt`; failed/cancelled runs can include `error`. Model and effort settings are omitted when inherited from Codex. Manifest updates use atomic rename so readers never see half-written JSON.

Each exec records its label, thread ID, status, process exit code, timestamps, and relative artifact paths. An exec can fail even with process exit code zero when its event protocol is invalid. When no thread was emitted, its recorded ID is `unknown`.

- `prompt.txt`: complete stdin prompt.
- `argv.json`: executable and exact arguments. The final `-` tells Codex to read stdin; prompt text is not in argv.
- `schema.json`: structured-output schema for planning and review calls.
- `events.jsonl`: raw stdout bytes.
- `stderr.txt`: raw stderr bytes.
- `last_message.txt`: final output file or captured final-message event if Codex did not write the file.
- `workflow-N.json`: validated plan, saved before its steps run.
- `summary.json`: accumulated completed iterations, including workflows, step outcomes, and reviewer decisions. It may be absent if the first iteration fails before review.

Captures contain task text, model output, source excerpts, local paths, and command output. Treat them as private. This repository ignores them; add `runs/` to your own repository's ignore rules when using the installed CLI there.

## Execution graph

`exec` nodes correspond to subprocesses; `thread` nodes represent supplemental collaboration sessions. Edges describe `dependsOn`, `invokes`, `spawn`, or `interact` relationships. A reviewer-provided next workflow uses the review exec as its upstream node. A new planning call is linked to the previous review.

Collaboration enrichment reads Codex rollout events from `sessions/` and `archived_sessions/` beneath `CODEX_HOME` (default `~/.codex`). This storage format is an implementation detail of Codex. Missing rollouts produce warnings; they do not invalidate the run or replace captured JSONL evidence.

## Viewer API

Start with `codex-autopilot-viewer` (or `npm run viewer` in a source checkout). Default host is `127.0.0.1`, port `4141`, and capture directory `runs/autopilot` beneath the current directory. `--runs-dir`, `--codex-home`, `--host`, and `--port` configure these explicitly.

| GET endpoint                                                                         | Result                                |
| ------------------------------------------------------------------------------------ | ------------------------------------- |
| `/`                                                                                  | Viewer HTML.                          |
| `/assets/app.js`, `/assets/commands.js`, `/assets/styles.css`, `/assets/favicon.svg` | Static UI assets.                     |
| `/api/runs`                                                                          | Run IDs and timestamps, newest first. |
| `/api/runs/<runId>/manifest`                                                         | Run manifest JSON.                    |
| `/api/runs/<runId>/file?path=<relative-path>`                                        | UTF-8 artifact stream.                |
| `/api/transcript/<threadId>`                                                         | Supplemental rollout stream.          |
| `/api/transcript/<threadId>?meta=1`                                                  | Rollout path JSON.                    |

The server accepts GET only, rejects cross-site browser requests and unexpected Host names, applies a restrictive Content Security Policy, and checks real paths for both run directories and artifacts. Symlinks cannot escape the configured capture root or the selected run. Transcript search matches complete filenames and skips symlink entries.

The UI uses DOM text APIs, aborts event streams when selection changes, and quotes both ID and prompt when copying a POSIX resume command. It does not execute the copied command.
