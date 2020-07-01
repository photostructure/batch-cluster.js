# batch-cluster

**Efficient, concurrent work via batch-mode command-line tools from within Node.js.**

[![npm version](https://img.shields.io/npm/v/batch-cluster.svg)](https://www.npmjs.com/package/batch-cluster)
[![Build status](https://travis-ci.org/photostructure/batch-cluster.js.svg?branch=master)](https://travis-ci.org/photostructure/batch-cluster.js)
[![Build status](https://ci.appveyor.com/api/projects/status/4564x6lvc8s6a55l/branch/master?svg=true)](https://ci.appveyor.com/project/mceachen/batch-cluster-js/branch/master)
[![GitHub issues](https://img.shields.io/github/issues/photostructure/batch-cluster.js.svg)](https://github.com/photostructure/batch-cluster.js/issues)
[![Language grade: JavaScript](https://img.shields.io/lgtm/grade/javascript/g/photostructure/batch-cluster.js.svg)](https://lgtm.com/projects/g/photostructure/batch-cluster.js/context:javascript)
[![Known Vulnerabilities](https://snyk.io/test/github/photostructure/batch-cluster.js/badge.svg?targetFile=package.json)](https://snyk.io/test/github/photostructure/batch-cluster.js?targetFile=package.json)

Many command line tools, like
[ExifTool](https://sno.phy.queensu.ca/~phil/exiftool/),
[PowerShell](https://github.com/powershell/powershell), and
[GraphicsMagick](http://www.graphicsmagick.org/), support running in a "batch
mode" that accept a series of discrete commands provided through stdin and
results through stdout. As these tools can be fairly large, spinning them up can
be expensive (especially on Windows).

This module allows you to run a series of commands, or `Task`s, processed by a
cluster of these processes.

This module manages both a queue of pending tasks, feeding processes pending
tasks when they are idle, as well as monitoring the child processes for errors
and crashes. Batch processes are also recycled after processing N tasks or
running for N seconds, in an effort to minimize the impact of any potential
memory leaks.

As of version 4, retry logic for tasks is a separate concern from this module.

This package powers [exiftool-vendored](https://photostructure.github.io/exiftool-vendored.js/),
whose source you can examine as an example consumer.

## Installation

Depending on your yarn/npm preference:

```bash
$ yarn add batch-cluster
# or
$ npm install --save batch-cluster
```

## Changelog

See [CHANGELOG.md](https://github.com/photostructure/batch-cluster.js/blob/master/CHANGELOG.md).

## Usage

The child process must use `stdin` and `stdout` for control/response.
BatchCluster will ensure a given process is only given one task at a time.

1.  Create a singleton instance of
    [BatchCluster](https://photostructure.github.io/batch-cluster.js/classes/batchcluster.html).

    Note the [constructor
    options](https://photostructure.github.io/batch-cluster.js/classes/batchcluster.html#constructor)
    takes a union type of

    - [ChildProcessFactory](https://photostructure.github.io/batch-cluster.js/interfaces/childprocessfactory.html)
      and
    - [BatchProcessOptions](https://photostructure.github.io/batch-cluster.js/interfaces/batchprocessoptions.html),
      both of which have no defaults, and
    - [BatchClusterOptions](https://photostructure.github.io/batch-cluster.js/classes/batchclusteroptions.html),
      which has defaults that may or may not be relevant to your application.

1.  The [default](https://photostructure.github.io/batch-cluster.js/modules/logger.html) logger
    writes warning and error messages to `console.warn` and `console.error`. You
    can change this to your logger by using
    [setLogger](/globals.html#setlogger).

1.  Implement the [Parser](https://photostructure.github.io/batch-cluster.js/interfaces/parser)
    class to parse results from your child process.

1.  Construct a [Task](https://photostructure.github.io/batch-cluster.js/classes/task.html) with the desired command and
    the parser you built in the previous step, and submit it to your BatchCluster
    singleton's
    [enqueueTask](https://photostructure.github.io/batch-cluster.js/classes/batchcluster#enqueuetask) method.

See
[src/test.ts](https://github.com/photostructure/batch-cluster.js/blob/master/src/test.ts)
for an example child process. Note that the script is _designed_ to be flaky on
order to test BatchCluster's retry and error handling code.
