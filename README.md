# interface-generator
Generate interface for ioredis

## Publishing

Publishing is handled by the `Publish` GitHub Actions workflow.

1. Go to **Actions** > **Publish** > **Run workflow**.
2. Run it from the `main` branch.
3. Choose the SemVer bump:
   - `patch` for backwards-compatible bug fixes.
   - `minor` for backwards-compatible features.
   - `major` for breaking changes.

The workflow bumps `package.json` and `package-lock.json`, creates a
Conventional Commit release commit, publishes to npm with the `NPM_TOKEN`
secret, and pushes the release commit and tag back to GitHub.
