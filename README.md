# batch-cluster

**Support external batch-mode tools within Node.js**

[![npm version](https://badge.fury.io/js/batch-cluster.svg)](https://badge.fury.io/js/batch-cluster)
[![Build status](https://travis-ci.org/mceachen/batch-cluster.js.svg?branch=master)](https://travis-ci.org/mceachen/batch-cluster.js)
[![Build status](https://ci.appveyor.com/api/projects/status/4564x6lvc8s6a55l/branch/master?svg=true)](https://ci.appveyor.com/project/mceachen/batch-cluster-js/branch/master)

Many command line tools, like ExifTool and GraphicsMagick, support running
arbitrary commands via a "batch mode," which amortizes process spin-up
costs over several, serial request/response pairs, sent via stdin/stdout.

Spinning up N of these child processes on multiprocessor machines gives you
parallelism.

Distributing requests to these processes, monitoring and restarting
processes as needed, and shutting them down appropriately, is what this
module gives you. In other words, there's native threads, green threads, libuv,
and then there's caveman process-level parallelism. Kick it old-school.

This package powers
[exiftool-vendored](https://github.com/mceachen/exiftool-vendored.js)
(whose source you can examine as an example consumer).

## Installation

Depending on your yarn/npm preference:

```bash
$ npm install --save batch-cluster
# or
$ yarn add batch-cluster
```

## Usage 

The child process must use `stdin` and `stdout` for control/response.
BatchCluster will ensure a given process is only given one task at a time.

1. Extend the [Task](src/Task.ts#L5) class to parse results from your child
process.

2. Create a singleton instance of `BatchCluster`. Note the [constructor
   options](src/BatchCluster.ts#L271) takes a union type of
   * [ChildProcessFactory](src/BatchCluster.ts#L15) and
   * [BatchProcessOptions](src/BatchCluster.ts#L34), both of which have no
   defaults, and 
   * [BatchClusterOptions](src/BatchCluster.ts#L64), which has
   defaults that may or may not be relevant to your application.

3. Give instances of your `Task` to [enqueueTask](src/BatchCluster.ts#L309).

See [src/test.ts](src/test.ts) for an example child process.
Note that the script is more than minimal, due to it being designed to be
flaky to test BatchCluster sufficiently.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).