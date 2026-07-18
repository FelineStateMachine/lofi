// Repository tools share the shipped package's environment contract, so a
// repo tool can never interpret the same `.env` differently from generated
// commands (name allowlist, validation rules, and LOFI_BASE_PATH included).
export {
  clientEnvironmentNames,
  deploymentEnvironmentNames,
  environmentNames,
  type EnvironmentValidation,
  serverEnvironmentNames,
  validateEnvironment,
} from "../package/tooling/environment.ts";
