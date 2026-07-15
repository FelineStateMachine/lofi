# ADR 0003: Use static Astro through the Deno command surface

Status: accepted\
Date: 2026-07-15\
Issue: #6

## Decision

Use Astro 7 static output with independently hydrated Preact islands. Run development, checking,
testing, building, and production preview through repository-owned Deno tasks. Serve the production
directory with the small Deno preview command.

Do not add `@deno/astro-adapter` to the graduated application until an on-demand route exists.

## Why

The local-first PWA needs a prerendered offline-capable shell and currently has no server-rendered
route. Static Astro built and hydrated the exact Jazz stack under Deno, starts within the contract
budget, and avoids an unnecessary runtime/deployment layer. A clean-room Deno adapter control also
passed, so the decision is about product simplicity rather than a blocked fallback.

## Consequences

- `deno task preview` serves retained build output, not a fresh implicit build.
- The wrapper owns stable user-facing status, safe environment projection, signal forwarding, and
  the post-build secret scan.
- Astro/Vite/Jazz npm compatibility details remain internal to config and generated runtime files.
- A future SSR requirement must open a new contract decision and can adopt the already-proven Deno
  adapter path.
