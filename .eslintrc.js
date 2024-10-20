module.exports = {
  env: {
    node: true,
  },
  extends: [
    "plugin:@typescript-eslint/eslint-recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:eslint-plugin-import/recommended",
  ],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    project: "tsconfig.json",
    sourceType: "module",
  },
  plugins: ["@typescript-eslint", "eslint-plugin-import"],
  rules: {
    "@typescript-eslint/explicit-function-return-type": "off",
    "@typescript-eslint/explicit-module-boundary-types": "off",
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-var-requires": "off",
    "@typescript-eslint/await-thenable": ["error"],
    eqeqeq: ["warn", "always", { null: "ignore" }],
    "import/no-cycle": "warn",
    "import/no-unresolved": "off",
    "no-redeclare": "warn",
    "no-undef-init": "warn",
    "no-unused-expressions": "warn",
  },
}
