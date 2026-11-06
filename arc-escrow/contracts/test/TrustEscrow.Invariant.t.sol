// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TrustEscrow} from "../TrustEscrow.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {MockUSDC6} from "./TrustEscrow.Base.t.sol";

/// @dev Drives random pay/release/refund/reclaim sequences for the invariant.
contract TrustEscrowHandler is Test {
    TrustEscrow public escrow;
    MockUSDC6 public usdc;
    address public operator;
    uint256 public operatorKey;
    address public payer;

    bytes32[] public ids;
    uint256 public nonce;

    constructor(TrustEscrow _escrow, MockUSDC6 _usdc, address _operator, uint256 _operatorKey, address _payer) {
        escrow = _escrow;
        usdc = _usdc;
        operator = _operator;
        operatorKey = _operatorKey;
        payer = _payer;
    }

    function idsLength() external view returns (uint256) {
        return ids.length;
    }

    function pay(uint256 amount) external {
        amount = bound(amount, 1, 1_000e6);
        bytes32 id = keccak256(abi.encode(nonce++));
        usdc.mint(payer, amount);
        uint256 dl = block.timestamp + 1 hours;
        bytes32 digest = keccak256(abi.encode(block.chainid, address(escrow), id, amount, dl));
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(operatorKey, MessageHashUtils.toEthSignedMessageHash(digest));
        bytes memory sig = abi.encodePacked(r, sg, v);
        vm.startPrank(payer);
        usdc.approve(address(escrow), amount);
        escrow.pay(id, amount, dl, sig);
        vm.stopPrank();
        ids.push(id);
    }

    function release(uint256 seed) external {
        if (ids.length == 0) return;
        vm.prank(operator);
        try escrow.release(ids[seed % ids.length]) {} catch {}
    }

    function refund(uint256 seed) external {
        if (ids.length == 0) return;
        vm.prank(operator);
        try escrow.refund(ids[seed % ids.length]) {} catch {}
    }

    function reclaim(uint256 seed, uint256 elapsed) external {
        if (ids.length == 0) return;
        vm.warp(block.timestamp + bound(elapsed, 0, 30 days));
        vm.prank(payer);
        try escrow.reclaim(ids[seed % ids.length]) {} catch {}
    }
}

contract TrustEscrowInvariantTest is Test {
    TrustEscrow internal escrow;
    MockUSDC6 internal usdc;
    TrustEscrowHandler internal handler;

    function setUp() public {
        (address operator, uint256 operatorKey) = makeAddrAndKey("operator");
        usdc = new MockUSDC6();
        escrow = new TrustEscrow(usdc, makeAddr("merchant"), operator, makeAddr("owner"));
        handler = new TrustEscrowHandler(escrow, usdc, operator, operatorKey, makeAddr("payer"));
        targetContract(address(handler));
    }

    /// PROPERTY: escrow's token balance always equals the sum of orders still Held.
    function invariant_EscrowBalanceEqualsHeldOrders() public view {
        uint256 sumHeld;
        uint256 n = handler.idsLength();
        for (uint256 i; i < n; i++) {
            (, uint256 amount, TrustEscrow.State s) = escrow.held(handler.ids(i));
            if (s == TrustEscrow.State.Held) sumHeld += amount;
        }
        assertEq(usdc.balanceOf(address(escrow)), sumHeld);
    }
}
