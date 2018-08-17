module.exports = {
  name: "batch-cluster",
  out: "./docs/",
  readme: "./README.md",
  includes: "./src",
  gitRevision: "master", // < prevents docs from changing after every commit
  exclude: ["**/*test*", "**/*spec*"],
  mode: "file",
  excludePrivate: true,
  excludeProtected: true,
  excludeExternals: true,
  excludeNotExported: true
}
