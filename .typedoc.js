module.exports = {
  name: "batch-cluster",
  out: "./docs/",
  readme: "./README.md",
  includes: "./src",
  exclude: ["**/*test*", "**/*spec*"],
  mode: "modules", // "file" doesn't work with Tags. :(
  excludePrivate: true,
  excludeProtected: true,
  excludeExternals: true,
  excludeNotExported: true
}
