import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  CopyCheckError,
  checkCopies,
  compareDeploymentSets,
  formatReport,
  isArchived,
  parseCopySpec,
  parseRecord,
} from "../check-copies.mjs";

const CLI = resolve(import.meta.dirname, "..", "check-copies.mjs");
const ROUTER = "CCXPCT3YFLVANSF3AQMYCCZVGCMLTURAYQ6O6DYGQJMTKVYQL6NTOC2V";
const CCTP = "CARH6IA4TA5QAJNQG4B4I7N4336JEBS3GYLPZSEBUCWSNYTDRC7L3AHT";
const SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

function record(overrides = {}) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-10-29T10:17:56.262Z",
    networks: {
      "stellar-testnet": {
        family: "stellar",
        router: ROUTER,
        adapters: { cctp: CCTP },
        tokens: {
          USDC: {
            sacId: SAC,
            code: "USDC",
            issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
            decimals: 7,
            flowLimit: "10000000000000",
            routes: ["axelar-its", "cctp"],
          },
        },
        feeBps: 30,
        flowWindow: 720,
        timelockDelay: 3600,
        commit: "0123456789abcdef0123456789abcdef01234567",
        ...overrides,
      },
    },
  };
}

function workspace() {
  return mkdtempSync(join(tmpdir(), "hyperion-copies-"));
}

function writeJson(dir, name, value) {
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

test("a copy spec is either a path or an explicit git revision", () => {
  const local = parseCopySpec("backend=../backend/deployment.json");
  assert.equal(local.owner, "backend");
  assert.equal(local.revision, null);
  assert.equal(local.path, "../backend/deployment.json");

  const pinned = parseCopySpec("frontend=/srv/frontend@a1b2c3d:src/deployment.json");
  assert.equal(pinned.owner, "frontend");
  assert.equal(pinned.repo, "/srv/frontend");
  assert.equal(pinned.revision, "a1b2c3d");
  assert.equal(pinned.path, "src/deployment.json");

  assert.throws(() => parseCopySpec("just-a-path"), CopyCheckError);
  assert.throws(() => parseCopySpec("backend=/srv/frontend@HEAD"), CopyCheckError);
});

test("a field mismatch names its path and the owning repository", () => {
  const canonical = record();
  const copy = record({ feeBps: 31 });
  const mismatches = compareDeploymentSets(canonical, copy, "backend");

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].owner, "backend");
  assert.equal(mismatches[0].path, "$.networks.stellar-testnet.feeBps");
  assert.equal(mismatches[0].expected, "30");
  assert.equal(mismatches[0].actual, "31");
});

test("route order is not a disagreement, and a missing field is", () => {
  const canonical = record();
  const reordered = record();
  reordered.networks["stellar-testnet"].tokens.USDC.routes = ["cctp", "axelar-its"];
  assert.deepEqual(compareDeploymentSets(canonical, reordered, "frontend"), []);

  const missing = record();
  delete missing.networks["stellar-testnet"].tokens.USDC.flowLimit;
  const mismatches = compareDeploymentSets(canonical, missing, "frontend");
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].path, "$.networks.stellar-testnet.tokens.USDC.flowLimit");
  assert.equal(mismatches[0].reason, "missing field");
});

test("a consumer's own metadata is not a copy mismatch", () => {
  const canonical = record();
  const copy = record({
    commit: "fedcba9876543210fedcba9876543210fedcba98",
    deployedAt: { ledger: 1, timestamp: "2026-01-01T00:00:00.000Z" },
    localPreferences: { theme: "dark" },
  });
  assert.deepEqual(compareDeploymentSets(canonical, copy, "frontend"), []);
});

test("a missing network is reported instead of skipped", () => {
  const canonical = record();
  const copy = { schemaVersion: 1, generatedAt: "2026-10-29T10:17:56.262Z", networks: {} };
  const mismatches = compareDeploymentSets(canonical, copy, "backend");
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].reason, "missing network");
});

test("archived means marked or filed under an archive directory", () => {
  assert.equal(isArchived({ archived: true }), true);
  assert.equal(isArchived({ status: "archived" }), true);
  assert.equal(isArchived({}, "deployments/archive/stellar-testnet-2026-10-01.json"), true);
  assert.equal(isArchived({}, "deployments/testnet.json"), false);
});

test("an archived record is never compared as the active copy", () => {
  const dir = workspace();
  const canonicalPath = writeJson(dir, "canonical.json", record());
  const archivedPath = writeJson(dir, "old.json", { ...record(), archived: true });

  const report = checkCopies({
    canonical: parseCopySpec(`canonical=${canonicalPath}`, "canonical"),
    copies: [parseCopySpec(`backend=${archivedPath}`)],
  });

  assert.equal(report.ok, false);
  assert.equal(report.mismatches[0].reason, "archived copy presented as active");
  assert.equal(report.archived[0].owner, "backend");
  assert.match(formatReport(report), /archived/i);
});

test("--archive records are reported separately and never compared", () => {
  const dir = workspace();
  const canonicalPath = writeJson(dir, "canonical.json", record());
  mkdirSync(join(dir, "archive"));
  const old = record({ router: "CDMOLDF4SJDEDRWTDF7XAYMSRE6L3YEHHIRF57CFWNQYNC6ZOZ5LWCWF" });
  const archivePath = writeJson(dir, join("archive", "old.json"), old);

  const report = checkCopies({
    canonical: parseCopySpec(`canonical=${canonicalPath}`, "canonical"),
    archives: [parseCopySpec(`stellar=${archivePath}`, "archive")],
  });
  assert.equal(report.ok, true);
  assert.equal(report.archived.length, 1);
  assert.match(report.archived[0].note, /never compared/);
});

test("an unmarked record cannot be passed as an archive", () => {
  const dir = workspace();
  const canonicalPath = writeJson(dir, "canonical.json", record());
  const notArchived = writeJson(dir, "current.json", record());
  assert.throws(
    () =>
      checkCopies({
        canonical: parseCopySpec(`canonical=${canonicalPath}`, "canonical"),
        archives: [parseCopySpec(`stellar=${notArchived}`, "archive")],
      }),
    /not marked archived/,
  );
});

test("an archived canonical record is refused", () => {
  const dir = workspace();
  const canonicalPath = writeJson(dir, "canonical.json", { ...record(), status: "archived" });
  assert.throws(
    () => checkCopies({ canonical: parseCopySpec(`canonical=${canonicalPath}`, "canonical") }),
    /marked archived/,
  );
});

test("malformed JSON names the file it rejected", () => {
  assert.throws(() => parseRecord("{ nope", "backend@abc:copy.json"), /backend@abc:copy\.json/);
});

test("the command agrees, disagrees and never rewrites a consumer", () => {
  const dir = workspace();
  const canonicalPath = writeJson(dir, "canonical.json", record());
  const copyPath = writeJson(dir, "frontend.json", record({ feeBps: 31 }));
  const before = readFileSync(copyPath, "utf8");

  const failing = spawnSync(
    process.execPath,
    [CLI, "--canonical", canonicalPath, "--copy", `frontend=${copyPath}`],
    { encoding: "utf8" },
  );
  assert.equal(failing.status, 1);
  assert.match(failing.stdout, /frontend {2}MISMATCH \$\.networks\.stellar-testnet\.feeBps/);
  assert.match(failing.stdout, /expected 30/);
  assert.match(failing.stdout, /actual {3}31/);
  assert.equal(readFileSync(copyPath, "utf8"), before, "the consumer is untouched");

  writeJson(dir, "frontend.json", record());
  const passing = spawnSync(
    process.execPath,
    [CLI, "--canonical", canonicalPath, "--copy", `frontend=${copyPath}`, "--json"],
    { encoding: "utf8" },
  );
  assert.equal(passing.status, 0);
  const report = JSON.parse(passing.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.copies[0].owner, "frontend");
  assert.equal(report.copies[0].revision, "working-tree");
});

test("a copy can be read from an explicit git revision", () => {
  const dir = workspace();
  const canonicalPath = writeJson(dir, "canonical.json", record());
  const repo = join(dir, "consumer");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  writeJson(repo, "deployment.json", record());
  execFileSync("git", ["-C", repo, "add", "deployment.json"]);
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.name=check-copies-test",
    "-c",
    "user.email=check-copies@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);

  const report = checkCopies({
    canonical: parseCopySpec(`canonical=${canonicalPath}`, "canonical"),
    copies: [parseCopySpec(`backend=${repo}@HEAD:deployment.json`)],
  });
  assert.equal(report.ok, true);
  assert.equal(report.copies[0].revision, "HEAD");
});
