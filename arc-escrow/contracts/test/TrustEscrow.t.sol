// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {TrustEscrow} from "../TrustEscrow.sol";
import {TrustEscrowBase, MockUSDC6} from "./TrustEscrow.Base.t.sol";

contract TrustEscrowTest is TrustEscrowBase {
    // ---------------------------------------------------------------- constructor

    function test_Constructor_SetsState() public view {
        assertEq(address(escrow.usdc()), address(usdc));
        assertEq(escrow.merchant(), merchant);
        assertEq(escrow.operator(), operator);
        assertEq(escrow.owner(), owner);
    }

    function test_Constructor_RevertsOnZeroUsdc() public {
        vm.expectRevert(TrustEscrow.ZeroAddress.selector);
        new TrustEscrow(IERC20(address(0)), merchant, operator, owner);
    }

    function test_Constructor_RevertsOnZeroMerchant() public {
        vm.expectRevert(TrustEscrow.ZeroAddress.selector);
        new TrustEscrow(IERC20(address(usdc)), address(0), operator, owner);
    }

    function test_Constructor_RevertsOnZeroOperator() public {
        vm.expectRevert(TrustEscrow.ZeroAddress.selector);
        new TrustEscrow(IERC20(address(usdc)), merchant, address(0), owner);
    }

    function test_Constructor_RevertsOnZeroOwner() public {
        vm.expectRevert(TrustEscrow.ZeroAddress.selector);
        new TrustEscrow(IERC20(address(usdc)), merchant, operator, address(0));
    }

    // ------------------------------------------------------------------------ pay

    function test_Pay_HoldsFunds() public {
        vm.warp(1_700_000_000);
        uint256 escrowBefore = usdc.balanceOf(address(escrow));
        uint256 payerBefore = usdc.balanceOf(payer);

        _pay(ORDER, AMOUNT);

        assertEq(usdc.balanceOf(address(escrow)), escrowBefore + AMOUNT);
        assertEq(usdc.balanceOf(payer), payerBefore - AMOUNT);

        (address p, uint256 a, TrustEscrow.State s) = escrow.held(ORDER);
        assertEq(p, payer);
        assertEq(a, AMOUNT);
        assertEq(uint8(s), uint8(TrustEscrow.State.Held));

        (,,, uint64 paidAt) = escrow.orders(ORDER);
        assertEq(paidAt, 1_700_000_000);
    }

    function test_Pay_EmitsPaid() public {
        uint256 dl = _deadline();
        bytes memory sig = _sign(ORDER, AMOUNT, dl);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit TrustEscrow.Paid(ORDER, payer, AMOUNT);
        vm.prank(payer);
        escrow.pay(ORDER, AMOUNT, dl, sig);
    }

    function test_Pay_RevertsOnDuplicateOrderId() public {
        _pay(ORDER, AMOUNT);
        uint256 dl = _deadline();
        bytes memory sig = _sign(ORDER, AMOUNT, dl);
        vm.prank(payer);
        vm.expectRevert(TrustEscrow.OrderExists.selector);
        escrow.pay(ORDER, AMOUNT, dl, sig);
    }

    function test_Pay_DuplicateRevertsEvenFromOtherPayer() public {
        _pay(ORDER, AMOUNT);
        usdc.mint(stranger, AMOUNT);
        uint256 dl = _deadline();
        bytes memory sig = _sign(ORDER, AMOUNT, dl);
        vm.startPrank(stranger);
        usdc.approve(address(escrow), AMOUNT);
        vm.expectRevert(TrustEscrow.OrderExists.selector);
        escrow.pay(ORDER, AMOUNT, dl, sig);
        vm.stopPrank();
    }

    function test_Pay_RevertsOnZeroAmount() public {
        uint256 dl = _deadline();
        bytes memory sig = _sign(ORDER, 0, dl);
        vm.prank(payer);
        vm.expectRevert(TrustEscrow.ZeroAmount.selector);
        escrow.pay(ORDER, 0, dl, sig);
    }

    function test_Pay_RevertsWithoutAllowanceOrBalance() public {
        uint256 dl = _deadline();
        bytes memory sig = _sign(ORDER, AMOUNT, dl);
        vm.prank(stranger); // no balance / allowance
        vm.expectRevert();
        escrow.pay(ORDER, AMOUNT, dl, sig);
        (,, TrustEscrow.State s) = escrow.held(ORDER);
        assertEq(uint8(s), uint8(TrustEscrow.State.None));
    }

    // -------------------------------------------------------------------- release

    function test_Release_PaysMerchantOnce() public {
        _pay(ORDER, AMOUNT);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit TrustEscrow.Released(ORDER, merchant, AMOUNT);
        vm.prank(operator);
        escrow.release(ORDER);

        assertEq(usdc.balanceOf(merchant), AMOUNT);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        (, , TrustEscrow.State s) = escrow.held(ORDER);
        assertEq(uint8(s), uint8(TrustEscrow.State.Released));
    }

    function test_Release_SecondReleaseReverts() public {
        _pay(ORDER, AMOUNT);
        vm.startPrank(operator);
        escrow.release(ORDER);
        vm.expectRevert(TrustEscrow.NotHeld.selector);
        escrow.release(ORDER);
        vm.stopPrank();
        assertEq(usdc.balanceOf(merchant), AMOUNT);
    }

    function test_Release_UnknownOrderReverts() public {
        vm.prank(operator);
        vm.expectRevert(TrustEscrow.NotHeld.selector);
        escrow.release(keccak256("unknown"));
    }

    function test_Release_AfterRefundReverts() public {
        _pay(ORDER, AMOUNT);
        vm.startPrank(operator);
        escrow.refund(ORDER);
        vm.expectRevert(TrustEscrow.NotHeld.selector);
        escrow.release(ORDER);
        vm.stopPrank();
        assertEq(usdc.balanceOf(merchant), 0);
    }

    function test_Release_NonOperatorReverts() public {
        _pay(ORDER, AMOUNT);
        address[4] memory callers = [owner, payer, merchant, stranger];
        for (uint256 i; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(TrustEscrow.NotOperator.selector);
            escrow.release(ORDER);
        }
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);
    }

    // --------------------------------------------------------------------- refund

    function test_Refund_ReturnsToPayerOnce() public {
        _pay(ORDER, AMOUNT);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit TrustEscrow.Refunded(ORDER, payer, AMOUNT);
        vm.prank(operator);
        escrow.refund(ORDER);

        assertEq(usdc.balanceOf(payer), PAYER_FUNDS);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        (, , TrustEscrow.State s) = escrow.held(ORDER);
        assertEq(uint8(s), uint8(TrustEscrow.State.Refunded));
    }

    function test_Refund_SecondRefundReverts() public {
        _pay(ORDER, AMOUNT);
        vm.startPrank(operator);
        escrow.refund(ORDER);
        vm.expectRevert(TrustEscrow.NotHeld.selector);
        escrow.refund(ORDER);
        vm.stopPrank();
        assertEq(usdc.balanceOf(payer), PAYER_FUNDS);
    }

    function test_Refund_UnknownOrderReverts() public {
        vm.prank(operator);
        vm.expectRevert(TrustEscrow.NotHeld.selector);
        escrow.refund(keccak256("unknown"));
    }

    function test_Refund_AfterReleaseReverts() public {
        _pay(ORDER, AMOUNT);
        vm.startPrank(operator);
        escrow.release(ORDER);
        vm.expectRevert(TrustEscrow.NotHeld.selector);
        escrow.refund(ORDER);
        vm.stopPrank();
        assertEq(usdc.balanceOf(payer), PAYER_FUNDS - AMOUNT);
    }

    function test_Refund_NonOperatorReverts() public {
        _pay(ORDER, AMOUNT);
        address[4] memory callers = [owner, payer, merchant, stranger];
        for (uint256 i; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(TrustEscrow.NotOperator.selector);
            escrow.refund(ORDER);
        }
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);
    }

    // ------------------------------------------------------------ admin functions

    function test_SetOperator_OnlyOwnerAndEmits() public {
        address newOp = makeAddr("newOperator");
        vm.expectEmit(false, false, false, true, address(escrow));
        emit TrustEscrow.OperatorUpdated(operator, newOp);
        vm.prank(owner);
        escrow.setOperator(newOp);
        assertEq(escrow.operator(), newOp);
    }

    function test_SetOperator_NonOwnerReverts() public {
        address[3] memory callers = [operator, payer, stranger];
        for (uint256 i; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, callers[i]));
            escrow.setOperator(stranger);
        }
        assertEq(escrow.operator(), operator);
    }

    function test_SetOperator_ZeroAddressReverts() public {
        vm.prank(owner);
        vm.expectRevert(TrustEscrow.ZeroAddress.selector);
        escrow.setOperator(address(0));
    }

    function test_SetMerchant_OnlyOwnerAndEmits() public {
        address newMerchant = makeAddr("newMerchant");
        vm.expectEmit(false, false, false, true, address(escrow));
        emit TrustEscrow.MerchantUpdated(merchant, newMerchant);
        vm.prank(owner);
        escrow.setMerchant(newMerchant);
        assertEq(escrow.merchant(), newMerchant);
    }

    function test_SetMerchant_NonOwnerReverts() public {
        address[3] memory callers = [operator, merchant, stranger];
        for (uint256 i; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, callers[i]));
            escrow.setMerchant(stranger);
        }
        assertEq(escrow.merchant(), merchant);
    }

    function test_SetMerchant_ZeroAddressReverts() public {
        vm.prank(owner);
        vm.expectRevert(TrustEscrow.ZeroAddress.selector);
        escrow.setMerchant(address(0));
    }

    function test_Release_PaysMerchantCurrentAtReleaseTime() public {
        address newMerchant = makeAddr("newMerchant");
        _pay(ORDER, AMOUNT); // paid while old merchant is current
        vm.prank(owner);
        escrow.setMerchant(newMerchant);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit TrustEscrow.Released(ORDER, newMerchant, AMOUNT);
        vm.prank(operator);
        escrow.release(ORDER);

        assertEq(usdc.balanceOf(newMerchant), AMOUNT);
        assertEq(usdc.balanceOf(merchant), 0);
    }

    function test_NewOperatorWorks_OldOperatorLosesAccess() public {
        address newOp = makeAddr("newOperator");
        assertTrue(newOp != operator);
        _pay(ORDER, AMOUNT);
        _pay(ORDER2, AMOUNT);
        vm.prank(owner);
        escrow.setOperator(newOp);

        vm.startPrank(operator);
        vm.expectRevert(TrustEscrow.NotOperator.selector);
        escrow.release(ORDER);
        vm.expectRevert(TrustEscrow.NotOperator.selector);
        escrow.refund(ORDER);
        vm.stopPrank();

        vm.startPrank(newOp);
        escrow.release(ORDER);
        escrow.refund(ORDER2);
        vm.stopPrank();

        assertEq(usdc.balanceOf(merchant), AMOUNT);
        assertEq(usdc.balanceOf(payer), PAYER_FUNDS - AMOUNT);
    }

    // ----------------------------------------------------------------------- fuzz

    /// PROPERTY: total tokens among {payer, escrow, merchant} is conserved, and the
    /// funds end at exactly the right place for each action.
    function testFuzz_ConservationOfFunds(uint256 amount, uint8 action, bytes32 id) public {
        amount = bound(amount, 1, PAYER_FUNDS);
        action = uint8(bound(action, 0, 2)); // 0 = hold, 1 = release, 2 = refund
        uint256 total = usdc.totalSupply();

        _pay(id, amount);
        assertEq(usdc.balanceOf(address(escrow)), amount);
        assertEq(usdc.balanceOf(payer), PAYER_FUNDS - amount);

        if (action == 1) {
            vm.prank(operator);
            escrow.release(id);
            assertEq(usdc.balanceOf(merchant), amount);
            assertEq(usdc.balanceOf(address(escrow)), 0);
        } else if (action == 2) {
            vm.prank(operator);
            escrow.refund(id);
            assertEq(usdc.balanceOf(payer), PAYER_FUNDS);
            assertEq(usdc.balanceOf(address(escrow)), 0);
        } else {
            assertEq(usdc.balanceOf(merchant), 0);
        }

        assertEq(
            usdc.balanceOf(payer) + usdc.balanceOf(address(escrow)) + usdc.balanceOf(merchant),
            total
        );
    }
}
