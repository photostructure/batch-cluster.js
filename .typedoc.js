module.exports = {
  name: "batch-cluster",
  out: "./docs/",
  readme: "./README.md",
  includes: "./src",
  gitRevision: "main", // < prevents docs from changing after every commit
  exclude: ["**/*test*", "**/*spec*"],
  excludePrivate: true,
  entryPoints: [
    "./src/BatchCluster.ts",
    // "./src/BatchClusterOptions.ts",
    // "./src/BatchProcessOptions.ts",
    // "./src/Logger.ts",
    // "./src/Task.ts",
  ],

}
