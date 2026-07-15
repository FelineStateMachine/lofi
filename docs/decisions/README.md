# Decision records

Every M1 spike produces a decision record with this shape:

1. **Question** — the falsifiable choice or platform claim.
2. **Contract IDs** — promises exercised by the experiment.
3. **Exact inputs** — package, runtime, browser, OS, and device versions.
4. **Control** — the smallest vendor-supported baseline.
5. **Procedure** — commands and manual steps someone else can repeat.
6. **Evidence** — repository paths, raw-output checksums when useful, tested commit SHA, timestamp,
   measurements, tests, and limitations.
7. **Decision** — adopt, revise, defer, or reject.
8. **Contract delta** — exact promises changed by the result.
9. **Follow-up** — later issue, if the decision intentionally leaves work.

Vendor and platform claims cite primary documentation, changelog/source locations, or retained
device evidence. A search summary without a stable source is not evidence.

A spike is complete when it supports a decision, including a negative decision. It is not complete
merely because a demo rendered once.
