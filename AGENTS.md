# Repository guidance

- Keep the local runner and viewer dependency-light. Runtime code uses Node.js built-ins.
- Maintain one current workflow and capture contract. Do not add compatibility aliases or migration layers.
- Keep orchestration in `src/autopilot.ts`, execution/contracts in `src/autopilot/`, and viewer code in `src/viewer.ts` and `src/viewer-ui/`.
- Keep the viewer local by default, validate real file boundaries, and spawn commands with argument arrays and stdin prompts.
- Keep repository skills in `.agents/skills` and documentation in `docs/autopilot` aligned with implementation.
- Write a GOTCHA or TODO comment when a non-obvious constraint or unresolved issue is discovered.
- Add behavior tests for substantive contract changes. Run `npm run verify` before marking changes complete; this includes typechecking and all tests.
- Generated captures and personal working files belong in ignored `runs/` and `.local/` directories.
