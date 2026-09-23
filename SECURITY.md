# Security

Security fixes target the latest release and the current main branch. This project maintains one current workflow and capture contract.

## Report a vulnerability

Use [GitHub's private vulnerability reporting](https://github.com/gaslit-ai/codex-autopilot/security/advisories/new). Include the affected version, a minimal reproduction, the impact, and any proposed fix. Remove credentials and private repository content before submitting. Do not report exploitable vulnerabilities in public issues.

## Local execution and captures

Autopilot launches your local Codex CLI using your account. Its default sandbox is read-only; `--sandbox workspace-write` permits repository edits. All workers share the same checkout. The `--unsafe` option bypasses sandbox restrictions and belongs only in an externally isolated environment.

Captures can contain prompts, source excerpts, local paths, and command output. Keep `runs/` and `.local/` ignored in repositories where you run Autopilot. The viewer binds to loopback by default and is intended for local use. Captures and supplemental Codex transcripts are sensitive working data; do not publish them as support attachments.

See the [operator guide](docs/autopilot/operating-autopilot.md) for permission and execution details.
