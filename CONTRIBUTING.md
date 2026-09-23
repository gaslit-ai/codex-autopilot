# Contributing

Use Node.js 24 or newer and Git. An authenticated Codex CLI is needed to run real workflows; automated verification uses a fake Codex process and needs no account.

```sh
git clone https://github.com/gaslit-ai/codex-autopilot.git
cd codex-autopilot
npm ci
npm run verify
```

`npm run build` produces the distributable JavaScript and viewer assets in `dist/`. `npm run autopilot -- "Your task"` and `npm run viewer` run from source. Use `npm run format` before submitting changes.

## Design boundaries

- Keep runtime code dependency-light: use Node.js built-ins.
- Keep orchestration in `src/autopilot.ts`, execution and contracts in `src/autopilot/`, and viewer code in `src/viewer.ts` and `src/viewer-ui/`.
- Maintain one current workflow and capture contract. Update code, tests, skills, and documentation together when the contract changes; do not add compatibility aliases or migration layers.
- Keep the viewer local by default, validate real file boundaries, and spawn commands using argument arrays and stdin prompts.
- Record non-obvious constraints with a short GOTCHA or TODO comment.

Read the [architecture](docs/autopilot/architecture.md) and [workflow contract](docs/autopilot/workflow-contract.md) before changing those boundaries.

## Pull requests

Describe the problem, resulting behavior, and verification evidence. For substantive behavior changes, add a focused regression test that fails before the fix. Prefer assertions about observable contracts over implementation details. Update the relevant documentation with the code.

Run `npm run verify`. It checks types, viewer syntax, behavior, documentation links, formatting, and installation of the packed package in an unrelated temporary repository. GitHub Actions runs the full suite on Linux and macOS with Node.js 24 and 26, plus a Windows package smoke test. Main requires these checks and resolved review conversations before a pull request can merge.

GOTCHA: viewer and package verification start a temporary HTTP server on `127.0.0.1`. Sandboxed development environments must permit local listeners for these checks to run.

Keep captures, credentials, personal paths, and task transcripts out of commits and issue reports. Local experiments belong in ignored `.local/` and `runs/` directories. For vulnerabilities, follow [SECURITY.md](SECURITY.md).

Maintainers should follow the [release procedure](docs/autopilot/releasing.md) and verify the exact artifact they publish.
