# batch-cluster

**Support external batch-mode tools within Node.js.**

[![npm version](https://badge.fury.io/js/batch-cluster.svg)](https://badge.fury.io/js/batch-cluster)
[![Build status](https://travis-ci.org/mceachen/batch-cluster.js.svg?branch=master)](https://travis-ci.org/mceachen/batch-cluster.js)
[![Build status](https://ci.appveyor.com/api/projects/status/4564x6lvc8s6a55l/branch/master?svg=true)](https://ci.appveyor.com/project/mceachen/batch-cluster-js/branch/master)

Many command line tools, like
[ExifTool](https://sno.phy.queensu.ca/~phil/exiftool/) and
[GraphicsMagick](http://www.graphicsmagick.org/), support running in a "batch
mode" that accept commands provided through stdin and results through stdout. As
these tools can be fairly large, spinning them up can be expensive (especially
on Windows).

This module expedites these commands, or "Tasks," by managing a cluster of these
"batch" processes, feeding tasks to idle processes, retrying tasks when the tool
crashes, and preventing memory leaks by restarting tasks after performing a
given number of tasks or after a given set of time has elapsed.

This package powers
[exiftool-vendored](https://github.com/mceachen/exiftool-vendored.js), whose
source you can examine as an example consumer.

## Installation

Depending on your yarn/npm preference:

```bash
$ yarn add batch-cluster
# or
$ npm install --save batch-cluster
```

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## Usage

The child process must use `stdin` and `stdout` for control/response.
BatchCluster will ensure a given process is only given one task at a time.

_If these links are broken, use <https://batch-cluster.js.org/>_

1.  Create a singleton instance of
    [BatchCluster](/classes/_batchcluster_.batchcluster.html).

    Note the [constructor
    options](/classes/_batchcluster_.batchcluster.html#constructor) takes a union
    type of

    - [ChildProcessFactory](/interfaces/_batchcluster_.childprocessfactory.html) and
    - [BatchProcessOptions](/interfaces/_batchcluster_.batchprocessoptions.html),
      both of which have no defaults, and
    - [BatchClusterOptions](/classes/_batchcluster_.batchclusteroptions.html),
      which has defaults that may or may not be relevant to your application.

1.  The [default](/modules/_logger_.consolelogger.html) logger writes warning and
    error messages to `console.warn` and `console.error`. You can change this to
    your logger by using [setLogger](/modules/_logger_.html#setlogger).

1.  Implement the [Parser](/modules/_task_.html#parser) class to parse results from your child
    process.

1.  Construct a [Task](/classes/_task_.task.html) with the desired command and
    the parser you built in the previous step, and submit it to your BatchCluster
    singleton's
    [enqueueTask](/classes/_batchcluster_.batchcluster.html#enqueuetask) method.

See
[src/test.ts](https://github.com/mceachen/batch-cluster.js/blob/master/src/test.ts)
for an example child process. Note that the script is _designed_ to be flaky on
order to test BatchCluster's retry and error handling code.
