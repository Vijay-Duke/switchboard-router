import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

const moduleDefault = {
  plugins: {
    "@tailwindcss/postcss": {
      base: projectRoot,
    },
  },
};

export default moduleDefault;
