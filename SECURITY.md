# Security Policy

## Reporting a vulnerability

If you find a security issue in this project, please open a private report via [GitHub's "Report a vulnerability" flow](https://github.com/pwnapplehat/Cursor-OpenAI/security/advisories/new) on this repository instead of opening a public issue. Include:

- A description of the issue and its impact.
- Steps to reproduce (a minimal request/config is ideal).
- The version/commit you tested against.

## Secrets

- `CURSOR_API_KEY` (and any `AUTH_KEY` you configure) should live only in a local, git-ignored `.env` file or in your deployment platform's secret store - never in source, never in a commit. `.env` is already listed in `.gitignore`; only `.env.example` (with empty placeholder values) is tracked.
- Logs redact `Authorization` headers and any field named `apiKey`/`cursorApiKey`/`CURSOR_API_KEY`/`api_key` (see `src/logger.ts`). Startup logs mask the configured key to a short prefix/suffix (see `maskSecret` in `src/logger.ts`) - the full key is never printed.
- If a Cursor API key is ever accidentally exposed (committed, logged externally, pasted somewhere public), rotate it immediately from the [Cursor Dashboard](https://cursor.com/dashboard/api) or your team's Service Accounts settings - this project cannot invalidate a key for you.

## Known upstream issue

See the [README's "Known dependency vulnerability" section](./README.md#known-dependency-vulnerability-upstream-no-fix-available) for a transitive `undici` advisory inherited from `@cursor/sdk` that currently has no available fix. This is tracked, not ignored.

## Supported versions

This project tracks the latest commit on `main`. There are no maintained release branches; always run the latest `main` for security fixes.
