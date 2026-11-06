// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface ISessionGate {
    function isTransferAllowed(uint256 sessionId, address to) external view returns (bool);
}

/// @title GameToken
/// @notice Plain ERC-20 used as an EIP-1167 clone template. One clone per token per game session.
/// Transfers are allowed only while the session is active and only to members of that session
/// (players and the session bank), so tokens of different sessions never mix.
contract GameToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;

    address public manager;
    uint256 public sessionId;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error AlreadyInitialized();
    error OnlyManager();
    error TransferNotAllowed();
    error InsufficientBalance();
    error InsufficientAllowance();

    /// @dev Locks the template itself so only clones can be initialized.
    constructor() {
        manager = address(1);
    }

    function initialize(string calldata name_, string calldata symbol_, uint256 sessionId_) external {
        if (manager != address(0)) revert AlreadyInitialized();
        manager = msg.sender;
        name = name_;
        symbol = symbol_;
        sessionId = sessionId_;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < value) revert InsufficientAllowance();
            unchecked {
                allowance[from][msg.sender] = allowed - value;
            }
        }
        _transfer(from, to, value);
        return true;
    }

    function mint(address to, uint256 value) external {
        if (msg.sender != manager) revert OnlyManager();
        totalSupply += value;
        unchecked {
            balanceOf[to] += value;
        }
        emit Transfer(address(0), to, value);
    }

    function _transfer(address from, address to, uint256 value) internal {
        if (!ISessionGate(manager).isTransferAllowed(sessionId, to)) revert TransferNotAllowed();
        uint256 bal = balanceOf[from];
        if (bal < value) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = bal - value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }
}
