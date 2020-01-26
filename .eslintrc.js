module.exports = {
  env: {
    node: true
  },
  parser: "@typescript-eslint/parser",
  parserOptions: {
    project: "tsconfig.json",
    sourceType: "module"
  },
  plugins: ["@typescript-eslint"],
  rules: {
    "@typescript-eslint/no-extraneous-class": "warn",
    "@typescript-eslint/no-floating-promises": "warn",
    "@typescript-eslint/no-for-in-array": "warn",
    "@typescript-eslint/no-misused-new": "warn",
    "@typescript-eslint/strict-boolean-expressions": "warn",
    "constructor-super": "warn",
    eqeqeq: ["warn", "smart"],
    "no-bitwise": "warn",
    "no-cond-assign": "warn",
    "no-debugger": "warn",
    "no-duplicate-case": "warn",
    "no-eval": "warn",
    "no-fallthrough": "warn",
    "no-redeclare": "warn",
    "no-shadow": [
      "warn",
      {
        hoist: "all"
      }
    ],
    "no-sparse-arrays": "warn",
    "no-throw-literal": "warn",
    "no-undef-init": "warn",
    "no-unsafe-finally": "warn",
    "no-unused-expressions": "warn",
    "no-var": "warn",
    "prefer-const": "warn"
  }
}
