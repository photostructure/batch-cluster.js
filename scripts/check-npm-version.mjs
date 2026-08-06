import assert from "node:assert/strict";

const npmUserAgent = process.env.npm_config_user_agent;
assert(npmUserAgent, "run this check through an npm script");
const match = /(?:^|\s)npm\/(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(npmUserAgent);
assert(match, `cannot read the npm version from: ${npmUserAgent}`);

const major = Number(match[1]);
const minor = Number(match[2]);
const npmVersion = `${match[1]}.${match[2]}.${match[3]}`;
if (major < 11 || (major === 11 && minor < 10)) {
  throw new Error(
    `npm 11.10.0 or later is required to resolve dependencies; found ${npmVersion}. ` +
      "Use npm ci with the committed lockfile for Node.js compatibility testing.",
  );
}

console.log(`Verified npm ${npmVersion} for dependency resolution.`);
