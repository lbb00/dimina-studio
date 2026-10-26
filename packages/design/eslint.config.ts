import { config } from "@dimina-studio/eslint-config/base";

export default [
  ...config,
  {
    ignores: ["coverage/**", "dist/**", "tailwind-preset.cjs"],
  },
];
