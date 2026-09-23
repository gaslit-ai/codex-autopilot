# September 2026 baseline

Checked on **2026-09-23** against official documentation, npm metadata, and the current Codex CLI help.

| Component           | Baseline                                                                         |
| ------------------- | -------------------------------------------------------------------------------- |
| Node.js             | 24 LTS; CI also verifies 26 Current. Source runs natively; npm ships JavaScript. |
| TypeScript          | 7.0.2, exact lockfile version.                                                   |
| Node types          | 24.13.6, aligned with the minimum runtime.                                       |
| Prettier            | 3.9.9, exact lockfile version.                                                   |
| Codex CLI           | `codex exec` interface checked against 0.156.1.                                  |
| Model and reasoning | Inherit the installed Codex configuration unless explicitly overridden.          |
| Repository skills   | `.agents/skills`.                                                                |
| GitHub Actions      | checkout 7.0.1; setup-node 7.0.0.                                                |

Sources:

- [Node.js release lifecycle](https://nodejs.org/en/about/previous-releases).
- [Codex command reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli): stdin prompts, JSONL, output schemas, and explicit sandbox flags.
- [Non-interactive Codex](https://learn.chatgpt.com/docs/non-interactive-mode): process events and unattended execution.
- [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference): model-dependent reasoning effort and explicit web-search configuration.
- [Skill discovery](https://learn.chatgpt.com/docs/build-skills): repository `.agents/skills` location.
- [checkout release](https://github.com/actions/checkout/releases/tag/v7.0.1) and [setup-node release](https://github.com/actions/setup-node/releases/tag/v7.0.0).

Update this baseline when changing the toolchain or CLI contract. Keep operational instructions current; verify behavior against the installed CLI, not only documentation or a version number.
