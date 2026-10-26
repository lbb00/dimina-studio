import { config } from "@dimina-studio/eslint-config/base";

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...config,
  {
    ignores: ["fe/**", "coverage/**"],
  },
];
