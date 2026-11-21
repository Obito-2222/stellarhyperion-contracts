// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Hyperion's refusals, in one place.
//
// Every name here is the name the Stellar side uses for the same refusal. `hyperion_core`
// numbers its errors because Soroban puts an integer in the transaction result; Solidity gets a
// selector instead, and the shared vocabulary is the point rather than the shared integer. An
// operator reading "MuxedNotSupported" off an EVM revert and off a Soroban transaction result
// should not have to look up which one means what.

import {RouteKind} from "./HyperionTypes.sol";

// Lifecycle and roles.
error AlreadyInitialized();
error NotInitialized();
error Unauthorized();
error NotRailReceiver();
error RouteDisabled();
error RouteIsPaused(RouteKind route);
error AdapterNotSet();

// Amounts, decimals and fees.
error InvalidAmount();
error AmountNotRepresentable();
error DecimalOverflow();
error InvalidDecimals();
error SlippageExceeded(uint256 wanted, uint256 got);
error FeeTooHigh();
error AmountBelowMinimum();

// Flow control.
error FlowLimitExceeded(uint256 requested, uint256 available);
error InvalidLimit();
error InvalidWindow();
error LimitNotRaised();

// Destinations.
error InvalidDestination();
error ZeroAddressKey();
error MuxedNotSupported();
error NotEvmAddress();
error UnknownChain();

// Messages.
error ReplayedMessage();
error MalformedMessage();
error UnsupportedHookVersion();
error UnsupportedMessageVersion();
error WrongDomain();
error NotMintRecipient();
error UnexpectedRailContract();
error NothingMinted();
error UnsupportedRoute();

// The timelock.
error TimelockNotQueued();
error TimelockNotReady(uint64 eta);
error TimelockExpired(uint64 expiredAt);
error TimelockDelayOutOfRange();
error TimelockAlreadyExecuted();
error ActionFieldNotEmpty();

// Claims.
error ClaimNotFound();
error ClaimAlreadySettled();
error RecipientNotReady();

// Tokens and wiring.
error TokenNotRegistered();
error TokenDisabled();
error TokenNotMapped();
error RailNotConfigured();
error AlreadyConfigured();
error ProtectedAsset();
error ZeroAddress();

// Native currency, on the way back out.
//
// Rails quote destination gas high and refund the difference, so a `bridgeOut` usually ends by
// sending change to the sender. A sender who cannot accept it is refused rather than tipped,
// because silently keeping the difference is a second fee nobody agreed to.
error RefundFailed();

/// @notice The native provider payment exceeds the explicit sender cap.
error ProviderBudgetExceeded();

/// @notice The adapter lacks a usable local dispatch validation method.
error AdapterMethodUnavailable();

// Emergency circuit breakers, appended so no earlier selector moves.
//
// A breaker is deliberately not a flow limit. A flow limit is the ordinary operating ceiling that
// decays across a window; a breaker is an operator's answer to something already going wrong, it
// stops departures for one asset outright, and it cannot be reset without a reviewed change.
/// @notice New departures for this token are stopped by its circuit breaker.
error TokenCircuitBreakerTripped(address token);

/// @notice One departure exceeds the token's emergency per-transfer threshold.
error CircuitBreakerThresholdExceeded(uint256 amount, uint256 threshold);

/// @notice The breaker has no reviewed threshold, so it cannot be tripped or reset.
error CircuitBreakerNotConfigured();

// Messenger rotation.
error RotationAlreadyPending();
error RotationNotPending();
error RotationNotReady();
error MessengerUnchanged();
error OldMessengerExpired();
/// @notice No outbound ITS transfer is registered for this top-up intent.
error TopUpIntentNotFound();

/// @notice A top-up changed an intent's bound message, destination, or refund recipient.
error TopUpBindingMismatch();
