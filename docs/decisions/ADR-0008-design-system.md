# ADR-0008 — Cursor-app design system

## Status

Accepted — stacked on Phase 1 UI (PR #11).

## Decision

- Shared UI package `@nexus/ui` with CSS token layers (primitive → semantic → `@theme inline`).
- Light and dark themes via `data-theme`, persisted in `localStorage` (`nexus.theme`).
- Radix primitives + CVA for accessible interactive components; `cmdk` for command palette.
- App shell: sidebar, title bar, status bar, command palette (`Cmd+K`).
- Typography: Inter (UI), JetBrains Mono (keys, events, JSON).

## Why

Phase 1 Step 1.8 required shadcn-style primitives, light/dark theme, and an app shell. PR #11 shipped domain logic with ad-hoc dark-only styling incompatible with later phases (inbox, attention swimlanes, inline actions).

## Consequences

- `apps/web` must not use raw `white/N` or legacy lime accent utilities; guard test enforces this under `app/`.
- New surfaces should compose `@nexus/ui` patterns before adding page-local styles.
- `packages/ui` must not import Next.js; navigation uses `onNavigate` callbacks from the app.
