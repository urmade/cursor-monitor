# 0004: Distribute direct Cursor Team Hook scripts

- Status: Accepted
- Date: 2026-08-19
- Supersedes: the per-repository installer decision in ADR 0001

## Context

Cursor Monitor originally generated operating-system installers that wrote
project hook scripts and `.cursor/hooks.json` into individual repositories. The
intended deployment is organization-wide through Cursor Team Hooks, so
per-developer installation and repository mutation are unnecessary and create
extra credential distribution.

## Decision

- The authenticated `/hooks` page provides direct `beforeSubmitPrompt` and
  `stop` scripts for Linux, macOS, and Windows.
- Administrators upload those scripts directly in Cursor Team Hooks and apply
  the intended team scope.
- Cursor Monitor does not generate an installer, write project files, merge
  `hooks.json`, or ask developers to run setup commands.
- Script download endpoints are private and non-cacheable because the stop
  script embeds the ingestion credential.
- Hook failures remain non-blocking, and centrally managed environment overrides
  remain available for endpoint and credential rotation.

## Consequences

- Team administrators perform one centralized configuration instead of changing
  each repository or developer machine.
- The product no longer serves `.cursor/hooks.json` or installer wrappers.
- Downloaded stop scripts remain sensitive and must be re-uploaded after an
  embedded token or public URL changes unless Team Hook environment overrides
  supply those values.
