// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title TrustEscrow
/// @notice Holds USDC payments until the trusted operator releases or refunds them.
contract TrustEscrow is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice A required address is zero.
    error ZeroAddress();
    /// @notice The payment amount is zero.
    error ZeroAmount();
    /// @notice The order identifier has already been used.
    error OrderExists();
    /// @notice The caller is not the current operator.
    error NotOperator();
    /// @notice The order is not currently held in escrow.
    error NotHeld();
    /// @notice The payment authorization deadline has passed.
    error Expired();
    /// @notice The signature is malformed or was not signed by the current operator.
    error BadSignature();
    /// @notice The caller is not the order's original payer.
    error NotPayer();
    /// @notice The order's reclaim delay has not elapsed.
    error TooEarly();

    /// @notice Emitted when a payer funds an order.
    /// @param orderId The unique order identifier.
    /// @param payer The account that funded the order.
    /// @param amount The payment in USDC base units.
    event Paid(bytes32 indexed orderId, address indexed payer, uint256 amount);

    /// @notice Emitted when an order is released to the current merchant.
    /// @param orderId The order identifier.
    /// @param merchant The merchant that received the payment.
    /// @param amount The released amount in USDC base units.
    event Released(bytes32 indexed orderId, address indexed merchant, uint256 amount);

    /// @notice Emitted when an order is refunded to its original payer.
    /// @param orderId The order identifier.
    /// @param payer The original payer receiving the refund.
    /// @param amount The refunded amount in USDC base units.
    event Refunded(bytes32 indexed orderId, address indexed payer, uint256 amount);

    /// @notice Emitted when a payer reclaims a held order after the reclaim delay.
    /// @param orderId The order identifier.
    /// @param payer The original payer receiving the payment.
    /// @param amount The reclaimed amount in USDC base units.
    event Reclaimed(bytes32 indexed orderId, address indexed payer, uint256 amount);

    /// @notice Emitted when the trusted operator changes.
    /// @param oldOperator The previous operator.
    /// @param newOperator The new operator.
    event OperatorUpdated(address oldOperator, address newOperator);

    /// @notice Emitted when the merchant changes.
    /// @param oldMerchant The previous merchant.
    /// @param newMerchant The new merchant.
    event MerchantUpdated(address oldMerchant, address newMerchant);

    enum State { None, Held, Released, Refunded }

    struct Order {
        address payer;
        uint256 amount;
        State state;
        uint64 paidAt;
    }

    /// @notice The minimum time after payment before the payer can reclaim a held order.
    uint256 public constant RECLAIM_DELAY = 14 days;

    /// @notice The immutable USDC ERC-20 token used for payments.
    IERC20 public immutable usdc;
    /// @notice The current recipient of released payments.
    address public merchant;
    /// @notice The trusted account authorized to release or refund orders.
    address public operator;
    /// @notice Payment records keyed by unique order identifier.
    mapping(bytes32 => Order) public orders;

    /// @notice Restricts access to the current trusted operator.
    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    /// @notice Initializes the escrow with nonzero token and administrative addresses.
    /// @param usdc_ The USDC ERC-20 token (amounts use its base units).
    /// @param merchant_ The initial recipient of released payments.
    /// @param operator_ The initial trusted release and refund operator.
    /// @param owner_ The initial owner authorized to update merchant and operator.
    constructor(IERC20 usdc_, address merchant_, address operator_, address owner_)
        Ownable(_nonZero(owner_))
    {
        if (address(usdc_) == address(0) || merchant_ == address(0) || operator_ == address(0)) {
            revert ZeroAddress();
        }
        usdc = usdc_;
        merchant = merchant_;
        operator = operator_;
    }

    /// @notice Funds a previously unused order using the caller's USDC allowance and operator authorization.
    /// @dev The current operator must sign keccak256(abi.encode(block.chainid, address(this), orderId, amount, deadline))
    /// as an Ethereum signed message. The signature authorizes the exact amount.
    /// @param orderId The unique order identifier, which cannot be reused.
    /// @param amount The positive payment amount in USDC base units.
    /// @param deadline The last timestamp at which the authorization is valid, inclusive.
    /// @param signature The current operator's Ethereum signed message signature.
    function pay(bytes32 orderId, uint256 amount, uint256 deadline, bytes calldata signature) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (orders[orderId].state != State.None) revert OrderExists();
        if (block.timestamp > deadline) revert Expired();

        bytes32 digest = keccak256(abi.encode(block.chainid, address(this), orderId, amount, deadline));
        (address signer, ECDSA.RecoverError error, ) =
            ECDSA.tryRecover(MessageHashUtils.toEthSignedMessageHash(digest), signature);
        if (error != ECDSA.RecoverError.NoError || signer != operator) revert BadSignature();

        orders[orderId] = Order({
            payer: msg.sender,
            amount: amount,
            state: State.Held,
            paidAt: uint64(block.timestamp)
        });

        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit Paid(orderId, msg.sender, amount);
    }

    /// @notice Releases a held order to the merchant configured at release time.
    /// @param orderId The identifier of the held order to release.
    function release(bytes32 orderId) external onlyOperator nonReentrant {
        Order storage order = orders[orderId];
        if (order.state != State.Held) revert NotHeld();

        order.state = State.Released;
        address recipient = merchant;
        uint256 amount = order.amount;
        usdc.safeTransfer(recipient, amount);
        emit Released(orderId, recipient, amount);
    }

    /// @notice Refunds a held order to its original payer.
    /// @param orderId The identifier of the held order to refund.
    function refund(bytes32 orderId) external onlyOperator nonReentrant {
        Order storage order = orders[orderId];
        if (order.state != State.Held) revert NotHeld();

        order.state = State.Refunded;
        address payer = order.payer;
        uint256 amount = order.amount;
        usdc.safeTransfer(payer, amount);
        emit Refunded(orderId, payer, amount);
    }

    /// @notice Reclaims a held order for its original payer after the reclaim delay.
    /// @dev Requires Held state, the original payer as caller, and block.timestamp >= paidAt + RECLAIM_DELAY.
    /// Marks the order Refunded before transferring its payment back to the payer.
    /// @param orderId The identifier of the held order to reclaim.
    function reclaim(bytes32 orderId) external nonReentrant {
        Order storage order = orders[orderId];
        if (order.state != State.Held) revert NotHeld();
        if (msg.sender != order.payer) revert NotPayer();
        if (block.timestamp < uint256(order.paidAt) + RECLAIM_DELAY) revert TooEarly();

        order.state = State.Refunded;
        address payer = order.payer;
        uint256 amount = order.amount;
        usdc.safeTransfer(payer, amount);
        emit Reclaimed(orderId, payer, amount);
    }

    /// @notice Updates the trusted operator; callable only by the owner.
    /// @dev Changing the operator invalidates all outstanding signatures.
    /// @param newOperator The nonzero replacement operator.
    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert ZeroAddress();
        address oldOperator = operator;
        operator = newOperator;
        emit OperatorUpdated(oldOperator, newOperator);
    }

    /// @notice Updates the recipient for all future releases; callable only by the owner.
    /// @param newMerchant The nonzero replacement merchant.
    function setMerchant(address newMerchant) external onlyOwner {
        if (newMerchant == address(0)) revert ZeroAddress();
        address oldMerchant = merchant;
        merchant = newMerchant;
        emit MerchantUpdated(oldMerchant, newMerchant);
    }

    /// @notice Returns the payer, amount, and current state of an order.
    /// @param orderId The order identifier to look up.
    /// @return payer The original payer, or zero for an unused identifier.
    /// @return amount The payment in USDC base units.
    /// @return state The current order state.
    function held(bytes32 orderId) external view returns (address payer, uint256 amount, State state) {
        Order storage order = orders[orderId];
        return (order.payer, order.amount, order.state);
    }

    /// @dev Validates the initial owner before Ownable can emit its own zero-owner error.
    function _nonZero(address account) private pure returns (address) {
        if (account == address(0)) revert ZeroAddress();
        return account;
    }
}
