module.exports = {
  name: "batch-cluster",
  out: "./docs/",
  readme: "./README.md",
  gitRevision: "main", // < prevents docs from changing after every commit
  exclude: ["**/*test*", "**/*spec*"],
  excludePrivate: true,
  entryPoints: [
    "./src/BatchCluster.ts",
  ]
}
