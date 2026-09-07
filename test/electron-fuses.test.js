"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  readNodeCliInspectFuse,
  supportsNodeCliInspectArguments
} = require("../src/electron-fuses");

const SENTINEL = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");

function fuse(wire = "010111001", version = 1, count = wire.length) {
  return Buffer.concat([SENTINEL, Buffer.from([version, count]), Buffer.from(wire)]);
}

function memoryHandle(bytes, options = {}) {
  let position = 0;
  return {
    async read(buffer, offset, length) {
      if (options.readError) throw new Error("unreadable fixture");
      const bytesRead = Math.min(length, bytes.length - position);
      bytes.copy(buffer, offset, position, position + bytesRead);
      position += bytesRead;
      return { bytesRead };
    }
  };
}

test("only explicitly enabled schema-v1 inspector fuses are supported", async () => {
  assert.equal(await readNodeCliInspectFuse(memoryHandle(fuse())), true);
  assert.equal(await readNodeCliInspectFuse(memoryHandle(fuse("rrr1"))), true);
  for (const bytes of [
    Buffer.alloc(0), Buffer.from("ordinary binary"), SENTINEL,
    Buffer.concat([SENTINEL, Buffer.from([1])]),
    fuse("010011001"), fuse("010r11001"), fuse("010x11001"),
    fuse("010111001", 2), fuse("010", 1), fuse("0101", 1, 9),
    fuse("0101x"),
    Buffer.concat([fuse(), fuse("0100")]),
    Buffer.concat([fuse(), SENTINEL])
  ]) {
    assert.equal(await readNodeCliInspectFuse(memoryHandle(bytes)), false, bytes.toString("hex"));
  }
});

test("the scanner validates every fuse across marker, header and wire read boundaries", async () => {
  const record = fuse("0101" + "r".repeat(251));
  for (let chunkSize = 1; chunkSize <= record.length + 2; chunkSize += 1) {
    const bytes = Buffer.concat([Buffer.alloc(13), record, Buffer.alloc(37), fuse()]);
    assert.equal(await readNodeCliInspectFuse(memoryHandle(bytes), { chunkSize }), true, `chunk ${chunkSize}`);
    assert.equal(await readNodeCliInspectFuse(memoryHandle(Buffer.concat([bytes, fuse("0100")])), { chunkSize }), false);
  }
});

test("read errors cannot become compatibility evidence", async () => {
  await assert.rejects(readNodeCliInspectFuse(memoryHandle(fuse(), { readError: true })), /unreadable/);
});

async function frameworkFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threaddeck-fuses-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = path.join(root, "Relocated Apps", "ChatGPT.app");
  const framework = path.join(app, "Contents/Frameworks/Codex Framework.framework/Versions/152.0/Codex Framework");
  await fs.mkdir(path.dirname(framework), { recursive: true });
  await fs.writeFile(framework, fuse());
  const stats = await fs.stat(framework, { bigint: true });
  const main = { pid: 740, command: `${app}/Contents/MacOS/ChatGPT --example` };
  const record = (file = framework, inode = stats.ino, dev = `0x${stats.dev.toString(16)}`) => (
    `ftxt\nD${dev}\ni${inode}\nn${file}\n`
  );
  return { framework, main, record, stats };
}

test("loaded framework checks use exact lsof arguments, read-only open and numeric file identity", async (t) => {
  const fixture = await frameworkFixture(t);
  let opens = 0;
  const supported = await supportsNodeCliInspectArguments(fixture.main, {
    execFile: async (command, args) => {
      assert.equal(command, "/usr/sbin/lsof");
      assert.deepEqual(args, ["-nP", "-a", "-p", "740", "-d", "txt", "-FfniD"]);
      return { stdout: `p740\n${fixture.record()}${fixture.record()}` };
    },
    open: async (file, flags) => {
      assert.equal(file, fixture.framework);
      assert.equal(flags, "r");
      opens += 1;
      return fs.open(file, flags);
    }
  });
  assert.equal(supported, true);
  assert.equal(opens, 1);
});

test("unrelated and nested frameworks are ignored; aliases of the same file are deduplicated", async (t) => {
  const fixture = await frameworkFixture(t);
  const alias = fixture.framework.replace("/Versions/152.0", "");
  const output = [
    fixture.record("/Other/Codex.app/Contents/Frameworks/Electron Framework.framework/Electron Framework"),
    fixture.record(fixture.framework.replace("/Contents/Frameworks/", "/Contents/Frameworks/Helper.app/Contents/Frameworks/")),
    fixture.record(), fixture.record(alias, fixture.stats.ino, fixture.stats.dev.toString())
  ].join("");
  assert.equal(await supportsNodeCliInspectArguments(fixture.main, {
    execFile: async () => ({ stdout: output })
  }), true);
});

test("missing, ambiguous, malformed or replaced mapped frameworks fail closed", async (t) => {
  const fixture = await frameworkFixture(t);
  const other = fixture.framework.replaceAll("Codex Framework", "Electron Framework");
  for (const output of [
    "", `p740\n${fixture.record(other)}`,
    fixture.record() + fixture.record(other, fixture.stats.ino + 1n),
    fixture.record(fixture.framework, fixture.stats.ino + 1n),
    fixture.record(fixture.framework, fixture.stats.ino, fixture.stats.dev + 1n),
    fixture.record().replace(/^i\d+$/m, "iunknown"),
    fixture.record().replace(/^D.+$/m, "Dunknown"),
    fixture.record().replace(/^D.+\n/m, ""),
    fixture.record().replace(/^D.+$/m, "D1\nD2"),
    `fmem\nD${fixture.stats.dev}\ni${fixture.stats.ino}\nn${fixture.framework}\n`,
    `p999\n${fixture.record()}`
  ]) {
    assert.equal(await supportsNodeCliInspectArguments(fixture.main, {
      execFile: async () => ({ stdout: output })
    }), false, output);
  }
  assert.equal(await supportsNodeCliInspectArguments({ ...fixture.main, command: `wrapper ${fixture.main.command}` }, {
    execFile: async () => ({ stdout: fixture.record() })
  }), false);
});

test("a framework that changes during the scan is not considered compatible", async (t) => {
  const fixture = await frameworkFixture(t);
  for (const changedKey of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) {
    let statCalls = 0;
    assert.equal(await supportsNodeCliInspectArguments(fixture.main, {
      execFile: async () => ({ stdout: fixture.record() }),
      open: async () => ({
        ...memoryHandle(fuse()),
        async stat() {
          statCalls += 1;
          return statCalls === 1 ? fixture.stats : {
            ...fixture.stats,
            [changedKey]: fixture.stats[changedKey] + 1n
          };
        },
        async close() {}
      })
    }), false, changedKey);
    assert.equal(statCalls, 2);
  }
});

test("lsof, open, stat and read failures fail closed and opened files are closed", async (t) => {
  const fixture = await frameworkFixture(t);
  assert.equal(await supportsNodeCliInspectArguments(fixture.main, {
    execFile: async () => { throw new Error("lsof unavailable"); }
  }), false);
  for (const failingOperation of ["open", "stat", "read"]) {
    let closed = false;
    assert.equal(await supportsNodeCliInspectArguments(fixture.main, {
      execFile: async () => ({ stdout: fixture.record() }),
      open: async () => {
        if (failingOperation === "open") throw new Error("open failed");
        return {
          async stat(options) {
            assert.equal(options.bigint, true);
            if (failingOperation === "stat") throw new Error("stat failed");
            return fixture.stats;
          },
          async read() { throw new Error("read failed"); },
          async close() { closed = true; }
        };
      }
    }), false);
    assert.equal(closed, failingOperation !== "open");
  }
});
