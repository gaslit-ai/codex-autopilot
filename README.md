# Codex Autopilot

Turn a task into a validated workflow, run its steps through Codex, and review the result until complete or the iteration limit is reached. Inspect prompts, events, outputs, and the execution graph in a local viewer.

## Install

Requires **Node.js 24 or newer**, Git, and an authenticated [Codex CLI](https://learn.chatgpt.com/docs/codex-cli). Use macOS, Linux, or WSL.

```sh
npm install -g @openai/codex codex-autopilot
codex login
codex-autopilot --help
```

Already have Codex? Run without installing Autopilot globally:

```sh
npx codex-autopilot "Review this repository and report concrete defects"
```

Run commands **inside the Git repository you want to work on**. Autopilot bundles its planning and review instructions; no project-specific setup or copied skill files are required.

## Run

Inspect a repository with the default read-only sandbox:

```sh
codex-autopilot "Review this repository and report the highest-impact improvements"
```

Allow repository edits:

```sh
codex-autopilot --sandbox workspace-write "Implement the requested change and verify it"
```

Autopilot inherits Codex's configured model and reasoning effort. Use `--model` and `--effort` to override them. `--concurrency` bounds simultaneous steps and `--max-iterations` bounds the review loop. All steps share the same checkout. `--search` enables live web search for execution steps.

Start the viewer from the same directory, then open [localhost:4141](http://127.0.0.1:4141):

```sh
codex-autopilot-viewer
```

For captures elsewhere, use `codex-autopilot-viewer --runs-dir /path/to/captures`. With npx, use `npx --package codex-autopilot codex-autopilot-viewer`.

Codex access and usage are governed by your own account. `CODEX_BIN` selects an executable and `CODEX_HOME` selects Codex configuration and sessions. These are local settings; Autopilot includes no credentials or accounts.

## Captures and privacy

Runs are saved to `runs/autopilot/` beneath your working directory. Captures can include task text, source excerpts, paths, and command output. Keep them private and ignore `runs/` in your own repository. The viewer binds to loopback by default. Publishing this package does not upload your runs.

## Develop

```sh
git clone https://github.com/gaslit-ai/codex-autopilot.git
cd codex-autopilot
npm ci
npm run verify
npm run build
```

Source commands are `npm run autopilot -- "Your task"` and `npm run viewer`. Development runs TypeScript directly; npm ships compiled JavaScript, static viewer assets, and two bundled skills. There are no runtime npm dependencies or install scripts.

`npm run verify` checks types, syntax, behavioral tests, documentation links, and formatting. `npm run test:package` builds and tests the actual packed package in a separate temporary repository, without a Codex account or model call.

Read the [operator guide](https://github.com/gaslit-ai/codex-autopilot/blob/main/docs/autopilot/operating-autopilot.md), [workflow contract](https://github.com/gaslit-ai/codex-autopilot/blob/main/docs/autopilot/workflow-contract.md), [architecture](https://github.com/gaslit-ai/codex-autopilot/blob/main/docs/autopilot/architecture.md), and [capture reference](https://github.com/gaslit-ai/codex-autopilot/blob/main/docs/run-data-ui.md).

## License

MIT. See [LICENSE](https://github.com/gaslit-ai/codex-autopilot/blob/main/LICENSE).
