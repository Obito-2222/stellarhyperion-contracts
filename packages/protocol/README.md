# @hyperion/protocol

The facts both halves of Hyperion have to agree on.

Hyperion is a router, not a bridge. It never decides on its own that a cross chain message is real;
it hands transfers to rails that already made that decision and were audited for it, and it keeps
the bookkeeping, the limits and the fees. That split is the reason this package exists. Two
contracts, an indexer, a keeper and a web app all need the same answer to the same questions: what
a rail is called, how a Stellar address is encoded, how many decimal places survive a hop, how a
flow window decays, and what a revert actually meant. Four implementations of those answers is
three too many, and the three that drift are the ones nobody notices until somebody's money is in
the wrong place.

So this package holds one copy, and a test suite that checks it against the contracts rather than
against itself.

## What is in here

| Module        | What it is for                                                                         |
| ------------- | -------------------------------------------------------------------------------------- |
| `bytes`       | Hex, big endian integers, ascii, slicing that refuses a short read instead of clamping |
| `routes`      | The four rails, their tag values, and what is true about each one                      |
| `errors`      | Both chains' error vocabularies with a sentence of help per error                      |
| `addresses`   | Stellar strkeys: parse, encode, and the two wire forms the rails want                  |
| `notes`       | The notes Hyperion writes into a rail's payload so a delivery knows who it is for      |
| `amounts`     | Fees, decimal conversion, and formatting that never touches a float                    |
| `flow`        | Sliding flow windows, the same arithmetic both routers run                             |
| `cctp`        | Reading CCTP V2 messages, which is all this side ever does with them                   |
| `chains`      | Chains, rpc endpoints, explorers, CCTP domains, finality                               |
| `quotes`      | Pricing a rail locally, so an app can render four of them while somebody types         |
| `deployments` | Deployment records, and a loader that checks them instead of casting them              |
| `registry`    | Assets and rail contracts per chain, with provenance attached                          |
| `abi`         | Generated from the Foundry build, behind its own entry point                           |

```ts
import { parseStellarAddress, planQuotes, formatUnits } from "@hyperion/protocol";
import { hyperionRouterAbi } from "@hyperion/protocol/abi";
```

The ABIs sit behind `@hyperion/protocol/abi` so an app that only wants to format an amount does not
pull forty kilobytes of JSON into its bundle to get it.

## Destination minimum planning

`planForwardQuote` applies a caller-supplied forwarding reserve to an ordinary route quote, and
`planInverseQuote` finds the smallest source amount that meets a requested destination minimum
after that reserve. `quoteMinimumBatch` performs the same inversion for a list of minimums. These
APIs use bigint end to end and the exact protocol-fee and representability floors used by
`planQuote`; the inverse result includes the achieved minimum, rounding overshoot and its bound.

The reserve is explicitly denominated in `destination-token-base-units` and is subtracted from the
bridged amount before comparing the recipient minimum. It is not a provider gas estimate or a
conversion from native gas to the bridged asset. Callers must supply a reserve appropriate to their
provider and denomination; no provider pricing or exchange rate is assumed.

These are planning primitives, not authorization to dispatch. The only independently validated
outbound scope is Stellar Testnet USDC over CCTP to Sepolia, Base Sepolia or Arc Testnet, and over
ITS to Sepolia. Consumers should gate outbound use with
`validatedOutboundRoutesForPair` and `hasValidatedOutboundQuoteWiring`; generic `routesForPair`
and `planQuote` describe configured/math capabilities, not launch validation. EVM-source routes
and other rails remain gated until separately validated. This adds SDK APIs only: no wire format,
ABI, authenticated rail dispatch, replay protection, or recipient-bound claim behavior changes.
Existing `QuoteRequest` and quote results remain compatible; consumers opting into inverse plans
must provide the explicit reserve unit and migrate UI copy to distinguish a destination-token
reserve from gas units.

## Snapshot persistence and bounded planning

`serializeQuoteSnapshot` and `parseQuoteSnapshot` preserve bigint amounts as canonical decimal
strings with schema version 1, explicit source and destination units, and capture time in Unix
seconds. The source label is always `router-snapshot`. Parsing validates booleans, route keys,
fee and precision bounds, integer widths and optional token identity before returning typed data.
Consumers should treat these values as historical observations and refresh chain state before
signing. Unsupported versions and malformed fields fail with a field path.

`maximumSend` finds the largest source request within the supplied balance, rounded net flow
allowance and protocol amount bound. Its search takes at most 128 integer steps, even for balances
wider than a machine word. `requestAmount` is the input to dispatch; `quote.grossAmount` is the
actual debit after precision flooring. `precisionDust` stays with the sender and `balanceDust`
reports the balance beyond the request. A blocked result has `executable: false`, with no quote.
`searchBoundedQuotes` adds a source maximum, destination minimum and explicit allowed routes,
returning a reason for every excluded rail in enum order.

`quoteBatchWithSharedFlow` plans transfers in input order against one virtual budget. Only a
successful winning rail consumes its net amount; excluded items consume nothing. The result
includes consumed and remaining amounts per rail, and does not mutate the caller's snapshot.
`quoteBatch` continues to price independent tiers against the original headroom.

`parseRouteHealthSnapshot` accepts external measurement records with explicit scope, provider
and Unix-second timestamps. `applyRouteHealth` can only restrict existing chain support; healthy
records cannot activate an unsupported route. Missing, unknown, degraded or unavailable records
block a rail. Supply `{ scope, provider, now, maxAge }` to require a matching, fresh measurement.
Without that context, every supplied provider for a route must be healthy. These measurements
describe provider observations, not live prices, transfer authorization or deployment readiness.

These additions preserve existing quote APIs and carry no runtime dependencies. Snapshot and
health schemas are newly versioned; consumers adopting them must supply units and time explicitly.
The active deployment remains Stellar Testnet outbound ITS/CCTP. EVM-source and other rail use
still require separately validated activation evidence.

## Asset identity, and why a symbol is not one

A ticker names an asset the way a surname names a person. `USDC` on Base can be Circle's native
issuance or an Axelar Interchain Token Service representation of it, and those are two contracts
with two addresses, sometimes two precisions and two different sets of rails. Picking the first
entry that matches a symbol is how a transfer leaves as the wrong token.

So the identity of an asset is everything that distinguishes it on its chain:

- the chain key (`base`, `stellar-testnet`, …)
- the representation, `native` or `its`
- the on-chain handle: an EVM contract address, or a Stellar code and issuer

The registry and the deployment loader both expose identity-first lookups:

```ts
import {
  assetIdentity,
  assetOn,
  assetByIdentity,
  resolveAsset,
  resolveAssetForRoute,
  resolveToken,
  tokenByIdentity,
  planQuoteForAsset,
} from "@hyperion/protocol";

resolveAsset({ chain: "base", symbol: "USDC" });
// → { ok: false, reason: "ambiguous", candidates: [native, its] }

resolveAsset({ chain: "base", symbol: "USDC", representation: "its" });
// → { ok: true, asset: the ITS entry }

resolveAssetForRoute("base", RouteKind.Cctp, "USDC");
// → { ok: true, asset: native USDC }, because the ITS entry does not list CCTP
```

`resolveAsset`, `resolveAssetForRoute` and `resolveToken` either name exactly one entry or return a
reason (`not-found` or `ambiguous`) and the candidates, so a picker can show the choice instead of
hiding it. `assetByIdentity` and `tokenByIdentity` take an identity and answer a single asset or
null; they never approximate. `planQuoteForAsset` and `planQuotesForAsset` price a named identity,
and an identity the registry does not carry, or a rail the representation is not registered for,
comes back `TokenNotRegistered` rather than priced against whatever token the snapshot held.

Identity-scoped quotes require `snapshot.tokenIdentity` to name the token whose registration,
decimals and flow limits were read, and require its decimals to match the resolved registry asset.
An unqualified or mismatched snapshot is blocked. Legacy quotes without a requested identity
remain available. Supply the token identity when migrating to the new quote APIs; registry
membership alone cannot establish which token an arbitrary snapshot describes.

### Legacy symbol lookup

`assetOn(chain, symbol)` and `tokenFor(set, chain, symbol)` remain, because plenty of code only
knows a ticker and a chain. Their ambiguity behaviour is now explicit and the same in both:

- exactly one match returns it
- no match returns null
- **more than one match returns null**

A duplicate symbol never silently resolves to the first entry. `pairExists` and `routesForPair`
follow `assetOn`, so an ambiguous end makes them answer `false` and `[]` rather than guess.
Migration is mechanical: if a call site can see two representations of one ticker, switch it to
`resolveAsset({ chain, symbol, representation })`, `resolveAssetForRoute` or `assetByIdentity`.

### Deployment records

Deployment token entries may now carry two optional fields:

```json
"tokens": {
  "USDC": { "address": "0x8335…2913", "representation": "native", … },
  "USDC.its": {
    "symbol": "USDC",
    "representation": "its",
    "address": "0x…",
    "routes": ["axelar-its"],
    …
  }
}
```

`symbol` defaults to the map key and `representation` defaults to `native`, so every file written
before this change loads unchanged and keeps its current meaning. The map key is now free to be a
stable identity key (`USDC.its`) rather than a ticker, which is what allows two representations of
one asset in one record. Unknown representation values are refused by the loader with the field
path, because a typo must not quietly promote an ITS representation to native.

Compatibility is additive: no existing exported name changed its parameters or return type, and
`quoteBatch` results grew one field (`asset`, null when no identity was supplied). The one
behavioural change is the ambiguity rule above, which only differs for a registry or record that
actually lists a duplicate symbol.

### Current deployment scope

The active deployment is **Stellar Testnet, outbound ITS/CCTP**. EVM and other rail development
remains explicitly gated until it is independently validated; the EVM entries in `registry` are
reference data for those rails and are not evidence that a route is live. Identity resolution
does not change that gate: a resolved asset says what token a rail would use, not that the rail is
enabled on chain.

## Input budgets for external data

Every parser here reads something it did not produce: a rail payload, a persisted quote snapshot, a
deployment file, a provider override document, an amount ladder from an input field. Each one
checks an explicit size **before** decoding, slicing or expanding, so an oversized input costs a
length comparison instead of an allocation proportional to it. Past a budget the call throws
`InputBudgetError` naming the field, the budget and the observed size; a malformed input that is
within budget still fails with the format error it always did.

| Budget                    | Default | Applies to                                                                                                                                          |
| ------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxMessageBytes`         | 4096    | `decodeOutboundNote`, `decodeInboundNote`, `decodeCctpHook`, `toEvmAddress`, `parseCctpMessage`, `cctpBody`, `parseCctpBurnMessage`, `cctpHookData` |
| `maxQuoteTiers`           | 256     | `quoteBatch`, `quoteMinimumBatch`, `quoteBatchWithSharedFlow`, `quoteBatchWithProviderAddresses`                                                    |
| `maxSnapshots`            | 256     | `compareSnapshots`                                                                                                                                  |
| `maxQuoteSnapshotChars`   | 1048576 | `parseQuoteSnapshot`                                                                                                                                |
| `maxDeploymentNetworks`   | 32      | `parseDeploymentSet`                                                                                                                                |
| `maxDeploymentTokens`     | 256     | `parseDeploymentSet`, per deployment                                                                                                                |
| `maxDeploymentRoutes`     | 16      | `parseDeploymentSet`, per token record                                                                                                              |
| `maxDeploymentWasmHashes` | 64      | `parseDeploymentSet`, Stellar records                                                                                                               |
| `maxProviderChains`       | 32      | `parseProviderAddressOverrides`                                                                                                                     |
| `maxProviderSymbols`      | 128     | `parseProviderAddressOverrides`, per chain                                                                                                          |

The defaults come from the wire formats, not from what felt generous: a note is 29 bytes, a CCTP
hook 34 or 42, a word 32, so `maxMessageBytes` is orders of magnitude above any Hyperion message
while still refusing a multi-megabyte string cheaply. `INPUT_BUDGETS` is frozen, and every bounded
function takes overrides as its final argument, so a provider that genuinely carries larger
payloads states that once at the call site:

```ts
import { INPUT_BUDGETS, InputBudgetError, decodeInboundNote } from "@hyperion/protocol";

decodeInboundNote(payload); // published ceilings

try {
  decodeInboundNote(payload, { maxMessageBytes: 16_384 }); // explicit provider extension
} catch (error) {
  if (error instanceof InputBudgetError) {
    console.error(error.path, error.budget, error.actual, error.limit);
  }
}
```

`resolveInputBudgets` merges an override over `INPUT_BUDGETS` and refuses unknown budget names and
non-positive ceilings, so a typo fails instead of silently leaving the default in place. The
budgets are per call: nothing here is global mutable state, and two components in one process can
hold different ceilings.

Compatibility: no accepted message, snapshot, deployment record or override document changes
shape, and every existing fixture decodes identically. The only inputs that newly fail are ones
larger than the published ceilings, which are already far past anything the contracts emit; a
consumer that was passing something bigger was doing so against a limit that used to be implied by
whatever its runtime could allocate. Raising a budget is a local decision and does not change the
wire format. The active deployment remains Stellar Testnet outbound ITS/CCTP, and nothing here
ungates EVM or any other rail.

## Three decisions worth knowing about

**No runtime dependencies.** Everything works on `Uint8Array` and `bigint`. No `Buffer`, no viem at
runtime, nothing that assumes Node. The same module is imported by a browser bundle and by a
Fastify process, and neither should be paying for the other's conveniences.

**`bigint` wherever money or an identifier appears.** A `uint256` does not fit in a double, and
neither does a muxed sub account id. The test suite uses two to the fifty three plus one as a
fixture precisely because that is the first integer a `number` gets wrong, and getting it wrong
means crediting the wrong sub account rather than throwing.

**Formatting is canonical, not localised.** `formatUnits` emits no thousands separators, and
`parseUnits` refuses a comma rather than guessing what it meant. A comma is a decimal point across
most of Europe, so a package that grouped digits here would be handing somebody a figure out by a
factor of a thousand. Grouping is a presentation decision; `Intl.NumberFormat` in the app already
knows whose conventions to use. What comes out of `formatUnits` goes straight back into
`parseUnits` unchanged, which is what makes it safe to put in an input field.

## The parity test

`test/parity.test.ts` is the reason to trust the rest. It reads the Rust and the Solidity off disk
and checks that:

- `SOROBAN_ERROR_NAMES` matches `HyperionError` name for name and number for number, and that the
  numbering really does start at one. Reordering that enum would relabel every failure the Stellar
  side has ever emitted, each one plausibly, which is the worst kind of wrong.
- `EVM_ERROR_NAMES` matches the declaration order in `HyperionErrors.sol`.
- Every error selector equals `keccak256` of its signature, so no selector is ever typed by hand.
- `describeError` and `HyperionProtocolError` expose a stable `recovery` class: `transient`,
  `user_correctable`, `operator_action`, or `unknown_outcome`. Unknown names and submission
  uncertainty use `unknown_outcome` and are never automatic retry recommendations.
- `RouteKind`, `AddressKind` and `QuoteBlocker` carry the same integers in all three languages.
- `laneKey` includes network, both chain keys, exact source and destination asset identities, and
  the canonical provider slug. `parseLaneKey` validates the network and provider before a caller
  treats the lane as executable, so two USDC representations never share a key.
- The CCTP offsets, the SEP-23 version bytes, the note layout and the fee and decimal ceilings
  match the constants the contracts actually use.
- Regenerating `src/abi` produces byte for byte what is committed.

The address fixtures are lifted from `evm/test/unit/StellarAddress.t.sol`, which already passes
against a Solidity implementation, and most of them also appear in the Rust suite. A codec checked
only against its own encoder proves the pair agree with each other and nothing else. The one number
in the suite that comes from outside this repository is the CRC16 of a known body, `0xB1D5`,
because a checksum that only agrees with itself is not a checksum.

## Working on it

```bash
npm install          # the committed lockfile is what CI installs
npm run gen          # regenerate src/abi from ../../evm/out, after a forge build
npm run check        # format, lint, typecheck, test, build
```

`npm run gen` needs `forge build` to have run in `../../evm` first. It reads what the compiler
produced rather than guessing, and says so if the artifacts are missing.

`.npmrc` sets `legacy-peer-deps`, and that is deliberate rather than lazy. viem pulls `abitype`,
whose peer range is `typescript >=5.0.4`; TypeScript 7 satisfies that while this package pins the
5.x line `typescript-eslint` supports, and npm's peer resolver walks that conflict into a null node
and dies before writing a single file. Every dependency here is a dev dependency, the package ships
with none at runtime, and `package-lock.json` is committed, so what CI installs is what was tested.
The flag lives in the repository rather than in somebody's shell history because an install flag
that only exists on one machine is a build that only works on one machine.

## Provenance

Addresses in `registry/contracts.ts` and `registry/assets.ts` carry a `source` and a `confirmed`
flag. `confirmed: true` means a primary source was read for that exact entry while this was being
written. Circle's CCTP V2 contracts are address identical across EVM chains, so the Ethereum, Base
and Sepolia entries ship as defaults and are marked `confirmed: false`, because "it is the same
everywhere else" is a reasonable inference and not a reading. Stellar's CCTP addresses are absent
entirely rather than guessed; they come from the deployment record. Shipping a plausible address as
if it were verified is how somebody loses money to a deploy script that looked fine.

## Compare dated router snapshots

`compareSnapshots` compares an explicitly dated collection using one source amount and destination.
Each row includes a deterministic all-rail ladder and its best available quote. Rows sort by timestamp
and ID; ties between rails use the existing canonical-asset/attestation policy in route enum order.
Supply `route` only when comparing the same single rail over time; the complete ladder remains available.
All amounts stay `bigint` throughout the comparison.

```ts
import { compareSnapshots } from "@hyperion/protocol";

const representation = {
  tokenDecimals: 6,
  destinationNetwork: "stellar-testnet",
  destinationTokenId: destinationSacId,
  destinationDecimals: 7,
};
const comparisons = compareSnapshots(
  { amount: 1_000_000n, strkey: recipient, destinationDecimals: 7 },
  observations.map(({ id, takenAt, snapshot }) => ({
    id,
    takenAt,
    snapshot,
    network: "sepolia",
    tokenId: sourceTokenAddress,
    representation,
  })),
  { now: observedUnixSeconds, network: "sepolia", tokenId: sourceTokenAddress, representation },
  60,
);
```

Snapshot timestamps, the reference clock and maximum age are non-negative safe integer Unix seconds.
The exact maximum-age boundary is fresh; future observations and malformed/duplicate IDs are separate
statuses. An old observation is `stale`; a fresh snapshot whose rails refuse the request is `unavailable`.
Invalid fee/precision/flow data is reported as `invalid`, rather than used in arithmetic.

Compatibility binds source chain, source token contract and precision, destination chain, destination
SAC/token contract and precision. Chain keys must be known and both ends must use the same network mode.
EVM contract IDs normalize address case; Stellar SAC IDs require valid checksums. Tickers such as `USDC`
are insufficient. Older unqualified `DatedSnapshot` inputs return `incompatible`; migrate by adding the
concrete `representation` to both each observation and the reference. The existing quote, amount and
SDK deployment lookup APIs remain intact.

Every result is `planningOnly: true`. Caller-supplied snapshots are read-only planning evidence, not
verified live state or an activation decision. This existing local quote engine accepts Stellar recipient
strkeys and is suitable for EVM-to-Stellar development comparisons; it does not implement the active
Stellar-to-EVM outbound quote interface. The active deployment remains Stellar Testnet outbound ITS/CCTP;
EVM and other rail execution stays gated until independently validated. Confirm actual router quotes,
network/token identities and provider costs through the applicable chain integration before execution.

## Provider token addresses

Deployment token records may include an optional `providerAddresses` object keyed by rail slug.
These addresses are kept separate from the canonical token address and its declared decimals:

```json
{
  "address": "0x...",
  "decimals": 6,
  "flowLimit": "1000000000",
  "routes": ["cctp"],
  "providerAddresses": { "cctp": "0x..." }
}
```

`parseProviderAddressOverrides` validates external override data against known chains, asset
capabilities, provider slugs, and the address format for each chain. Quote callers can use
`resolveProviderAddressPair`, `planQuoteWithProviderAddresses`, or
`quoteBatchWithProviderAddresses` to require both ends of a same-network route explicitly. Missing
pairs and malformed values raise `ProviderAddressError` with the failing field path; canonical
token addresses, chain identities, and precision are never inferred from or replaced by provider
overrides. Older deployment records remain valid because the field is optional. Adding overrides
is therefore data-only and requires no schema-version change.
