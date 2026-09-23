# Releasing

The public package is `codex-autopilot`; the repository is `gaslit-ai/codex-autopilot`. Releases use MIT licensing and contain no accounts, credentials, or sample session captures.

## Build and verify

Use Node.js 24 LTS or newer and an npm account with package publishing rights.

```sh
npm ci
npm run verify
npm pack --pack-destination .local
```

`verify` includes a packed-package installation test in an unrelated temporary Git repository. It uses a fake Codex process, so no account or model call is required. Before publishing, also check that the chosen Codex installation can launch and is authenticated.

## Review the exact public contents

Review both the Git commit and the generated tarball. The npm `files` allowlist controls the distribution; ignore rules alone do not sanitize Git history.

- Include source, tests, build tooling, public documentation, repository skills, CI, and the license in Git.
- Include compiled JavaScript, viewer assets, bundled planning/review skills, package metadata, README, and license in npm.
- Exclude `.local/`, `runs/`, session transcripts, `.env` files, `.npmrc`, dependencies, private paths, tokens, and personal working files.
- Use a public or GitHub noreply commit address. Check reachable history when importing another repository; deleting a file in the latest commit does not remove its older contents.

Inspect filenames and contents rather than relying only on automated secret patterns. Never paste discovered secret values into release notes or public issues.

## Publish and confirm

Publish the reviewed tarball, not a directory that can change between review and publication:

```sh
npm whoami
npm publish .local/codex-autopilot-VERSION.tgz --access public
npm view codex-autopilot@VERSION version dist.integrity
```

Replace `VERSION` with the package version. Complete npm's account verification if requested. Keep credentials in the local credential store; do not commit or attach them.

Push the matching source commit and `vVERSION` tag, wait for GitHub Actions, and verify an installation fetched from the public registry. The release should expose working `codex-autopilot --help` and `codex-autopilot-viewer --help` commands from outside the source checkout.
