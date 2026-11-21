// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAccessControl} from "openzeppelin/access/IAccessControl.sol";

import {
    ActionFieldNotEmpty,
    CircuitBreakerNotConfigured,
    CircuitBreakerThresholdExceeded,
    InvalidLimit,
    TimelockNotReady,
    TokenCircuitBreakerTripped,
    TokenNotRegistered,
    Unauthorized
} from "../../src/HyperionErrors.sol";
import {HyperionRouter} from "../../src/HyperionRouter.sol";
import {
    ActionKind,
    AdminAction,
    Origin,
    OutboundRequest,
    QuoteBlocker,
    RouteKind,
    RouteQuote,
    TokenBreaker
} from "../../src/HyperionTypes.sol";
import {IHyperionRouter} from "../../src/interfaces/IHyperionRouter.sol";
import {Fixture} from "../Fixture.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// @title The emergency brake, which is not a flow limit
/// @notice A breaker stops one asset's departures on an operator's word, caps any single
/// departure while armed, and leaves arrivals and fixed-recipient claims untouched.
/// @dev The properties worth proving are asymmetric on purpose: tripping and tightening are
/// immediate, because both only narrow what the bridge will do; clearing a trip and widening the
/// ceiling wait out the timelock, because both expand exposure.
contract RouterCircuitBreakerTest is Fixture {
    uint256 internal constant EMERGENCY = 100_000e6;

    function setUp() public override {
        super.setUp();
        _setFeeBps(0);
        _setBreakerThreshold(address(usdc), EMERGENCY);
        usdc.mint(railReceiver, 10_000_000e6);
        vm.prank(railReceiver);
        usdc.approve(address(router), type(uint256).max);
    }

    function _trip() internal {
        vm.prank(guardian);
        router.tripTokenBreaker(address(usdc));
    }

    function _origin(bytes32 messageId) internal pure returns (Origin memory) {
        return Origin({chain: STELLAR, nonce: 7, messageId: messageId, sender: bytes32(uint256(1))});
    }

    // -------------------------------------------------------------------------------------
    // The reviewed threshold
    // -------------------------------------------------------------------------------------

    function test_a_threshold_is_recorded_once_the_timelock_matures() public view {
        TokenBreaker memory breaker = router.circuitBreaker(address(usdc));
        assertTrue(breaker.configured);
        assertFalse(breaker.tripped);
        assertEq(breaker.threshold, EMERGENCY);
        assertEq(breaker.trippedAt, 0);
        assertEq(breaker.trippedBy, address(0));
    }

    function test_a_threshold_cannot_exceed_the_ordinary_flow_limit() public {
        AdminAction memory action = _empty(ActionKind.SetTokenBreakerThreshold);
        action.subject = address(usdc);
        action.amount = FLOW_LIMIT + 1;

        vm.prank(admin);
        vm.expectRevert(InvalidLimit.selector);
        router.queueAction(action);

        // Zero would be indistinguishable from an unconfigured breaker.
        action.amount = 0;
        vm.prank(admin);
        vm.expectRevert(InvalidLimit.selector);
        router.queueAction(action);

        // The boundary itself is allowed.
        action.amount = FLOW_LIMIT;
        vm.prank(admin);
        router.queueAction(action);
    }

    function test_a_threshold_needs_a_registered_token() public {
        AdminAction memory action = _empty(ActionKind.SetTokenBreakerThreshold);
        action.subject = address(0xdead);
        action.amount = 1;

        vm.prank(admin);
        vm.expectRevert(TokenNotRegistered.selector);
        router.queueAction(action);
    }

    function test_a_guardian_can_tighten_the_ceiling_but_not_widen_it() public {
        vm.prank(guardian);
        router.lowerTokenBreakerThreshold(address(usdc), 50_000e6);
        assertEq(router.circuitBreaker(address(usdc)).threshold, 50_000e6);

        // Raising is a queued admin action, not a guardian's immediate power.
        vm.prank(guardian);
        vm.expectRevert(InvalidLimit.selector);
        router.lowerTokenBreakerThreshold(address(usdc), 60_000e6);

        vm.prank(stranger);
        vm.expectRevert(Unauthorized.selector);
        router.lowerTokenBreakerThreshold(address(usdc), 40_000e6);
    }

    function test_lowering_the_flow_limit_never_leaves_the_breaker_looser() public {
        vm.prank(guardian);
        router.lowerTokenFlowLimit(address(usdc), 40_000e6);

        TokenBreaker memory breaker = router.circuitBreaker(address(usdc));
        assertEq(breaker.threshold, 40_000e6);
        assertTrue(breaker.configured, "the breaker stays configured");
    }

    // -------------------------------------------------------------------------------------
    // Tripping stops departures, and only departures
    // -------------------------------------------------------------------------------------

    function test_tripping_stops_new_departures_for_that_token() public {
        _trip();
        assertTrue(router.circuitBreaker(address(usdc)).tripped);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TokenCircuitBreakerTripped.selector, address(usdc)));
        router.bridgeOut(_usdcRequest(1000e6));
    }

    function test_a_trip_says_who_did_it_and_against_what_ceiling() public {
        vm.expectEmit(true, true, true, true, address(router));
        emit IHyperionRouter.CircuitBreakerTripped(address(usdc), guardian, EMERGENCY);
        _trip();

        TokenBreaker memory breaker = router.circuitBreaker(address(usdc));
        assertEq(breaker.trippedBy, guardian);
        assertEq(breaker.trippedAt, block.timestamp);
    }

    function test_a_stranger_cannot_trip_the_breaker() public {
        vm.prank(stranger);
        vm.expectRevert(Unauthorized.selector);
        router.tripTokenBreaker(address(usdc));
    }

    function test_an_unconfigured_breaker_cannot_be_tripped() public {
        HyperionRouter bare = _freshRouter();
        AdminAction memory register = _empty(ActionKind.RegisterToken);
        register.subject = address(usdc);
        register.amount = FLOW_LIMIT;
        register.decimals = USDC_DECIMALS;
        _runOn(bare, register);

        vm.prank(guardian);
        vm.expectRevert(CircuitBreakerNotConfigured.selector);
        bare.tripTokenBreaker(address(usdc));
    }

    function test_arrivals_and_fixed_recipient_claims_keep_working_while_tripped() public {
        _trip();

        // An ordinary arrival pays straight through.
        vm.prank(railReceiver);
        router.bridgeIn(RouteKind.Cctp, address(usdc), 250e6, bob, _origin(keccak256("arrival-one")));
        assertEq(usdc.balanceOf(bob), 250e6);

        // A recipient that cannot receive parks a claim, and settling it later still works.
        usdc.setBlocked(stranger, true);
        vm.prank(railReceiver);
        uint64 claimId = router.bridgeIn(
            RouteKind.Cctp, address(usdc), 500e6, stranger, _origin(keccak256("arrival-two"))
        );
        assertEq(claimId, 1);
        assertEq(router.pendingClaim(claimId).amount, 500e6);

        usdc.setBlocked(stranger, false);
        router.settleClaim(claimId);
        assertEq(usdc.balanceOf(stranger), 500e6);
        assertTrue(router.circuitBreaker(address(usdc)).tripped, "settling never resets the breaker");
    }

    function test_another_token_is_unaffected_by_the_trip() public {
        MockERC20 other = new MockERC20("Other", "OTH", USDC_DECIMALS);
        _registerToken(address(other), USDC_DECIMALS, FLOW_LIMIT);
        _setBreakerThreshold(address(other), FLOW_LIMIT);

        other.mint(alice, 1000e6);
        vm.prank(alice);
        other.approve(address(router), type(uint256).max);

        _trip();

        OutboundRequest memory request = _usdcRequest(1000e6);
        request.token = address(other);
        vm.prank(alice);
        uint64 nonce = router.bridgeOut(request);
        assertEq(nonce, 1);
        assertEq(other.balanceOf(address(cctpRail)), 1000e6);
    }

    // -------------------------------------------------------------------------------------
    // The per-departure ceiling while armed
    // -------------------------------------------------------------------------------------

    function test_a_single_departure_above_the_ceiling_is_refused() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(CircuitBreakerThresholdExceeded.selector, EMERGENCY + 1, EMERGENCY)
        );
        router.bridgeOut(_usdcRequest(EMERGENCY + 1));

        // Exactly at the ceiling is allowed; the ceiling is a limit, not an exclusive bound.
        vm.prank(alice);
        router.bridgeOut(_usdcRequest(EMERGENCY));
        assertEq(router.outboundNonce(), 1);
    }

    function test_the_ceiling_is_measured_against_what_crosses_not_what_is_charged() public {
        _setFeeBps(10);
        // Net is amount less ten basis points, so a gross of ceiling plus a little still fits.
        uint256 gross = EMERGENCY + 100e6;
        uint256 net = gross - (gross * 10) / 10_000;
        assertLt(net, EMERGENCY + 100e6);

        vm.prank(alice);
        router.bridgeOut(_usdcRequest(gross));
        assertEq(router.outboundNonce(), 1);
    }

    // -------------------------------------------------------------------------------------
    // Reset is a reviewed operation
    // -------------------------------------------------------------------------------------

    function test_reset_waits_out_the_timelock_and_does_not_move_the_threshold() public {
        _trip();
        vm.prank(guardian);
        router.lowerTokenBreakerThreshold(address(usdc), 25_000e6);

        AdminAction memory reset = _empty(ActionKind.ResetTokenBreaker);
        reset.subject = address(usdc);
        vm.prank(admin);
        uint64 id = router.queueAction(reset);

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(TimelockNotReady.selector, block.timestamp + TIMELOCK));
        router.executeAction(id);

        vm.warp(block.timestamp + TIMELOCK + 1);
        vm.prank(admin);
        router.executeAction(id);

        TokenBreaker memory breaker = router.circuitBreaker(address(usdc));
        assertFalse(breaker.tripped);
        assertEq(breaker.threshold, 25_000e6, "the guardian's tightening survives the reset");
        assertEq(breaker.trippedAt, 0);
        assertEq(breaker.trippedBy, address(0));

        vm.prank(alice);
        router.bridgeOut(_usdcRequest(25_000e6));
        assertEq(router.outboundNonce(), 1);
    }

    function test_a_guardian_cannot_queue_or_execute_a_reset() public {
        _trip();
        AdminAction memory reset = _empty(ActionKind.ResetTokenBreaker);
        reset.subject = address(usdc);

        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, guardian, adminRole
            )
        );
        router.queueAction(reset);
    }

    function test_resetting_a_breaker_that_is_not_tripped_is_refused() public {
        AdminAction memory reset = _empty(ActionKind.ResetTokenBreaker);
        reset.subject = address(usdc);

        vm.prank(admin);
        vm.expectRevert(InvalidLimit.selector);
        router.queueAction(reset);
    }

    function test_setting_a_new_ceiling_does_not_clear_a_trip() public {
        _trip();
        _setBreakerThreshold(address(usdc), 10_000e6);

        TokenBreaker memory breaker = router.circuitBreaker(address(usdc));
        assertTrue(breaker.tripped, "a ceiling change is not an incident review");
        assertEq(breaker.threshold, 10_000e6);
    }

    function test_a_reset_carries_no_unused_fields() public {
        _trip();
        AdminAction memory reset = _empty(ActionKind.ResetTokenBreaker);
        reset.subject = address(usdc);
        reset.amount = 1;

        vm.prank(admin);
        vm.expectRevert(ActionFieldNotEmpty.selector);
        router.queueAction(reset);
    }

    // -------------------------------------------------------------------------------------
    // Diagnostics
    // -------------------------------------------------------------------------------------

    function test_quote_and_explain_name_the_breaker() public {
        _trip();

        RouteQuote memory quote = router.quote(RouteKind.Cctp, address(usdc), 1000e6, _dest(G_ADDR), 7);
        assertFalse(quote.available);
        assertEq(uint8(quote.reason), uint8(QuoteBlocker.CircuitBreakerTripped));

        assertEq(
            router.explainOutbound(_usdcRequest(1000e6), 0, 0),
            TokenCircuitBreakerTripped.selector,
            "the local preflight names the same reason"
        );
    }

    function test_quote_names_the_emergency_ceiling_separately() public view {
        RouteQuote memory quote = router.quote(RouteKind.Cctp, address(usdc), EMERGENCY + 1, _dest(G_ADDR), 7);
        assertFalse(quote.available);
        assertEq(uint8(quote.reason), uint8(QuoteBlocker.CircuitBreakerThresholdExceeded));

        assertEq(
            router.explainOutbound(_usdcRequest(EMERGENCY + 1), 0, 0),
            CircuitBreakerThresholdExceeded.selector
        );
    }
}
