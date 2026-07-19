"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("importing the plugin exposes main without starting runtime side effects", () => {
  const before = {
    sigterm: process.listenerCount("SIGTERM"),
    sigint: process.listenerCount("SIGINT"),
    exit: process.listenerCount("exit")
  };
  const { main } = require("../src/plugin");

  assert.equal(typeof main, "function");
  assert.equal(process.listenerCount("SIGTERM"), before.sigterm);
  assert.equal(process.listenerCount("SIGINT"), before.sigint);
  assert.equal(process.listenerCount("exit"), before.exit);
});
