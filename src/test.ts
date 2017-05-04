import { delay } from "./Delay"
import { createInterface } from "readline"
import { stdout, env } from "process"

function stripPrefix(s: string, prefix: string): string {
  return (s.startsWith(prefix)) ? s.slice(prefix.length) : s
}

const rl = createInterface({
  input: process.stdin
})

const newline = env.newline === "crlf" ? "\r\n" : env.newline === "cr" ? "\r" : "\n"

function write(s: string): void {
  stdout.write(s + newline)
}

const failrate = (env.failrate == null) ? 0 : parseFloat(env.failrate)
const rng = env.rngseed ? require("seedrandom")(env.rngseed) : Math.random

rl.on("line", async (line: string) => {
  const r = rng()
  if (r < failrate) {
    console.error("EUNLUCKY: r: " + r.toFixed(3) + ", failrate: " + failrate.toFixed(3) + ", seed: " + env.rngseed)
    return
  }
  line = line.trim()
  if (line.startsWith("upcase ")) {
    write(stripPrefix(line, "upcase ").trim().toUpperCase())
    write("PASS")
  } else if (line.startsWith("downcase ")) {
    write(stripPrefix(line, "downcase ").trim().toLowerCase())
    write("PASS")
  } else if (line.startsWith("sleep ")) {
    const millis = parseInt(stripPrefix(line, "sleep").trim(), 10)
    await delay(millis)
    write("PASS")
  } else if (line === "version") {
    write("v1.2.3")
    write("PASS")
  } else if (line.trim() === "exit") {
    process.exit(0)
  } else if (line.startsWith("stderr")) {
    console.error("Error: " + line)
    write("PASS")
  } else {
    console.error("COMMAND MISSING for input", line)
    write("FAIL")
  }
})
