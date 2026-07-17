# Command reference

Run these from a generated project as `deno task <name>`.

| Task                | Purpose                                                             |
| ------------------- | ------------------------------------------------------------------- |
| `dev`               | Validate configuration and run the Astro development server         |
| `doctor`            | Validate source PWA metadata and print secret-free readiness        |
| `test`              | Run the deterministic generated-project test suite                  |
| `build`             | Build and validate the static PWA, fingerprint it, and scan secrets |
| `preview`           | Serve an existing production build locally                          |
| `jazz:provision`    | Create a managed Jazz app and write its configuration to `.env`     |
| `schema:validate`   | Validate the Jazz schema and permission declarations                |
| `schema:deploy`     | Publish the schema, migrations, and permissions                     |
| `migrations:create` | Create a migration under `src/migrations/`                          |
| `migrations:push`   | Push migrations using the managed Jazz configuration                |
| `deploy:create`     | Build and create a static Deno Deploy application                   |
| `deploy`            | Build and deploy a new production version to the configured app     |

## Arguments

```sh
deno task dev -- --host 0.0.0.0
deno task preview --port 4173
deno task jazz:provision --env .env --force
deno task deploy:create --org <org> --app <app>
```

`dev` accepts Astro arguments after `--`. `preview` accepts `--port`. Provisioning accepts an
alternate environment path and requires `--force` before replacing existing values.
