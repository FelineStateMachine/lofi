## Summary

<!-- What changed and why, in terms a reviewer can verify. Link the issues this closes. -->

## Contract impact

<!-- Contract IDs implemented or changed (e.g. DX-LOCAL-01), with status transitions
     (proposed → validated / revised / rejected). Write "none" for mechanical changes. -->

## Evidence

<!-- What was run and observed; where retained evidence lives (paths, measurements,
     decision record). "Worked once" is not evidence. -->

## Checklist

- [ ] `deno task check` passes locally
- [ ] Contract table and decision records updated if any promise changed
- [ ] No server-only secret value appears in code, examples, logs, or build output
- [ ] Product UI stays inside the author boundary (no raw Jazz / workers / transports / Workbox)
