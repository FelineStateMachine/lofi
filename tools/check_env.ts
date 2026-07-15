import { validateEnvironment } from "./env_contract.ts";
import { loadEnvironment } from "./load_env.ts";

const validation = validateEnvironment(await loadEnvironment());

console.log(`lofi environment mode: ${validation.mode}`);
console.log(
  `client variables present: ${validation.presentClientNames.join(", ") || "none"}`,
);
console.log(
  `server-only variables present: ${validation.presentServerNames.join(", ") || "none"}`,
);

for (const warning of validation.warnings) console.warn(`warning: ${warning}`);

if (!validation.ok) {
  for (const error of validation.errors) {
    console.error(`error: ${error}`);
  }
  Deno.exit(1);
}
