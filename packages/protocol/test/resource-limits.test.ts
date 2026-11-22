import { describe, expect, it } from "vitest";
import {
  INPUT_BUDGETS,
  InputBudgetError,
  resolveInputBudgets,
  type InputBudgetOverrides,
} from "../src/limits.js";
import {
  OUTBOUND_NOTE_LEN,
  decodeCctpHook,
  decodeInboundNote,
  decodeOutboundNote,
  encodeCctpHook,
  encodeInboundNote,
  encodeOutboundNote,
  toEvmAddress,
  toWord,
} from "../src/notes.js";
import {
  BURN_HOOK_DATA,
  MSG_BODY,
  cctpBody,
  parseCctpBurnMessage,
  parseCctpMessage,
} from "../src/cctp.js";
import {
  compareSnapshots,
  parseQuoteSnapshot,
  planQuotes,
  quoteBatch,
  quoteBatchWithSharedFlow,
  quoteMinimumBatch,
  serializeQuoteSnapshot,
  type DatedSnapshot,
  type QuoteSnapshot,
  type RouterSnapshot,
} from "../src/quotes.js";
import { DEPLOYMENT_SCHEMA_VERSION, parseDeploymentSet } from "../src/deployments.js";
import { ProviderAddressError, parseProviderAddressOverrides } from "../src/registry/assets.js";
import { ROUTE_KINDS, RouteKind } from "../src/routes.js";
import { EVM_RECIPIENT, G_ADDR, M_ADDR } from "./fixtures.js";

const all = <T>(value: T): Record<RouteKind, T> => ({ 0: value, 1: value, 2: value, 3: value });
const state = (overrides: Partial<RouterSnapshot> = {}): RouterSnapshot => ({
  paused: false,
  feeBps: 30,
  tokenRegistered: true,
  tokenEnabled: true,
  tokenDecimals: 6,
  routeEnabled: all(true),
  adapterSet: all(true),
  chainSupported: all(true),
  flowAvailable: all(10n ** 18n),
  ...overrides,
});
const request = { strkey: G_ADDR, destinationDecimals: 7, amount: 1_000_000n };

function budgetError(run: () => unknown): InputBudgetError {
  try {
    run();
  } catch (error) {
    if (error instanceof InputBudgetError) return error;
    throw error;
  }
  throw new Error("expected an InputBudgetError");
}

describe("input budget table", () => {
  it("publishes frozen defaults that a caller cannot mutate", () => {
    expect(Object.isFrozen(INPUT_BUDGETS)).toBe(true);
    expect(resolveInputBudgets()).toBe(INPUT_BUDGETS);
    expect(INPUT_BUDGETS.maxMessageBytes).toBeGreaterThan(OUTBOUND_NOTE_LEN);
  });

  it("refuses unknown names and meaningless ceilings instead of ignoring them", () => {
    expect(() => resolveInputBudgets({ nope: 10 } as unknown as InputBudgetOverrides)).toThrow(
      /not an input budget/,
    );
    expect(() => resolveInputBudgets({ maxQuoteTiers: 0 })).toThrow(/positive safe integer/);
    expect(() => resolveInputBudgets({ maxMessageBytes: 1.5 })).toThrow(/positive safe integer/);
    // Overrides are merged, not applied to the shared default table.
    expect(resolveInputBudgets({ maxQuoteTiers: 1 }).maxQuoteTiers).toBe(1);
    expect(INPUT_BUDGETS.maxQuoteTiers).toBe(256);
  });
});

describe("message parsers fail on size before decoding", () => {
  const oversized = `0x${"ab".repeat(INPUT_BUDGETS.maxMessageBytes + 1)}`;

  it.each([
    ["outbound note", () => decodeOutboundNote(oversized as `0x${string}`)],
    ["inbound note", () => decodeInboundNote(oversized as `0x${string}`)],
    ["cctp hook", () => decodeCctpHook(oversized as `0x${string}`)],
    ["word", () => toEvmAddress(oversized as `0x${string}`)],
    ["cctp header", () => parseCctpMessage(oversized as `0x${string}`)],
    ["cctp body", () => cctpBody(oversized as `0x${string}`)],
    ["burn message", () => parseCctpBurnMessage(oversized as `0x${string}`)],
  ])("refuses an oversized %s with a budget error", (_name, run) => {
    const error = budgetError(run);
    expect(error.budget).toBe("maxMessageBytes");
    expect(error.limit).toBe(INPUT_BUDGETS.maxMessageBytes);
    expect(error.actual).toBeGreaterThan(error.limit);
  });

  it("measures size before looking at content, so junk is not parsed first", () => {
    const error = budgetError(() => decodeOutboundNote("z".repeat(1_000_000) as `0x${string}`));
    expect(error.path).toBe("note");
    // Not MalformedMessage: the length decided the outcome, not the hex.
    expect(error.message).toMatch(/maxMessageBytes/);
  });

  it("rejects an oversized byte array without copying it", () => {
    const bytes = new Uint8Array(INPUT_BUDGETS.maxMessageBytes + 1);
    expect(() => decodeInboundNote(bytes)).toThrow(InputBudgetError);
  });

  it("admits exactly the ceiling and refuses one byte past it", () => {
    // A note of exactly the budget still reaches the wire-format check, which is the proof the
    // budget comparison is inclusive rather than a second, independently wrong limit.
    const atLimit = new Uint8Array(INPUT_BUDGETS.maxMessageBytes);
    expect(() => decodeCctpHook(atLimit)).toThrow(/MalformedMessage/);

    const note = encodeOutboundNote(EVM_RECIPIENT, 7n);
    expect(decodeOutboundNote(note, { maxMessageBytes: OUTBOUND_NOTE_LEN }).nonce).toBe(7n);
    const error = budgetError(() =>
      decodeOutboundNote(note, { maxMessageBytes: OUTBOUND_NOTE_LEN - 1 }),
    );
    expect(error.actual).toBe(OUTBOUND_NOTE_LEN);
  });
});

describe("accepted messages decode exactly as before", () => {
  const nonce = 0x0102030405060708n;

  it("decodes the outbound note the encoder wrote", () => {
    const decoded = decodeOutboundNote(encodeOutboundNote(EVM_RECIPIENT, nonce));
    expect(decoded).toEqual({ recipient: EVM_RECIPIENT.toLowerCase(), nonce });
    expect(
      decodeOutboundNote(encodeOutboundNote(EVM_RECIPIENT, nonce), { maxMessageBytes: 4096 }),
    ).toEqual(decoded);
  });

  it("decodes the inbound note and the muxed hook the encoders wrote", () => {
    const inbound = decodeInboundNote(encodeInboundNote(G_ADDR, nonce));
    expect(inbound.strkey).toBe(G_ADDR);
    expect(inbound.nonce).toBe(nonce);

    const hook = decodeCctpHook(encodeCctpHook(M_ADDR));
    expect(hook.muxedId).toBe(9_007_199_254_740_993n);
  });

  it("keeps the sixty four bit nonce boundary exact", () => {
    const maximum = 0xffffffffffffffffn;
    expect(decodeOutboundNote(encodeOutboundNote(EVM_RECIPIENT, maximum)).nonce).toBe(maximum);
    expect(() => encodeOutboundNote(EVM_RECIPIENT, maximum + 1n)).toThrow(/MalformedMessage/);
  });

  it("round trips a word back to the address it widened", () => {
    expect(toEvmAddress(toWord(EVM_RECIPIENT))).toBe(EVM_RECIPIENT.toLowerCase());
  });

  it("parses a CCTP header and burn body that fit the budget", () => {
    const header = new Uint8Array(MSG_BODY);
    expect(parseCctpMessage(header).version).toBe(0);
    expect(cctpBody(header)).toHaveLength(0);

    const body = new Uint8Array(BURN_HOOK_DATA);
    expect(parseCctpBurnMessage(body).amount).toBe(0n);
  });
});

describe("batch planners bound the input they price", () => {
  const params = { strkey: G_ADDR, destinationDecimals: 7, snapshot: state() };
  const tiers = (count: number): bigint[] => Array.from({ length: count }, () => 1_000_000n);

  it("prices a ladder at the ceiling and refuses one tier past it", () => {
    expect(quoteBatch(tiers(INPUT_BUDGETS.maxQuoteTiers), params)).toHaveLength(
      INPUT_BUDGETS.maxQuoteTiers,
    );
    const error = budgetError(() => quoteBatch(tiers(INPUT_BUDGETS.maxQuoteTiers + 1), params));
    expect(error.budget).toBe("maxQuoteTiers");
    expect(error.path).toBe("tiers");
  });

  it("honours a per-call ladder budget", () => {
    expect(quoteBatch(tiers(1), params, { maxQuoteTiers: 1 })).toHaveLength(1);
    expect(() => quoteBatch(tiers(2), params, { maxQuoteTiers: 1 })).toThrow(InputBudgetError);
  });

  it("bounds the inverse and shared-flow ladders too", () => {
    const inverse = {
      route: RouteKind.Cctp,
      strkey: G_ADDR,
      destinationDecimals: 7,
      forwardingBudget: { destinationAmount: 0n, unit: "destination-token-base-units" as const },
      snapshot: state(),
    };
    expect(quoteMinimumBatch(tiers(2), inverse, { maxQuoteTiers: 2 })).toHaveLength(2);
    expect(() => quoteMinimumBatch(tiers(3), inverse, { maxQuoteTiers: 2 })).toThrow(
      InputBudgetError,
    );
    expect(() => quoteBatchWithSharedFlow(tiers(3), params, { maxQuoteTiers: 2 })).toThrow(
      InputBudgetError,
    );
  });

  it("bounds the snapshot list a comparison will consider", () => {
    const representation = {
      tokenDecimals: 6,
      destinationNetwork: "stellar-testnet",
      destinationTokenId: G_ADDR,
      destinationDecimals: 7,
    };
    const reference = {
      network: "sepolia",
      tokenId: EVM_RECIPIENT,
      now: 1000,
      representation,
    };
    const items: DatedSnapshot[] = [1, 2, 3].map((index) => ({
      id: `s${String(index)}`,
      takenAt: 990,
      network: "sepolia",
      tokenId: EVM_RECIPIENT,
      representation,
      snapshot: state(),
    }));

    expect(
      compareSnapshots({ ...request, amount: 0n, strkey: G_ADDR }, items, reference, 10, {
        maxSnapshots: 3,
      }),
    ).toHaveLength(3);
    const error = budgetError(() =>
      compareSnapshots({ ...request, amount: 0n, strkey: G_ADDR }, items, reference, 10, {
        maxSnapshots: 2,
      }),
    );
    expect(error.budget).toBe("maxSnapshots");
    expect(error.actual).toBe(3);
  });
});

describe("persisted quote snapshots", () => {
  const snapshot: QuoteSnapshot = {
    capturedAt: 1_000n,
    amountUnit: "source-base-units",
    destinationUnit: "destination-base-units",
    request: { amount: 1_000_000n, strkey: G_ADDR, destinationDecimals: 7 },
    router: state(),
    quotes: planQuotes(request, state()),
  };

  it("still reads a snapshot this package wrote", () => {
    const serialized = serializeQuoteSnapshot(snapshot);
    const parsed = parseQuoteSnapshot(serialized);
    expect(parsed.request.amount).toBe(1_000_000n);
    expect(parsed.quotes).toHaveLength(ROUTE_KINDS.length);
    expect(parseQuoteSnapshot(serialized, { maxQuoteSnapshotChars: serialized.length })).toEqual(
      parsed,
    );
  });

  it("refuses an oversized document before handing it to JSON.parse", () => {
    const oversized = "{".padEnd(INPUT_BUDGETS.maxQuoteSnapshotChars + 1, " ");
    const error = budgetError(() => parseQuoteSnapshot(oversized));
    expect(error.budget).toBe("maxQuoteSnapshotChars");
    // A JSON parser would have reported a syntax error; the budget decided first.
    expect(error.message).not.toMatch(/JSON/);
  });
});

describe("deployment and provider documents", () => {
  function evmRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      family: "evm",
      chainId: 8453,
      router: "0x1111111111111111111111111111111111111111",
      adapters: { cctp: "0x2222222222222222222222222222222222222222" },
      tokens: {
        USDC: {
          address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          decimals: 6,
          flowLimit: "1000000000000",
          routes: ["cctp"],
        },
      },
      treasury: "0x3333333333333333333333333333333333333333",
      admin: "0x4444444444444444444444444444444444444444",
      guardian: "0x5555555555555555555555555555555555555555",
      feeBps: 30,
      flowWindow: 3600,
      timelockDelay: 172_800,
      deployedAt: {
        blockNumber: "21000000",
        timestamp: "2026-09-30T12:00:00.000Z",
        txHash: `0x${"ab".repeat(32)}`,
      },
      commit: "0123456789abcdef0123456789abcdef01234567",
      ...overrides,
    };
  }

  function set(networks: Record<string, unknown>): Record<string, unknown> {
    return {
      schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
      generatedAt: "2026-09-30T12:00:00.000Z",
      networks,
    };
  }

  it("reads a valid record and accepts a record count at the ceiling", () => {
    const parsed = parseDeploymentSet(set({ base: evmRecord() }), { maxDeploymentNetworks: 1 });
    expect(parsed.networks.base?.chain).toBe("base");
  });

  it("refuses too many networks, tokens or rail slugs", () => {
    const networks = budgetError(() =>
      parseDeploymentSet(set({ base: evmRecord(), sepolia: evmRecord() }), {
        maxDeploymentNetworks: 1,
      }),
    );
    expect(networks.budget).toBe("maxDeploymentNetworks");

    const tokens = budgetError(() =>
      parseDeploymentSet(
        set({
          base: evmRecord({
            tokens: {
              USDC: evmRecord().tokens,
              USDT: evmRecord().tokens,
            },
          }),
        }),
        { maxDeploymentTokens: 1 },
      ),
    );
    expect(tokens.budget).toBe("maxDeploymentTokens");

    const routes = budgetError(() =>
      parseDeploymentSet(
        set({
          base: evmRecord({
            tokens: {
              USDC: {
                address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                decimals: 6,
                flowLimit: "1000000000000",
                routes: ["cctp", "cctp"],
              },
            },
          }),
        }),
        { maxDeploymentRoutes: 1 },
      ),
    );
    expect(routes.budget).toBe("maxDeploymentRoutes");
  });

  it("reads a valid provider override document and bounds its breadth", () => {
    const overrides = { sepolia: { USDC: { cctp: EVM_RECIPIENT } } };
    expect(
      parseProviderAddressOverrides(overrides, { maxProviderChains: 1, maxProviderSymbols: 1 }),
    ).toEqual({ sepolia: { USDC: { [RouteKind.Cctp]: EVM_RECIPIENT } } });

    const chains = budgetError(() =>
      parseProviderAddressOverrides({ sepolia: {}, base: {} }, { maxProviderChains: 1 }),
    );
    expect(chains.budget).toBe("maxProviderChains");

    const symbols = budgetError(() =>
      parseProviderAddressOverrides(
        { sepolia: { USDC: {}, SECOND: {} } },
        { maxProviderSymbols: 1 },
      ),
    );
    expect(symbols.budget).toBe("maxProviderSymbols");
  });

  it("still reports a malformed document as a format error rather than a budget error", () => {
    expect(() => parseProviderAddressOverrides({ nowhere: {} })).toThrow(ProviderAddressError);
    expect(() => parseDeploymentSet(set({ base: evmRecord({ feeBps: -1 }) }))).toThrow(
      /deployment record invalid/,
    );
  });
});
