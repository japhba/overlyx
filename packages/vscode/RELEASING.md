# Extension releases

Pushing extension, shared core/client, dependency, test, or workflow changes to
`master` starts `.github/workflows/extension-release.yml`. Website deployment is
independent. Uncommitted local changes are not included.

The workflow builds from the pushed commit and pinned LyX submodule, runs editor
and host tests plus the VS Code integration suite, and packages a VSIX. Versions
are `0.3.<GitHub workflow run number>`; no version-bump commit is required. Keep
this workflow's run-number sequence when editing it. A rerun keeps its version.
The packaged `release.json` records the source commit and version.

Superseded builds are cancelled. Publishing is serialized and uploads both the
versioned VSIX and `overlyx-vscode.vsix` to a draft before making it the latest
release. An older run cannot replace a newer latest release. The existing
extension updater discovers the release through GitHub; its prompt/auto/off
preference is unchanged.

To release the current `master` again, use **Actions → Release extension → Run
workflow**, or `gh workflow run extension-release.yml --ref master`. Watch the
run through publication and verify both release assets are present. Releases use
the built-in GitHub token with Contents write permission; no extra secret is
needed. The older local `scripts/release.sh` is for manual releases only; normal
releases should use Actions.
