# Contributing

Thanks for your interest in improving the Ralio TypeScript SDK.

## Development setup

Requires Node.js 20+.

```bash
git clone https://github.com/Ralioco/ralio-node
cd ralio-node
npm install
```

## Checks

All of these must pass before a PR is merged; CI runs them on Node 20 and 22.

```bash
npm run lint        # eslint
npm run typecheck   # tsc --noEmit (strict)
npm test            # vitest
npm run build       # tsup (must succeed)
```

Formatting is enforced with Prettier — run `npm run format` before committing.

## Guidelines

- **Public API.** Anything exported from `@ralioco/sdk` (the package entry) is
  public and follows SemVer. Modules are not deep-importable; treat everything
  outside the entry point as internal and subject to change.
- **Types.** Every public function, method, and field is typed; `tsc` runs in
  strict mode and must pass with no errors.
- **Tests.** New behavior needs tests. The network is mocked with a `fetch`
  stub — tests must not hit a live API. Crypto correctness (DPoP/assertion
  claims and signatures) is tested with real keys.
- **No new runtime dependencies** without discussion. The SDK intentionally
  depends only on `jose` and Node's built-in `crypto` / `fetch`.
- **Security-sensitive code** (key handling, signing, token lifecycle) gets
  extra review. If your change touches it, call that out in the PR.

## Commit messages & PRs

- Write a clear subject line in the imperative mood.
- Keep PRs focused; update `CHANGELOG.md` under the unreleased section.
- Link any related issue.

## Reporting bugs / requesting features

Use the issue templates. For security issues, see [SECURITY.md](SECURITY.md) —
do not file a public issue.
