const _chai = require("chai")
_chai.use(require("chai-string"))
_chai.use(require("chai-as-promised"))

export { expect } from "chai"

require("source-map-support").install()
