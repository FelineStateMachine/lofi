import { useAll } from "jazz-tools/react";

// This control intentionally reaches only module resolution. Jazz alpha.53's
// React binding imports React 19 `use`, which Preact 10 compat does not export.
console.log(useAll);
