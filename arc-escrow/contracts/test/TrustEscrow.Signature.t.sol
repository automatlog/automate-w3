// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TrustEscrow} from "../TrustEscrow.sol";
import {TrustEscrowBase} from "./TrustEscrow.Base.t.sol";

contract TrustEscrowSignatureTest is TrustEscrowBase {
    uint256 internal dl;

    function setUp() public override {
        super.setUp();
        vm.warp(1_700_000_000);
        dl = block.timestamp + 1 hours;
    }

    function _expectNotPaid(bytes32 id) internal view {
        (,, TrustEscrow.State s) = escrow.held(id);
        assertEq(uint8(s), uint8(TrustEscrow.State.None));
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_ValidSignaturePays() public {
        bytes memory sig = _sign(ORDER, AMOUNT, dl);
        vm.prank(payer);
        escrow.pay(ORDER, AMOUNT, dl, sig);
        (address p, uint256 a, TrustEscrow.State s) = escrow.held(ORDER);
        assertEq(p, payer);
        assertEq(a, AMOUNT);
        assertEq(uint8(s), uint8(TrustEscrow.State.Held));
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);
    }

    function test_AnyCallerCanSubmitOperatorSignature_PayerIsMsgSender() public {
        usdc.mint(stranger, AMOUNT);
        vm.prank(stranger);
        usdc.approve(address(escrow), AMOUNT);
        bytes memory sig = _sign(ORDER, AMOUNT, dl);
        vm.prank(stranger);
        escrow.pay(ORDER, AMOUNT, dl, sig);
        (address p,,) = escrow.held(ORDER);
        assertEq(p, stranger);
    }

    function test_WrongSignerReverts() public {
        (, uint256 badKey) = makeAddrAndKey("attacker");
        bytes memory sig = _signFor(badKey, block.chainid, address(escrow), ORDER, AMOUNT, dl);
        vm.prank(payer);
        vm.expectRevert(TrustEscrow.BadSignature.selector);
        escrow.pay(ORDER, AMOUNT, dl, sig);
        _expectNotPaid(ORDER);
    }

    function test_WrongAmountReverts() public {
        bytes memory sig = _sign(ORDER, AMOUNT, dl);
        vm.prank(payer);
        vm.expectRevert(TrustEscrow.BadSignature.selector);
        escrow.pay(ORDER, AMOUNT + 1, dl, sig);
        _expectNotPaid(ORDER);
    }

    function test_WrongOrderIdReverts() public {
        bytes memory sig = _sign(ORDER, AMOUNT, dl);
        vm.prank(payer);
        vm.expectRevert(TrustEscrow.BadSignature.selector);
        escrow.pay(ORDER2, AMOUNT, dl, sig);
        _expectNotPaid(ORDER2);
    }

    function test_WrongDeadlineReverts() public {
        bytes memory sig = _sign(ORDER, AMOUNT, dl);
        vm.prank(payer);
        vm.expectRevert(TrustEscrow.BadSignature.selector);
        escrow.pay(ORDER, AMOUNT, dl + 1, sig);
        _expectNotPaid(ORDER);
    }

    function test_SignatureForOtherChainIdReverts() public {
        uint256 originalChain = block.chainid;
        vm.chainId(originalChain + 1);
        bytes memory sig = _signFor(operatorKey, block.chainid, address(escrow), ORDER, AMOUNT, dl);
        vm.chainId(originalChain);
        vm.prank(payer);
        vm.expectRevert(TrustEscrow.BadSignature.selector);
        escrow.pay(ORDER, AMOUNT, dl, sig);
        _expectNotPaid(ORDER);
    }

    function test_SignatureForOtherChainIdReverts_WhenChainChangesAfterSigning() public {
        bytes memory sig = _sign(ORDER, AMOUNT, dl);
        vm.chainId(block.chainid + 1);
        vm.prank(payer);
        vm.expectRevert(TrustEscrow.BadSignature.selector);
        escrow.pay(ORDER, AMOUNT, dl, sig);
    }

    function test_SignatureForOtherContractReverts() public {
        bytes memory sig = _signFor(operatorKey, block.chainid, makeAddr("otherEscrow"), ORDER, AMOUNT, dl);
        vm.prank(payer);
        vm.expectRevert(TrustEscrow.BadSignature.selector);
        escrow.pay(ORDER, AMOUNT, dl, sig);
        _expectNotPaid(ORDER);
    }

    function test_SignatureNotValidOnSecondEscrowInstance() public {
        TrustEscrow other = new TrustEscrow(escrow.usdc(), merchant, operator, owner);
        vm.prank(payer);
        usdc.approve(address(other), type(uint256).max);
        bytes memory sig = _sign(ORDER, AMOUNT, dl); // signed for `escrow`
        vm.prank(payer);
        vm.expectRevert(TrustEscrow.BadSignature.selector);
        other.pay(ORDER, AMOUNT, dl, sig);
    }

    function test_EmptySignatureReverts() public {
        vm.prank(payer);
        vm.expectRevert(TrustEscrow.BadSignature.selector);
        escrow.pay(ORDER, AMOUNT, dl, "");
    }

    function test_MalformedSignatureReverts() public {
        vm.startPrank(payer);
        vm.expectRevert(TrustEscrow.BadSignature.selector);
        escrow.pay(ORDER, AMOUNT, dl, hex"1234");
        vm.expectRevert(TrustEscrow.BadSignature.selector);
        escrow.pay(ORDER, AMOUNT, dl, new bytes(65)); // all-zero 65 bytes
        bytes memory good = _sign(ORDER, AMOUNT, dl);
        bytes memory truncated = new bytes(64);
        for (uint256 i; i < 64; i++) truncated[i] = good[i];
        vm.expectRevert(TrustEscrow.BadSignature.selector);
        escrow.pay(ORDER, AMOUNT, dl, truncated);
        vm.stopPrank();
        _expectNotPaid(ORDER);
    }

    function test_ExpiredDeadlineReverts() public {
        uint256 past = block.timestamp - 1;
        bytes memory sig = _sign(ORDER, AMOUNT, past);
        vm.prank(payer);
        vm.expectRevert(TrustEscrow.Expired.selector);
        escrow.pay(ORDER, AMOUNT, past, sig);
    }

    function test_DeadlineElapsedAfterSigningReverts() public {
        bytes memory sig = _sign(ORDER, AMOUNT, dl);
        vm.warp(dl + 1);
        vm.prank(payer);
        vm.expectRevert(TrustEscrow.Expired.selector);
        escrow.pay(ORDER, AMOUNT, dl, sig);
    }

    function test_DeadlineEqualToTimestampStillWorks() public {
        uint256 d = block.timestamp;
        bytes memory sig = _sign(ORDER, AMOUNT, d);
        vm.prank(payer);
        escrow.pay(ORDER, AMOUNT, d, sig);
        (,, TrustEscrow.State s) = escrow.held(ORDER);
        assertEq(uint8(s), uint8(TrustEscrow.State.Held));
    }

    function test_SameSignatureCannotPayPaidOrderAgain() public {
        bytes memory sig = _sign(ORDER, AMOUNT, dl);
        vm.startPrank(payer);
        escrow.pay(ORDER, AMOUNT, dl, sig);
        vm.expectRevert(TrustEscrow.OrderExists.selector);
        escrow.pay(ORDER, AMOUNT, dl, sig);
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);
    }

    function test_SameSignatureCannotRepayAfterRelease() public {
        bytes memory sig = _sign(ORDER, AMOUNT, dl);
        vm.prank(payer);
        escrow.pay(ORDER, AMOUNT, dl, sig);
        vm.prank(operator);
        escrow.release(ORDER);
        vm.prank(payer);
        vm.expectRevert(TrustEscrow.OrderExists.selector);
        escrow.pay(ORDER, AMOUNT, dl, sig);
    }

    function test_AfterSetOperator_OldOperatorSignatureReverts() public {
        (address newOp, uint256 newKey) = makeAddrAndKey("newOperator");
        bytes memory oldSig = _sign(ORDER, AMOUNT, dl);
        vm.prank(owner);
        escrow.setOperator(newOp);

        vm.prank(payer);
        vm.expectRevert(TrustEscrow.BadSignature.selector);
        escrow.pay(ORDER, AMOUNT, dl, oldSig);

        // New operator's signature works.
        bytes memory newSig = _signFor(newKey, block.chainid, address(escrow), ORDER, AMOUNT, dl);
        vm.prank(payer);
        escrow.pay(ORDER, AMOUNT, dl, newSig);
        (,, TrustEscrow.State s) = escrow.held(ORDER);
        assertEq(uint8(s), uint8(TrustEscrow.State.Held));
    }

    /// PROPERTY: any amount not equal to the signed amount is rejected.
    function testFuzz_SignedAmountIsBinding(uint256 signed, uint256 submitted) public {
        signed = bound(signed, 1, PAYER_FUNDS);
        submitted = bound(submitted, 1, PAYER_FUNDS);
        vm.assume(signed != submitted);
        bytes memory sig = _sign(ORDER, signed, dl);
        vm.prank(payer);
        vm.expectRevert(TrustEscrow.BadSignature.selector);
        escrow.pay(ORDER, submitted, dl, sig);
    }
}
