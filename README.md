# batch-cluster

Many command line tools, like ExifTool and GraphicsMagick, offer a "batch mode."
They allow consumers to amortize spin-up costs over several, serial
request/response pairs, sent via stdin/stdout.

Spinning up N of these child processes on multiprocessor machines gives you parallelism.

Distributing requests to these processes and ensuring they are restarted and
shut down appropriately is what what this module does.

This package powers
[exiftool-vendored](https://github.com/mceachen/exiftool-vendored.js).

## Changelog

### v0.0.1

* ✨ Extracted implementation and tests from Exiftool Vendored