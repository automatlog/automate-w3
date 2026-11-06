// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TrustEscrow} from "../TrustEscrow.sol";
import {TrustEscrowBase} from "./TrustEscrow.Base.t.sol";

contract TrustEscrowReclaimTest is TrustEscrowBase {
    uint256 internal paidAt;

    function setUp() public override {
        super.setUp();
        vm.warp(1_700_000_000);
        paidAt = block.timestamp;
    }

    function _state(bytes32 id) internal view returns (TrustEscrow.State s) {
        (,, s) = escrow.held(id);
    }

    function test_ReclaimDelayIs14Days() public view {
        assertEq(escrow.RECLAIM_DELAY(), 14 days);
    }

    function test_Reclaim_BeforeDelayReverts() public {
        _pay(ORDER, AMOUNT);
        vm.warp(paidAt + 14 days - 1);
        vm.prank(payer);
        vm.expectRevert(TrustEscrow.TooEarly.selector);
        escrow.reclaim(ORDER);
        assertEq(uint8(_state(ORDER)), uint8(TrustEscrow.State.Held));
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);
    }

    function test_Reclaim_ImmediatelyAfterPayReverts() public {
        _pay(ORDER, AMOUNT);
        vm.prank(payer);
        vm.expectRevert(TrustEscrow.TooEarly.selector);
        escrow.reclaim(ORDER);
    }

    function test_Reclaim_ExactlyAtDelayWorks() public {
        _pay(ORDER, AMOUNT);
        vm.warp(paidAt + 14 days);
        vm.prank(payer);
        escrow.reclaim(ORDER);
        assertEq(uint8(_state(ORDER)), uint8(TrustEscrow.State.Refunded));
    }

    function test_Reclaim_AfterDelayReturnsFundsAndEmits() public {
        _pay(ORDER, AMOUNT);
        vm.warp(paidAt + 14 days + 1);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit TrustEscrow.Reclaimed(ORDER, payer, AMOUNT);
        vm.prank(payer);
        escrow.reclaim(ORDER);

        assertEq(usdc.balanceOf(payer), PAYER_FUNDS);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(uint8(_state(ORDER)), uint8(TrustEscrow.State.Refunded));
    }

    function test_Reclaim_OnlyOnce() public {
        _pay(ORDER, AMOUNT);
        vm.warp(paidAt + 14 days);
        vm.startPrank(payer);
        escrow.reclaim(ORDER);
        vm.expectRevert(TrustEscrow.NotHeld.selector);
        escrow.reclaim(ORDER);
        vm.stopPrank();
        assertEq(usdc.balanceOf(payer), PAYER_FUNDS);
    }

    function test_Reclaim_DelayMeasuredFromPayment() public {
        vm.warp(paidAt + 100 days);
        uint256 t = block.timestamp;
        _pay(ORDER, AMOUNT);
        vm.warp(t + 14 days - 1);
        vm.prank(payer);
        vm.expectRevert(TrustEscrow.TooEarly.selector);
        escrow.reclaim(ORDER);
        vm.warp(t + 14 days);
        vm.prank(payer);
        escrow.reclaim(ORDER);
    }

    function test_Reclaim_NonPayerReverts() public {
        _pay(ORDER, AMOUNT);
        vm.warp(paidAt + 14 days + 1);
        address[4] memory callers = [owner, operator, merchant, stranger];
        for (uint256 i; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(TrustEscrow.NotPayer.selector);
            escrow.reclaim(ORDER);
        }
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);
    }

    function test_Reclaim_AfterReleaseReverts() public {
        _pay(ORDER, AMOUNT);
        vm.prank(operator);
        escrow.release(ORDER);
        vm.warp(paidAt + 14 days + 1);
        vm.prank(payer);
        vm.expectRevert(TrustEscrow.NotHeld.selector);
        escrow.reclaim(ORDER);
        assertEq(usdc.balanceOf(merchant), AMOUNT);
        assertEq(usdc.balanceOf(payer), PAYER_FUNDS - AMOUNT);
    }

    function test_Reclaim_AfterRefundReverts() public {
        _pay(ORDER, AMOUNT);
        vm.prank(operator);
        escrow.refund(ORDER);
        vm.warp(paidAt + 14 days + 1);
        vm.prank(payer);
        vm.expectRevert(TrustEscrow.NotHeld.selector);
        escrow.reclaim(ORDER);
        assertEq(usdc.balanceOf(payer), PAYER_FUNDS);
    }

    function test_Release_AfterReclaimReverts() public {
        _pay(ORDER, AMOUNT);
        vm.warp(paidAt + 14 days);
        vm.prank(payer);
        escrow.reclaim(ORDER);
        vm.prank(operator);
        vm.expectRevert(TrustEscrow.NotHeld.selector);
        escrow.release(ORDER);
        assertEq(usdc.balanceOf(merchant), 0);
    }

    function test_Refund_AfterReclaimReverts() public {
        _pay(ORDER, AMOUNT);
        vm.warp(paidAt + 14 days);
        vm.prank(payer);
        escrow.reclaim(ORDER);
        vm.prank(operator);
        vm.expectRevert(TrustEscrow.NotHeld.selector);
        escrow.refund(ORDER);
        assertEq(usdc.balanceOf(payer), PAYER_FUNDS);
    }

    function test_Reclaim_UnknownOrderReverts() public {
        vm.prank(payer);
        vm.expectRevert(TrustEscrow.NotHeld.selector);
        escrow.reclaim(keccak256("unknown"));
    }

    function test_Reclaim_ReleaseStillPossibleBeforeReclaim() public {
        _pay(ORDER, AMOUNT);
        vm.warp(paidAt + 30 days); // past delay but payer has not reclaimed
        vm.prank(operator);
        escrow.release(ORDER);
        assertEq(usdc.balanceOf(merchant), AMOUNT);
    }

    /// PROPERTY: reclaim returns exactly the paid amount, and only at/after the delay.
    function testFuzz_Reclaim(uint256 amount, uint256 elapsed) public {
        amount = bound(amount, 1, PAYER_FUNDS);
        elapsed = bound(elapsed, 0, 60 days);
        _pay(ORDER, amount);
        vm.warp(paidAt + elapsed);
        vm.prank(payer);
        if (elapsed < 14 days) {
            vm.expectRevert(TrustEscrow.TooEarly.selector);
            escrow.reclaim(ORDER);
            assertEq(usdc.balanceOf(address(escrow)), amount);
        } else {
            escrow.reclaim(ORDER);
            assertEq(usdc.balanceOf(payer), PAYER_FUNDS);
            assertEq(usdc.balanceOf(address(escrow)), 0);
        }
    }
}
