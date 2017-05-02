import { delay } from "./BatchCluster"
import { createInterface } from "readline"

function stripPrefix(s: string, prefix: string): string {
  return (s.startsWith(prefix)) ? s.slice(prefix.length) : s
}

const rl = createInterface({
  input: process.stdin
})

rl.on("line", async (line: string) => {
  line = line.trim()
  if (line.startsWith("upcase ")) {
    console.log(stripPrefix(line, "upcase ").trim().toUpperCase())
    console.log("PASS")
  } else if (line.startsWith("downcase ")) {
    console.log(stripPrefix(line, "downcase ").trim().toLowerCase())
    console.log("PASS")
  } else if (line.startsWith("sleep ")) {
    const millis = parseInt(stripPrefix(line, "sleep").trim(), 10)
    await delay(millis)
    console.log("PASS")
  } else if (line === "version") {
    console.log("v1.2.3")
    console.log("PASS")
  } else if (line.trim() === "exit") {
    process.exit(0)
  } else {
    console.error("COMMAND MISSING for input", line)
    console.log("FAIL")
  }
})
