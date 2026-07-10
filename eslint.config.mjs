import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = defineConfig([
  ...nextVitals,
  {
    // The React Compiler is not enabled in either Next.js application. These
    // compiler-lint rules reject established event/effect patterns (including
    // Date.now() inside click handlers) even though they are valid at runtime.
    // Keep the standard Rules of Hooks and exhaustive-deps checks enabled.
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/purity": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
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
