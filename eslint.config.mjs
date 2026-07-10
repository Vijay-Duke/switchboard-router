import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = defineConfig([
  ...nextVitals,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated build trees — linting them buries real source failures.
    ".next-cli-build/**",
    "gitbook/.next/**",
    "gitbook/out/**",
    "cli/app/**",
  ]),
]);

export default eslintConfig;
