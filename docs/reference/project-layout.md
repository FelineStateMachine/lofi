# Generated project layout

```mermaid
flowchart TB
    Root["my-app/"]
    Root --> Config["Project config<br/>deno.json · astro.config.ts · tsconfig.json"]
    Root --> Env[".env.example"]
    Root --> Public["public/<br/>favicon · manifest · service worker"]
    Root --> Src["src/"]
    Root --> Tests["tests/"]

    Src --> App["app.ts"]
    Src --> Schema["schema.ts"]
    Src --> Permissions["permissions.ts"]
    Src --> Pages["pages/"]
    Src --> Islands["islands/"]
    Src --> Styles["styles/"]
    Src --> Runtime["_lofi/<br/>generated runtime"]
```

## Author-owned files

- `src/schema.ts` declares persisted tables and their field types.
- `src/permissions.ts` declares read and mutation policies.
- `src/app.ts` composes product configuration.
- `src/pages/`, `src/islands/`, and `src/styles/` contain the product experience.
- `public/` contains install and static shell assets.
- `tests/` contains application tests and worked local-first browser examples.

## Generated runtime files

`src/_lofi/` owns durable storage, the Jazz client, account sessions, recovery, lifecycle handling,
PWA capability gates, diagnostics, and table stores. Do not edit these files during normal product
work.

The generated domain hook imports selected `_lofi` runtime seams. Follow that pattern when binding a
new table, but keep vendor setup, storage selection, transports, service-worker logic, and
capability branching out of product components.
