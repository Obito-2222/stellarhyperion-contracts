import {
  BPS_DENOMINATOR,
  MAX_DECIMALS,
  convertDecimals,
  floorToRepresentable,
} from "../amounts.js";
import { tryParseStellarAddress, AddressKind } from "../addresses.js";
import { ASSETS, assetByIdentity, sameAssetIdentity } from "../registry/assets.js";
import type { RouteKind } from "../routes.js";
import { ROUTE_KINDS, carriesPayload, isCanonical, waitsOnAttestation } from "../routes.js";
import { MAX_QUOTE_AMOUNT, QuoteBlocker, bestQuote, planInverseQuote } from "../quotes.js";
import type { InverseQuotePlan, InverseQuoteRequest, RouteQuote } from "../quotes.js";
import {
  resolveProviderAddressPair,
  type ProviderAddressOverrides,
  type ProviderAddressPair,
} from "../registry/assets.js";
import type { ChainKey } from "../chains.js";
import { boundedNumber, validatePlanningSnapshot } from "./validation.js";
import { assertInputBudget, resolveInputBudgets, type InputBudgetOverrides } from "../limits.js";
import {
  RAIL_DESTINATION_GAS_ESTIMATES,
  type BatchQuoteResult,
  type QuoteParams,
} from "./types.js";

interface PrecomputedRailContext {
  readonly route: RouteKind;
  readonly staticBlocker: QuoteBlocker | null;
  readonly headroom: bigint;
  readonly waitsOnAttestation: boolean;
  readonly isCanonical: boolean;
}

/**
 * Price multiple amount tiers simultaneously across all rails without redundant recalculations.
 *
 * Designed for fee curve rendering, client UI ladders, and routing aggregators pricing
 * amount ladders (e.g. [100 USDC, 500 USDC, 1,000 USDC]) in a single call.
 *
 * Optimizations:
 * - Pre-validates destination address formatting and checksum once for the entire batch.
 * - Pre-checks static snapshot constraints (paused state, rail enablement, adapters, token status).
 * - Avoids repetitive allocations and string parsing inside the tier loop.
 * - Maintains zero external runtime dependencies and exact decimal parity with on-chain contracts.
 */
export function quoteBatch(
  tiers: readonly bigint[],
  params: QuoteParams,
  budgets?: InputBudgetOverrides,
): readonly BatchQuoteResult[] {
  assertInputBudget(tiers.length, "maxQuoteTiers", "tiers", resolveInputBudgets(budgets));
  const { strkey, destinationDecimals, snapshot, gasEstimates } = params;

  // Resolve the requested asset identity once. An unknown identity or a rail the representation
  // is not registered for fails shut, the same way an unregistered token does.
  const requestedAsset = params.asset ?? null;
  const resolvedAsset =
    requestedAsset === null ? null : assetByIdentity(requestedAsset, params.registry ?? ASSETS);

  // Build combined gas projections from historical defaults and caller overrides
  const gasProjections: Record<RouteKind, bigint> = {
    ...RAIL_DESTINATION_GAS_ESTIMATES,
    ...gasEstimates,
  };

  // Pre-parse destination address once for all rails and all tiers
  const parsedAddress = tryParseStellarAddress(strkey);
  const isMuxed = parsedAddress.ok && parsedAddress.parts.kind === AddressKind.MuxedAccount;

  // Check static token bounds once
  const tokenDecimalsInvalid =
    snapshot.tokenDecimals > MAX_DECIMALS || destinationDecimals > MAX_DECIMALS;

  // Pre-compute static rail context so only amount-dependent arithmetic runs per tier
  const railContexts: readonly PrecomputedRailContext[] = ROUTE_KINDS.map((route) => {
    let staticBlocker: QuoteBlocker | null = null;

    if (snapshot.paused) {
      staticBlocker = QuoteBlocker.Paused;
    } else if (snapshot.routeEnabled[route] !== true) {
      staticBlocker = QuoteBlocker.RouteDisabled;
    } else if (snapshot.adapterSet[route] !== true) {
      staticBlocker = QuoteBlocker.AdapterNotSet;
    } else if (!parsedAddress.ok) {
      staticBlocker = QuoteBlocker.InvalidDestination;
    } else if (isMuxed && !carriesPayload(route)) {
      staticBlocker = QuoteBlocker.MuxedNotSupported;
    } else if (snapshot.chainSupported[route] !== true) {
      staticBlocker = QuoteBlocker.ChainNotSupported;
    } else if (!snapshot.tokenRegistered) {
      staticBlocker = QuoteBlocker.TokenNotRegistered;
    } else if (!snapshot.tokenEnabled) {
      staticBlocker = QuoteBlocker.TokenDisabled;
    } else if (
      requestedAsset !== null &&
      (!resolvedAsset?.routes.includes(route) ||
        snapshot.tokenIdentity === undefined ||
        !sameAssetIdentity(snapshot.tokenIdentity, requestedAsset) ||
        snapshot.tokenDecimals !== resolvedAsset.decimals)
    ) {
      staticBlocker = QuoteBlocker.TokenNotRegistered;
    } else if (tokenDecimalsInvalid) {
      staticBlocker = QuoteBlocker.NotRepresentable;
    }

    return {
      route,
      staticBlocker,
      headroom: snapshot.flowAvailable[route] ?? 0n,
      waitsOnAttestation: waitsOnAttestation(route),
      isCanonical: isCanonical(route),
    };
  });

  const feeBps = BigInt(snapshot.feeBps);

  return tiers.map((tierAmount) => {
    const quotes: RouteQuote[] = railContexts.map((ctx) => {
      const base: RouteQuote = {
        route: ctx.route,
        available: false,
        reason: QuoteBlocker.None,
        grossAmount: tierAmount,
        fee: 0n,
        netAmount: 0n,
        destinationAmount: 0n,
        flowAvailable: ctx.headroom,
        waitsOnAttestation: ctx.waitsOnAttestation,
        isCanonical: ctx.isCanonical,
      };

      // If a static blocker was hit, return immediately
      if (ctx.staticBlocker !== null) {
        return { ...base, reason: ctx.staticBlocker };
      }

      // Tier amount bounds
      if (tierAmount <= 0n) {
        return { ...base, reason: QuoteBlocker.AmountTooSmall };
      }
      if (tierAmount > MAX_QUOTE_AMOUNT) {
        return { ...base, reason: QuoteBlocker.NotRepresentable };
      }

      // Fee and net token computation
      const fee = (tierAmount * feeBps) / BPS_DENOMINATOR;
      const netRaw = tierAmount - fee;
      if (netRaw === 0n) {
        return { ...base, reason: QuoteBlocker.AmountTooSmall };
      }

      const net = floorToRepresentable(netRaw, snapshot.tokenDecimals, destinationDecimals);
      if (net === 0n) {
        return { ...base, reason: QuoteBlocker.NotRepresentable };
      }

      // Headroom flow limit check
      if (net > ctx.headroom) {
        return { ...base, reason: QuoteBlocker.FlowLimitExceeded };
      }

      // Convert to destination decimals
      const { converted } = convertDecimals(net, snapshot.tokenDecimals, destinationDecimals);

      return {
        ...base,
        available: true,
        reason: QuoteBlocker.None,
        fee,
        netAmount: net,
        grossAmount: fee + net,
        destinationAmount: converted,
      };
    });

    const best = bestQuote(quotes);
    const available = best !== null;

    return {
      amount: tierAmount,
      asset: requestedAsset,
      available,
      winningRail: best !== null ? best.route : null,
      bestQuote: best,
      grossAmount: best !== null ? best.grossAmount : tierAmount,
      fee: best !== null ? best.fee : 0n,
      netAmount: best !== null ? best.netAmount : 0n,
      destinationAmount: best !== null ? best.destinationAmount : 0n,
      estimatedDestinationGas: best !== null ? gasProjections[best.route] : null,
      gasProjections: Object.freeze(gasProjections),
      quotes,
    };
  });
}

/**
 * Invert a batch of destination minimums using one shared route snapshot and budget assumption.
 *
 * This intentionally returns one exact plan per requested minimum; it does not interpolate
 * between tiers because fees and representability are integer floors.
 */
export function quoteMinimumBatch(
  minimums: readonly bigint[],
  params: Omit<InverseQuoteRequest, "minimumDestinationAmount"> & {
    readonly snapshot: QuoteParams["snapshot"];
  },
  budgets?: InputBudgetOverrides,
): readonly InverseQuotePlan[] {
  assertInputBudget(minimums.length, "maxQuoteTiers", "minimums", resolveInputBudgets(budgets));
  return minimums.map((minimumDestinationAmount) =>
    planInverseQuote({ ...params, minimumDestinationAmount }, params.snapshot),
  );
}

/** Provider address context for a batch quote; token decimals remain part of the quote inputs. */
export interface ProviderAwareQuoteParams extends QuoteParams {
  readonly sourceChain: ChainKey;
  readonly destinationChain: ChainKey;
  readonly symbol: string;
  readonly providerAddressOverrides: ProviderAddressOverrides;
}

export interface ProviderAwareBatchQuoteResult {
  readonly quotes: readonly BatchQuoteResult[];
  readonly providerAddresses: Readonly<Partial<Record<RouteKind, ProviderAddressPair>>>;
}

/**
 * Quote a ladder and resolve explicit provider address pairs for each snapshot-supported route.
 *
 * The pair metadata is returned separately so existing quote result schemas remain unchanged.
 */
export function quoteBatchWithProviderAddresses(
  tiers: readonly bigint[],
  params: ProviderAwareQuoteParams,
  budgets?: InputBudgetOverrides,
): ProviderAwareBatchQuoteResult {
  assertInputBudget(tiers.length, "maxQuoteTiers", "tiers", resolveInputBudgets(budgets));
  const providerAddresses: Partial<Record<RouteKind, ProviderAddressPair>> = {};
  for (const route of ROUTE_KINDS) {
    if (params.snapshot.chainSupported[route] !== true) continue;
    providerAddresses[route] = resolveProviderAddressPair(
      params.sourceChain,
      params.destinationChain,
      params.symbol,
      route,
      params.providerAddressOverrides,
    );
  }
  return {
    quotes: quoteBatch(tiers, params, budgets),
    providerAddresses: Object.freeze(providerAddresses),
  };
}

export interface SharedFlowBatchResult {
  /** Results in input order. A blocked item does not consume virtual flow. */
  readonly results: readonly BatchQuoteResult[];
  /** Net amount consumed per rail by successful items in this plan. */
  readonly consumedFlow: Readonly<Partial<Record<RouteKind, bigint>>>;
  /** Remaining virtual headroom after successful items, without touching chain state. */
  readonly remainingFlow: Readonly<Partial<Record<RouteKind, bigint>>>;
}

/**
 * Plan sequential transfers against one virtual flow budget.
 *
 * Each item sees the headroom left by earlier successful items. A blocked item is excluded and
 * rolls back nothing; only a result with a winning rail commits its net amount to the virtual
 * budget. The caller can discard the returned plan without changing the live router.
 */
export function quoteBatchWithSharedFlow(
  tiers: readonly bigint[],
  params: QuoteParams,
  budgets?: InputBudgetOverrides,
): SharedFlowBatchResult {
  assertInputBudget(tiers.length, "maxQuoteTiers", "tiers", resolveInputBudgets(budgets));
  validatePlanningSnapshot(params.snapshot);
  boundedNumber(params.destinationDecimals, MAX_DECIMALS, "destinationDecimals");
  if (tiers.some((tier) => typeof tier !== "bigint"))
    throw new TypeError("tiers must contain bigint amounts");
  const remaining: Partial<Record<RouteKind, bigint>> = { ...params.snapshot.flowAvailable };
  const consumed: Partial<Record<RouteKind, bigint>> = {};
  const results: BatchQuoteResult[] = [];

  for (const tier of tiers) {
    const snapshot: typeof params.snapshot = { ...params.snapshot, flowAvailable: remaining };
    const result = quoteBatch([tier], { ...params, snapshot })[0];
    if (result === undefined) throw new Error("single-tier quote did not return a result");
    results.push(result);
    if (result.bestQuote === null || result.winningRail === null) continue;
    const route = result.winningRail;
    const next = (remaining[route] ?? 0n) - result.netAmount;
    remaining[route] = next;
    consumed[route] = (consumed[route] ?? 0n) + result.netAmount;
  }

  return { results, consumedFlow: consumed, remainingFlow: remaining };
}
