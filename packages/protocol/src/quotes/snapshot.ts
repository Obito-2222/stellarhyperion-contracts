import type { RouteKind } from "../routes.js";
import { ROUTE_KINDS } from "../routes.js";
import {
  QuoteBlocker,
  type QuoteRequest,
  type RouteQuote,
  type RouterSnapshot,
} from "../quotes.js";
import { MAX_DECIMALS, MAX_FEE_BPS } from "../amounts.js";
import { chain, isChainKey } from "../chains.js";
import { tryParseStellarAddress, AddressKind } from "../addresses.js";
import type { AssetIdentity } from "../registry/assets.js";
import {
  object,
  boolean,
  boundedNumber,
  decimal,
  flags,
  validatePlanningSnapshot,
} from "./validation.js";
import { assertInputBudget, resolveInputBudgets, type InputBudgetOverrides } from "../limits.js";

export const QUOTE_SNAPSHOT_VERSION = 1 as const;
export type QuoteSnapshotSource = "router-snapshot";

/** A quote snapshot is historical data, never a promise that a price is fresh. */
export interface QuoteSnapshot {
  readonly capturedAt: bigint;
  readonly amountUnit: string;
  readonly destinationUnit: string;
  readonly request: Omit<QuoteRequest, "route">;
  readonly router: RouterSnapshot;
  readonly quotes: readonly RouteQuote[];
}

export interface SerializedQuoteSnapshot {
  readonly schemaVersion: number;
  readonly source: QuoteSnapshotSource;
  readonly capturedAt: string;
  readonly amountUnit: string;
  readonly destinationUnit: string;
  readonly request: {
    readonly amount: string;
    readonly strkey: string;
    readonly destinationDecimals: number;
  };
  readonly router: Omit<RouterSnapshot, "flowAvailable"> & {
    readonly flowAvailable: Record<string, string>;
  };
  readonly quotes: readonly {
    readonly route: number;
    readonly available: boolean;
    readonly reason: number;
    readonly grossAmount: string;
    readonly fee: string;
    readonly netAmount: string;
    readonly destinationAmount: string;
    readonly flowAvailable: string;
    readonly waitsOnAttestation: boolean;
    readonly isCanonical: boolean;
  }[];
}

const route = (value: unknown, field: string): RouteKind => {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    !ROUTE_KINDS.includes(value as RouteKind)
  ) {
    throw new TypeError(`${field} is not a supported route`);
  }
  return value as RouteKind;
};

/** Serialize a quote snapshot without allowing JSON numbers to narrow bigint values. */
function encodeSnapshot(snapshot: QuoteSnapshot): string {
  validatePlanningSnapshot(snapshot.router);
  for (const [path, value] of [
    ["capturedAt", snapshot.capturedAt],
    ["request.amount", snapshot.request.amount],
  ] as const) {
    if (typeof value !== "bigint") throw new TypeError(`${path} must be a bigint`);
  }
  for (const [index, quote] of snapshot.quotes.entries()) {
    for (const field of [
      "grossAmount",
      "fee",
      "netAmount",
      "destinationAmount",
      "flowAvailable",
    ] as const) {
      if (typeof quote[field] !== "bigint")
        throw new TypeError(`quotes.${String(index)}.${field} must be a bigint`);
    }
  }
  return JSON.stringify({
    schemaVersion: QUOTE_SNAPSHOT_VERSION,
    source: "router-snapshot" satisfies QuoteSnapshotSource,
    capturedAt: snapshot.capturedAt.toString(),
    amountUnit: snapshot.amountUnit,
    destinationUnit: snapshot.destinationUnit,
    request: { ...snapshot.request, amount: snapshot.request.amount.toString() },
    router: {
      ...snapshot.router,
      flowAvailable: Object.fromEntries(
        Object.entries(snapshot.router.flowAvailable).map(([key, value]) => [
          key,
          value.toString(),
        ]),
      ),
    },
    quotes: snapshot.quotes.map((quote) => ({
      ...quote,
      grossAmount: quote.grossAmount.toString(),
      fee: quote.fee.toString(),
      netAmount: quote.netAmount.toString(),
      destinationAmount: quote.destinationAmount.toString(),
      flowAvailable: quote.flowAvailable.toString(),
    })),
  });
}

/** Both directions validate the same persisted schema; units and capture time describe history. */
export function serializeQuoteSnapshot(snapshot: QuoteSnapshot): string {
  return encodeSnapshot(parseQuoteSnapshot(encodeSnapshot(snapshot)));
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) {
    throw new TypeError(`${path} must be a non-empty string of at most 256 characters`);
  }
  return value;
}

function tokenIdentity(input: unknown): AssetIdentity {
  const value = object(input, "router.tokenIdentity");
  if (
    typeof value.chain !== "string" ||
    !isChainKey(value.chain) ||
    (value.representation !== "native" && value.representation !== "its")
  ) {
    throw new TypeError("router.tokenIdentity chain or representation is invalid");
  }
  const base: Pick<AssetIdentity, "chain" | "representation"> = {
    chain: value.chain,
    representation: value.representation,
  };
  if (
    value.family === "evm" &&
    chain(value.chain).family === "evm" &&
    typeof value.address === "string" &&
    /^0x[0-9a-fA-F]{40}$/.test(value.address) &&
    !/^0x0{40}$/.test(value.address)
  ) {
    return { ...base, family: "evm", address: value.address as `0x${string}` };
  }
  if (
    value.family === "stellar" &&
    chain(value.chain).family === "stellar" &&
    typeof value.code === "string" &&
    /^(?:[a-zA-Z0-9]{1,4}|[a-zA-Z0-9]{5,12})$/.test(value.code) &&
    typeof value.issuer === "string"
  ) {
    const issuer = tryParseStellarAddress(value.issuer);
    if (issuer.ok && issuer.parts.kind === AddressKind.Account)
      return { ...base, family: "stellar", code: value.code, issuer: value.issuer };
  }
  throw new TypeError("router.tokenIdentity is invalid");
}

/** Parse unknown historical data before allowing its fields into typed local planning. */
export function parseQuoteSnapshot(
  serialized: string,
  budgets?: InputBudgetOverrides,
): QuoteSnapshot {
  if (typeof serialized !== "string") throw new TypeError("quote snapshot must be a string");
  assertInputBudget(
    serialized.length,
    "maxQuoteSnapshotChars",
    "quote snapshot",
    resolveInputBudgets(budgets),
  );
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch {
    throw new TypeError("quote snapshot is not valid JSON");
  }
  const value = object(raw, "quote snapshot");
  if (value.schemaVersion !== QUOTE_SNAPSHOT_VERSION)
    throw new RangeError("unsupported quote snapshot version");
  if (value.source !== "router-snapshot") throw new TypeError("quote snapshot source is invalid");
  const request = object(value.request, "request");
  const router = object(value.router, "router");
  const flowAvailable: Partial<Record<RouteKind, bigint>> = {};
  for (const [key, amount] of Object.entries(
    object(router.flowAvailable, "router.flowAvailable"),
  )) {
    const kind = route(Number(key), `router.flowAvailable.${key}`);
    if (String(kind) !== key) throw new TypeError(`router.flowAvailable.${key} is not canonical`);
    flowAvailable[kind] = decimal(amount, `router.flowAvailable.${key}`);
  }
  if (!Array.isArray(value.quotes) || value.quotes.length > ROUTE_KINDS.length)
    throw new TypeError("quotes must contain at most one quote per route");
  const seen = new Set<RouteKind>();
  const quotes = value.quotes.map((raw, index): RouteQuote => {
    const path = `quotes.${String(index)}`;
    const item = object(raw, path);
    const kind = route(item.route, `${path}.route`);
    if (seen.has(kind)) throw new TypeError(`${path}.route is duplicated`);
    seen.add(kind);
    const reason = boundedNumber(
      item.reason,
      QuoteBlocker.ChainNotSupported,
      `${path}.reason`,
    ) as RouteQuote["reason"];
    const available = boolean(item.available, `${path}.available`);
    if (available !== (reason === QuoteBlocker.None))
      throw new TypeError(`${path}.reason contradicts availability`);
    return {
      route: kind,
      available,
      reason,
      grossAmount: decimal(item.grossAmount, `${path}.grossAmount`),
      fee: decimal(item.fee, `${path}.fee`),
      netAmount: decimal(item.netAmount, `${path}.netAmount`),
      destinationAmount: decimal(item.destinationAmount, `${path}.destinationAmount`),
      flowAvailable: decimal(item.flowAvailable, `${path}.flowAvailable`),
      waitsOnAttestation: boolean(item.waitsOnAttestation, `${path}.waitsOnAttestation`),
      isCanonical: boolean(item.isCanonical, `${path}.isCanonical`),
    };
  });
  return {
    capturedAt: decimal(value.capturedAt, "capturedAt", (1n << 64n) - 1n),
    amountUnit: text(value.amountUnit, "amountUnit"),
    destinationUnit: text(value.destinationUnit, "destinationUnit"),
    request: {
      amount: decimal(request.amount, "request.amount"),
      strkey: text(request.strkey, "request.strkey"),
      destinationDecimals: boundedNumber(
        request.destinationDecimals,
        MAX_DECIMALS,
        "request.destinationDecimals",
      ),
    },
    router: {
      paused: boolean(router.paused, "router.paused"),
      feeBps: boundedNumber(router.feeBps, MAX_FEE_BPS, "router.feeBps"),
      tokenDecimals: boundedNumber(router.tokenDecimals, MAX_DECIMALS, "router.tokenDecimals"),
      tokenRegistered: boolean(router.tokenRegistered, "router.tokenRegistered"),
      tokenEnabled: boolean(router.tokenEnabled, "router.tokenEnabled"),
      routeEnabled: flags(router.routeEnabled, "router.routeEnabled"),
      adapterSet: flags(router.adapterSet, "router.adapterSet"),
      chainSupported: flags(router.chainSupported, "router.chainSupported"),
      flowAvailable,
      ...(router.tokenIdentity === undefined
        ? {}
        : { tokenIdentity: tokenIdentity(router.tokenIdentity) }),
    },
    quotes,
  };
}
