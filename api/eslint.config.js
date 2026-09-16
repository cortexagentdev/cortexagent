import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "drizzle", "node_modules"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.ts", "**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node, Bun: "readonly" },
    },
    rules: {
      // The web app is a separate package. Importing it into the api would
      // couple the service to the client bundle.
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../src/*", "@/*"],
              message: "The api must not import from the web app. Share types via @shared/*.",
            },
          ],
        },
      ],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // Dev scripts sit next to src/, so `../src/*` is this service's own source,
    // not the web app the rule above is guarding against.
    files: ["scripts/**/*.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  eslintPluginPrettier,
);
