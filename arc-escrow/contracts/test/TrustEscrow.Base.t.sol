// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {TrustEscrow} from "../TrustEscrow.sol";

/// @dev Minimal 6-decimal mock USDC.
contract MockUSDC6 is ERC20 {
    constructor() ERC20("Mock USDC", "mUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Shared fixture: actors, operator key, signing helpers. No tests here.
abstract contract TrustEscrowBase is Test {
    TrustEscrow internal escrow;
    MockUSDC6 internal usdc;

    address internal owner = makeAddr("owner");
    address internal merchant = makeAddr("merchant");
    address internal operator;
    uint256 internal operatorKey;
    address internal payer = makeAddr("payer");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant ORDER = keccak256("order-1");
    bytes32 internal constant ORDER2 = keccak256("order-2");
    uint256 internal constant AMOUNT = 100e6;
    uint256 internal constant PAYER_FUNDS = 1_000e6;

    function setUp() public virtual {
        (operator, operatorKey) = makeAddrAndKey("operator");
        usdc = new MockUSDC6();
        escrow = new TrustEscrow(IERC20(address(usdc)), merchant, operator, owner);
        usdc.mint(payer, PAYER_FUNDS);
        vm.prank(payer);
        usdc.approve(address(escrow), type(uint256).max);
    }

    /// @dev Signs the documented digest as an Ethereum signed message with explicit fields.
    function _signFor(
        uint256 pk,
        uint256 chainId,
        address verifying,
        bytes32 id,
        uint256 amount,
        uint256 deadline
    ) internal pure returns (bytes memory) {
        bytes32 digest = keccak256(abi.encode(chainId, verifying, id, amount, deadline));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, MessageHashUtils.toEthSignedMessageHash(digest));
        return abi.encodePacked(r, s, v);
    }

    /// @dev Valid operator signature for the deployed escrow on the current chain.
    function _sign(bytes32 id, uint256 amount, uint256 deadline) internal view returns (bytes memory) {
        return _signFor(operatorKey, block.chainid, address(escrow), id, amount, deadline);
    }

    function _deadline() internal view returns (uint256) {
        return block.timestamp + 1 hours;
    }

    /// @dev Pays with a freshly signed valid authorization, as `payer`.
    function _pay(bytes32 id, uint256 amount) internal {
        bytes memory sig = _sign(id, amount, _deadline());
        vm.prank(payer);
        escrow.pay(id, amount, _deadline(), sig);
    }
}
