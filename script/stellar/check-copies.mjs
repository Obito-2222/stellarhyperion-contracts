#!/usr/bin/env node
/**
 * Compare canonical deployment data with the copies the backend and frontend carry.
 *
 * Deployment records are read by three repositories, and the failure that matters is not a
 * missing file: it is a copy that says the router is one character different from the record, or
 * that still holds last month's flow limit. Those parse fine. They become a transfer to nobody,
 * or an app that quotes a ceiling the chain no longer has.
 *
 * So this command is deliberately small and deliberately read-only. It reads the canonical
 * manifest, reads each consumer copy at an explicit revision, walks both, and names every field
 * that disagrees together with the repository that owns it. It never writes a consumer file:
 * fixing a copy is a separate, reviewed change in that repository, and a checker that could
 * rewrite its own subjects would erase the evidence that they disagreed.
 *
 * A record marked archived is reported as archived and is never compared as if it were active.
 * An archived record presented as a consumer's active copy is an error, because that copy is
 * pinning a deployment the operator has already retired.
 *
 * Usage:
 *   node script/stellar/check-copies.mjs \
 *     --canonical deployments/testnet.json \
 *     --copy backend=../stellarhyperion-backend@<rev>:deployments/testnet.json \
 *     --copy frontend=../stellarhyperion-frontend@<rev>:src/deployment.json \
 *     --archive deployments/archive/stellar-testnet-2026-10-01.json
 *
 * Copy specs are either a local path (`backend=path/to/file.json`) or a git revision
 * (`backend=/repo/dir@REV:path/inside/repo.json`). A local path is read as the working tree and
 * reported as such, so nobody mistakes an uncommitted edit for a pinned revision.
 *
 * Exit status: 0 when every active copy agrees, 1 when any field disagrees or a record cannot be
 * read, 2 for a usage error.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const COPY_REPORT_VERSION = 1;

/** Record fields that are about the copy rather than about the deployment it describes. */
const CONSUMER_METADATA = new Set([
  "schemaVersion",
  "generatedAt",
  "commit",
  "deployedAt",
  "deployer",
  "peerChain",
  "queuedActionIds",
  "queuedActions",
  "status",
  "archived",
]);

/** Fields whose order carries no meaning on the wire. */
const UNORDERED_ARRAYS = new Set(["routes"]);

export class CopyCheckError extends Error {
  constructor(message) {
    super(message);
    this.name = "CopyCheckError";
  }
}

/**
 * Split `owner=source` into an owner and the place its copy lives.
 *
 * `source` is either a local path or `repoDir@revision:pathInRepo`. Splitting at the first `@`
 * after the directory keeps a revision that contains a slash or a dot intact, and the first colon
 * after it separates the revision from the path for the same reason.
 */
export function parseCopySpec(spec, kind = "copy") {
  const equals = spec.indexOf("=");
  if (equals <= 0 || equals === spec.length - 1) {
    throw new CopyCheckError(`${kind} must read owner=source, got "${spec}"`);
  }
  const owner = spec.slice(0, equals);
  const source = spec.slice(equals + 1);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(owner)) {
    throw new CopyCheckError(`${kind} owner "${owner}" is not a repository name`);
  }

  const at = source.indexOf("@");
  if (at > 0) {
    const repo = source.slice(0, at);
    const rest = source.slice(at + 1);
    const colon = rest.indexOf(":");
    if (colon <= 0 || colon === rest.length - 1) {
      throw new CopyCheckError(`${kind} "${spec}" must read repo@revision:path`);
    }
    return {
      owner,
      kind,
      source,
      repo,
      revision: rest.slice(0, colon),
      path: rest.slice(colon + 1),
    };
  }

  if (source.length === 0) throw new CopyCheckError(`${kind} "${spec}" names no file`);
  return { owner, kind, source, repo: null, revision: null, path: source };
}

/** Read a spec. `--copy` and `--archive` differ only in how the result is filed. */
export function readCopy(spec) {
  if (spec.revision === null) {
    const text = readFileSync(resolve(spec.path), "utf8");
    return { text, revision: "working-tree", origin: spec.path };
  }
  // `git show` is read-only by construction: it resolves an object and prints it.
  const text = execFileSync("git", ["-C", resolve(spec.repo), "show", `${spec.revision}:${spec.path}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { text, revision: spec.revision, origin: `${spec.repo}@${spec.revision}:${spec.path}` };
}

/** A record is archived because it says so, or because it lives under an archive directory. */
export function isArchived(record, origin = "") {
  if (record !== null && typeof record === "object") {
    if (record.archived === true || record.status === "archived") return true;
  }
  return /(^|\/)archive(\/|$)/.test(String(origin));
}

/** Parse JSON and refuse anything that is not a deployment-shaped object. */
export function parseRecord(text, origin) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new CopyCheckError(
      `${origin}: not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CopyCheckError(`${origin}: expected a deployment record object`);
  }
  if (value.networks === null || typeof value.networks !== "object" || Array.isArray(value.networks)) {
    throw new CopyCheckError(`${origin}: expected a record with a networks object`);
  }
  return value;
}

function show(value) {
  const text = typeof value === "string" ? `"${value}"` : JSON.stringify(value) ?? String(value);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function normalizedArray(value, key) {
  if (!UNORDERED_ARRAYS.has(key)) return value;
  return [...value].sort((left, right) => show(left).localeCompare(show(right)));
}

function compareNode(expected, actual, path, key, owner, mismatches) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      mismatches.push({ owner, path, expected: show(expected), actual: show(actual), reason: "not an array" });
      return;
    }
    const left = normalizedArray(expected, key);
    const right = normalizedArray(actual, key);
    if (left.length !== right.length) {
      mismatches.push({
        owner,
        path: `${path}.length`,
        expected: String(left.length),
        actual: String(right.length),
        reason: "array length",
      });
    }
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
      compareNode(left[index], right[index], `${path}[${String(index)}]`, key, owner, mismatches);
    }
    return;
  }

  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
      mismatches.push({ owner, path, expected: show(expected), actual: show(actual), reason: "not an object" });
      return;
    }
    for (const childKey of Object.keys(expected)) {
      if (CONSUMER_METADATA.has(childKey)) continue;
      const childPath = `${path}.${childKey}`;
      if (!(childKey in actual)) {
        mismatches.push({
          owner,
          path: childPath,
          expected: show(expected[childKey]),
          actual: "<missing>",
          reason: "missing field",
        });
        continue;
      }
      compareNode(expected[childKey], actual[childKey], childPath, childKey, owner, mismatches);
    }
    return;
  }

  if (!Object.is(expected, actual)) {
    mismatches.push({ owner, path, expected: show(expected), actual: show(actual), reason: "value" });
  }
}

/**
 * Walk the active networks of the canonical record against a consumer copy.
 *
 * Only fields the canonical record carries are compared. A consumer that also stores local
 * preferences is not a mismatch; a consumer that disagrees about the router, a fee, a token
 * address or a flow limit is. Archived networks on either side are skipped here and reported
 * separately, so a retired deployment cannot masquerade as today's.
 */
export function compareDeploymentSets(canonical, copy, owner) {
  const mismatches = [];
  for (const [networkKey, expected] of Object.entries(canonical.networks)) {
    if (isArchived(expected, networkKey)) continue;
    const networkPath = `$.networks.${networkKey}`;
    if (!(networkKey in copy.networks)) {
      mismatches.push({
        owner,
        path: networkPath,
        expected: "network present",
        actual: "<missing>",
        reason: "missing network",
      });
      continue;
    }
    compareNode(expected, copy.networks[networkKey], networkPath, "", owner, mismatches);
  }
  return mismatches;
}

/** A parsed input, ready for the report. */
function load(spec) {
  const read = readCopy(spec);
  const record = parseRecord(read.text, read.origin);
  return { spec, record, revision: read.revision, origin: read.origin, archived: isArchived(record, spec.path) };
}

/**
 * Run the whole check. Pure apart from reading the files and git objects named by the specs.
 *
 * `copies` and `archives` are already parsed by `parseCopySpec`; this function's job is the
 * verdict, and it never touches a consumer file.
 */
export function checkCopies({ canonical, copies = [], archives = [] }) {
  const active = load(canonical);
  if (active.archived) {
    throw new CopyCheckError(
      `canonical record ${active.origin} is marked archived; point --canonical at the active manifest`,
    );
  }

  const mismatches = [];
  const accepted = [];
  const archived = [];

  for (const spec of copies) {
    const copy = load(spec);
    if (copy.archived) {
      archived.push({
        owner: spec.owner,
        origin: copy.origin,
        revision: copy.revision,
        networks: Object.keys(copy.record.networks),
        note: "archived record supplied as a consumer copy; not compared",
      });
      mismatches.push({
        owner: spec.owner,
        path: "$",
        expected: "active deployment copy",
        actual: "archived record",
        reason: "archived copy presented as active",
      });
      continue;
    }
    const copyMismatches = compareDeploymentSets(active.record, copy.record, spec.owner);
    mismatches.push(...copyMismatches);
    accepted.push({
      owner: spec.owner,
      origin: copy.origin,
      revision: copy.revision,
      networks: Object.keys(copy.record.networks),
      mismatches: copyMismatches.length,
    });
  }

  for (const spec of archives) {
    const record = load(spec);
    if (!record.archived) {
      throw new CopyCheckError(
        `${record.origin}: passed with --archive but is not marked archived; add "archived": true or move it under deployments/archive/`,
      );
    }
    const overlaps = Object.keys(record.record.networks).filter((key) =>
      Object.prototype.hasOwnProperty.call(active.record.networks, key),
    );
    archived.push({
      owner: spec.owner,
      origin: record.origin,
      revision: record.revision,
      networks: Object.keys(record.record.networks),
      note:
        overlaps.length === 0
          ? "retired record; never compared with the active manifest"
          : `retired record also names active network(s) ${overlaps.join(", ")}; never compared`,
    });
  }

  const activeNetworks = Object.entries(active.record.networks)
    .filter(([key, entry]) => !isArchived(entry, key))
    .map(([key]) => key);

  return {
    version: COPY_REPORT_VERSION,
    canonical: {
      origin: active.origin,
      revision: active.revision,
      networks: activeNetworks,
    },
    ok: mismatches.length === 0,
    copies: accepted,
    archived,
    mismatches,
  };
}

/** Render the report the way a person reads a failing check. */
export function formatReport(report) {
  const lines = [];
  lines.push(`canonical   ${report.canonical.origin} (${report.canonical.networks.join(", ")})`);
  for (const copy of report.copies) {
    lines.push(
      `copy        ${copy.owner} ${copy.origin} at ${copy.revision}: ${copy.mismatches} mismatch(es)`,
    );
  }
  for (const record of report.archived) {
    lines.push(`archived    ${record.owner} ${record.origin} at ${record.revision}: ${record.note}`);
  }
  if (report.mismatches.length === 0) {
    lines.push("ok          every active copy agrees with the canonical manifest");
    return lines.join("\n");
  }
  lines.push("");
  for (const mismatch of report.mismatches) {
    lines.push(`${mismatch.owner}  MISMATCH ${mismatch.path} (${mismatch.reason})`);
    lines.push(`  expected ${mismatch.expected}`);
    lines.push(`  actual   ${mismatch.actual}`);
  }
  lines.push("");
  lines.push(`${report.mismatches.length} field(s) disagree. Fix them in the owning repository;`);
  lines.push("this command never rewrites a consumer copy.");
  return lines.join("\n");
}

/** Parse argv into the shape `checkCopies` takes. */
export function parseArgs(argv) {
  const options = { json: false, canonical: null, copies: [], archives: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--canonical") {
      const value = argv[++index];
      if (value === undefined) throw new CopyCheckError("--canonical needs a file");
      options.canonical = parseCopySpec(`canonical=${value}`, "canonical");
    } else if (arg === "--copy") {
      const value = argv[++index];
      if (value === undefined) throw new CopyCheckError("--copy needs owner=source");
      options.copies.push(parseCopySpec(value, "copy"));
    } else if (arg === "--archive") {
      const value = argv[++index];
      if (value === undefined) throw new CopyCheckError("--archive needs owner=source");
      options.archives.push(parseCopySpec(value, "archive"));
    } else {
      throw new CopyCheckError(`unknown argument "${arg}"`);
    }
  }
  if (options.canonical === null) throw new CopyCheckError("--canonical is required");
  return options;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }

  try {
    const report = checkCopies(options);
    process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report)}\n`);
    process.exit(report.ok ? 0 : 1);
  } catch (error) {
    process.stderr.write(`check-copies: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
