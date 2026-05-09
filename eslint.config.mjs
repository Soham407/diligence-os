import js from "@eslint/js";
import tseslint from "typescript-eslint";

const sharedConfig = [
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/.expo/**",
      "**/dist/**",
      "**/coverage/**",
      "**/supabase/.temp/**"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    rules: {
      "no-console": ["warn", { "allow": ["warn", "error"] }]
    }
  }
];

export default sharedConfig;
