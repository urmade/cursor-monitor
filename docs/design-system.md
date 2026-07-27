# Nexus design system

Nexus UI lives in `packages/ui` (`@nexus/ui`). It targets the Cursor desktop app: dense 13px UI type, hairline borders, near-monochrome surfaces, and functional blue for focus and links.

## Tokens

Import tokens in the app stylesheet:

```css
@import "@nexus/ui/tokens.css";
@source "../../../packages/ui/src";
```

Semantic tokens are exposed as Tailwind utilities (`bg-canvas`, `text-fg`, `border-border`, etc.). Components must not reference primitive `--nx-gray-*` ramps directly.

Themes use `data-theme="light"` | `data-theme="dark"` on `<html>`, set before paint by `ThemeScript` and updated by `ThemeProvider`.

## Components

Import from `@nexus/ui`:

- Primitives: `Button`, `Input`, `Field`, `Badge`, `Panel`, `Dialog`, `Tabs`, …
- Patterns: `AppShell`, `Sidebar`, `StatusBar`, `CommandPalette`, `PageHeader`

Only modules that need interactivity are client components (`'use client'`).

## Extending

1. Add semantic tokens in `packages/ui/src/tokens/tokens.css` (light and dark blocks).
2. Map them in `@theme inline` if they should become utilities.
3. Add primitives in `packages/ui/src/primitives/` using `cn()` and semantic classes only.
4. For domain-specific status, extend `BadgeTone` in `Badge.tsx` and map in `statusToTone` or similar helpers.
5. Preview on `/design`.

## Guardrail

`apps/web/src/__tests__/no-raw-colors.test.ts` fails if legacy `white/10` or old accent hex literals reappear under `apps/web/app`.
