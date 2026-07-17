# Decision records

Framework changes that alter a documented product promise should retain a short decision record in
this directory. Historical M1/M2 decisions predate this index and remain represented by the
developer-experience contract, spike evidence, issues, and pull requests.

Name new records `NNNN-short-title.md` and include:

1. **Question** — the decision being made.
2. **Contract IDs** — promises affected in `docs/devx-contract.md`.
3. **Exact versions** — package, runtime, browser, OS, and commit pins.
4. **Control** — the comparison or vendor baseline.
5. **Procedure** — repeatable commands and observable steps.
6. **Evidence** — retained, non-secret artifacts.
7. **Decision** — adopt, revise, defer, or reject.
8. **Contract delta** — what changed in the product promise.
9. **Follow-up** — remaining work with an owner or issue.

A negative result is a valid decision. Do not replace evidence with a search summary, and never
record environment values, account secrets, recovery phrases, or sensitive user content.
