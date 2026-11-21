import { describe, expect, it } from "vitest";
import { DEFAULT_CODEC_LIMITS, CodecLimitError, resolveCodecLimits } from "../src/limits.js";
import { fromHex, toHex } from "../src/bytes.js";
import { decodeOutboundNote, encodeOutboundNote } from "../src/notes.js";
import {
  QuoteBlocker,
  planQuote,
  planQuotes,
  quoteBatch,
  MAX_QUOTE_AMOUNT,
} from "../src/quotes.js";
import type { QuoteParams, RouterSnapshot } from "../src/quotes.js";
import {
  DEPLOYMENT_SCHEMA_VERSION,
  DeploymentFormatError,
  parseDeploymentSet,
  parseDeploymentSetJson,
  tokenFor,
} from "../src/deployments.js";
import { assetOn, routesForPair } from "../src/registry/assets.js";
import { ROUTE_KINDS, RouteKind } from "../src/routes.js";
import { G_ADDR } from "./fixtures.js";

/** Everything open, thirty basis points, six decimals in and seven out. */
function snapshot(overrides: Partial<RouterSnapshot> = {}): RouterSnapshot {
  const all = <T>(value: T): Record<RouteKind, T> => ({
    [RouteKind.Cctp]: value,
    [RouteKind.AxelarIts]: value,
    [RouteKind.AxelarGmp]: value,
    [RouteKind.Allbridge]: value,
  });
  return {
    paused: false,
    feeBps: 30,
    routeEnabled: all(true),
    adapterSet: all(true),
    tokenRegistered: true,
    tokenEnabled: true,
    tokenDecimals: 6,
    flowAvailable: all(1_000_000_000n),
    chainSupported: all(true),
    ...overrides,
  };
}

const request = { amount: 1_000_000n, strkey: G_ADDR, destinationDecimals: 7 } as const;

function deploymentRecord() {
  return {
    schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
    generatedAt: "2026-09-30T12:00:00.000Z",
    networks: {
      base: {
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
      },
    },
  };
}

describe("the budgets themselves", () => {
  it("are frozen and generous for real traffic", () => {
    expect(Object.isFrozen(DEFAULT_CODEC_LIMITS)).toBe(true);
    expect(DEFAULT_CODEC_LIMITS.maxQuoteTiers).toBeGreaterThan(ROUTE_KINDS.length);
    expect(DEFAULT_CODEC_LIMITS.maxHexBytes).toBeGreaterThan(1024);
  });

  it("merge overrides without changing the defaults", () => {
    const raised = resolveCodecLimits({ maxQuoteTiers: 100 });
    expect(raised.maxQuoteTiers).toBe(100);
    expect(raised.maxHexBytes).toBe(DEFAULT_CODEC_LIMITS.maxHexBytes);
    expect(DEFAULT_CODEC_LIMITS.maxQuoteTiers).toBe(64);
  });

  it("refuse an override that would remove the protection", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveCodecLimits({ maxQuoteTiers: bad })).toThrow(RangeError);
    }
  });
});

describe("byte codecs", () => {
  it("still round trip a valid note unchanged", () => {
    const encoded = encodeOutboundNote(
      "0x3b9c2115c0efd344ba0a8901eb1cfe44f36cf7db",
      9_007_199_254_740_993n,
    );
    const decoded = decodeOutboundNote(encoded);
    expect(decoded.recipient).toBe("0x3b9c2115c0efd344ba0a8901eb1cfe44f36cf7db");
    expect(decoded.nonce).toBe(9_007_199_254_740_993n);
    expect(toHex(fromHex(toHex(encoded)))).toBe(toHex(encoded));
  });

  it("refuse an oversized hex input before allocating the output", () => {
    const huge = "ab".repeat(DEFAULT_CODEC_LIMITS.maxHexBytes + 1);
    expect(() => fromHex(huge)).toThrow(CodecLimitError);
    try {
      fromHex(huge);
    } catch (error) {
      expect(error).toBeInstanceOf(CodecLimitError);
      expect((error as CodecLimitError).limit).toBe("maxHexBytes");
      expect((error as CodecLimitError).actual).toBe(DEFAULT_CODEC_LIMITS.maxHexBytes + 1);
    }
  });

  it("allow a provider extension to state its own byte budget", () => {
    const body = "0x" + "cd".repeat(4096);
    expect(fromHex(body).length).toBe(4096);
    expect(() => fromHex(body, { maxBytes: 1024 })).toThrow(CodecLimitError);
  });
});

describe("quote ladders", () => {
  const params: QuoteParams = {
    strkey: G_ADDR,
    destinationDecimals: 7,
    snapshot: snapshot(),
  };

  it("refuse an oversized tier array before pricing any tier", () => {
    const tiers = Array.from(
      { length: DEFAULT_CODEC_LIMITS.maxQuoteTiers + 1 },
      (_, index) => BigInt(index + 1) * 1_000_000n,
    );
    try {
      quoteBatch(tiers, params);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CodecLimitError);
      expect((error as CodecLimitError).limit).toBe("maxQuoteTiers");
      expect((error as CodecLimitError).path).toBe("tiers");
    }
  });

  it("accept a ladder at the documented ceiling", () => {
    const tiers = Array.from({ length: DEFAULT_CODEC_LIMITS.maxQuoteTiers }, () => 1_000_000n);
    expect(quoteBatch(tiers, params).length).toBe(DEFAULT_CODEC_LIMITS.maxQuoteTiers);
  });

  it("honor a caller's larger tier budget", () => {
    const tiers = Array.from({ length: 80 }, () => 1_000_000n);
    expect(quoteBatch(tiers, { ...params, limits: { maxQuoteTiers: 80 } }).length).toBe(80);
  });

  it("refuse an oversized destination string before parsing it", () => {
    const strkey = "G".repeat(DEFAULT_CODEC_LIMITS.maxStrkeyChars + 1);
    expect(() => quoteBatch([1_000_000n], { ...params, strkey })).toThrow(CodecLimitError);
  });

  it("planQuote answers an oversized destination with a reason instead of throwing", () => {
    const quote = planQuote(
      {
        ...request,
        route: RouteKind.Cctp,
        strkey: "G".repeat(DEFAULT_CODEC_LIMITS.maxStrkeyChars + 1),
      },
      snapshot(),
      { maxStrkeyChars: 50 },
    );
    expect(quote.available).toBe(false);
    expect(quote.reason).toBe(QuoteBlocker.InvalidDestination);
  });

  it("planQuotes measures the destination once and stays in enum order", () => {
    const quotes = planQuotes({ ...request, strkey: "C".repeat(10_000) }, snapshot(), {
      maxStrkeyChars: 64,
    });
    expect(quotes.map((quote) => quote.route)).toEqual([...ROUTE_KINDS]);
    expect(quotes.every((quote) => quote.reason === QuoteBlocker.InvalidDestination)).toBe(true);
  });

  it("keeps the amount ceiling independent of the input budgets", () => {
    const quote = planQuote(
      { ...request, route: RouteKind.Cctp, amount: MAX_QUOTE_AMOUNT + 1n },
      snapshot(),
    );
    expect(quote.reason).toBe(QuoteBlocker.NotRepresentable);
  });
});

describe("deployment records", () => {
  it("still parse the same valid record", () => {
    const parsed = parseDeploymentSet(deploymentRecord());
    expect(tokenFor(parsed, "base", "USDC")?.decimals).toBe(6);
  });

  it("parse JSON text identically to an already parsed object", () => {
    const record = deploymentRecord();
    expect(parseDeploymentSetJson(JSON.stringify(record))).toEqual(parseDeploymentSet(record));
  });

  it("refuse an oversized document before JSON.parse runs", () => {
    // Deliberately not JSON: the size check has to be what rejects it, not the parser.
    const huge = "not json ".repeat(DEFAULT_CODEC_LIMITS.maxDeploymentJsonChars / 9 + 1);
    try {
      parseDeploymentSetJson(huge);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CodecLimitError);
      expect((error as CodecLimitError).limit).toBe("maxDeploymentJsonChars");
    }
  });

  it("still report malformed JSON as a format error", () => {
    expect(() => parseDeploymentSetJson("{ nope")).toThrow(DeploymentFormatError);
    expect(() => parseDeploymentSetJson(42)).toThrow(DeploymentFormatError);
  });

  it("refuse too many networks, naming the owning path", () => {
    const record = deploymentRecord();
    const networks: Record<string, unknown> = {};
    for (let index = 0; index < 4; index += 1)
      networks[`base${String(index)}`] = record.networks.base;
    const crowded = { ...record, networks };
    try {
      parseDeploymentSet(crowded, { maxDeploymentNetworks: 3 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CodecLimitError);
      expect((error as CodecLimitError).path).toBe("$.networks");
    }
  });

  it("refuse too many tokens in one deployment", () => {
    const record = deploymentRecord();
    const tokens = record.networks.base.tokens as Record<string, unknown>;
    for (let index = 1; index < 5; index += 1) tokens[`T${String(index)}`] = tokens.USDC;
    expect(() => parseDeploymentSet(record, { maxDeploymentTokens: 3 })).toThrow(CodecLimitError);
  });
});

describe("asset registry lookups", () => {
  it("answer the ordinary question", () => {
    expect(assetOn("base", "USDC")?.symbol).toBe("USDC");
    expect(routesForPair("base", "stellar", "USDC")).toContain(RouteKind.Cctp);
  });

  it("refuse an oversized symbol before scanning the registry", () => {
    expect(assetOn("base", "U".repeat(DEFAULT_CODEC_LIMITS.maxAssetSymbolChars + 1))).toBeNull();
    expect(routesForPair("base", "stellar", "U".repeat(1000))).toEqual([]);
  });
});
