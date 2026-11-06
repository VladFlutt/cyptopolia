// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {GameToken, ISessionGate} from "./GameToken.sol";

/// @title SessionManager
/// @notice Factory and registry of game sessions. Deployed once per network.
/// Only the operator (the backend) can create sessions, register players, mint and stop.
contract SessionManager is ISessionGate {
    enum State {
        None,
        Active,
        Stopped
    }

    struct Session {
        State state;
        address bank;
        address[] tokens;
    }

    address public immutable tokenImplementation;
    address public operator;

    mapping(uint256 => Session) private sessions;
    mapping(uint256 => mapping(address => bool)) public isMember;

    event OperatorChanged(address indexed operator);
    event SessionCreated(uint256 indexed sessionId, address indexed bank, address[] tokens);
    event PlayerAdded(uint256 indexed sessionId, address indexed player);
    event SessionStopped(uint256 indexed sessionId);

    error OnlyOperator();
    error SessionExists();
    error SessionNotActive();
    error LengthMismatch();
    error BadTokenIndex();
    error NotMember();

    modifier onlyOperator() {
        if (msg.sender != operator) revert OnlyOperator();
        _;
    }

    constructor(address operator_) {
        tokenImplementation = address(new GameToken());
        operator = operator_;
        emit OperatorChanged(operator_);
    }

    function setOperator(address operator_) external onlyOperator {
        operator = operator_;
        emit OperatorChanged(operator_);
    }

    /// @notice Creates the session's tokens as clones and mints each token's reserve to the bank.
    function createSession(
        uint256 sessionId,
        address bank,
        string[] calldata names,
        string[] calldata symbols,
        uint256[] calldata bankReserves
    ) external onlyOperator returns (address[] memory tokens) {
        Session storage s = sessions[sessionId];
        if (s.state != State.None) revert SessionExists();
        uint256 n = names.length;
        if (symbols.length != n || bankReserves.length != n) revert LengthMismatch();

        s.state = State.Active;
        s.bank = bank;
        isMember[sessionId][bank] = true;

        tokens = new address[](n);
        for (uint256 i; i < n; ++i) {
            tokens[i] = _deployToken(sessionId, i, names[i], symbols[i]);
            if (bankReserves[i] > 0) GameToken(tokens[i]).mint(bank, bankReserves[i]);
        }
        s.tokens = tokens;
        emit SessionCreated(sessionId, bank, tokens);
    }

    function _deployToken(uint256 sessionId, uint256 index, string calldata name_, string calldata symbol_)
        private
        returns (address t)
    {
        t = Clones.cloneDeterministic(tokenImplementation, keccak256(abi.encode(sessionId, index)));
        GameToken(t).initialize(name_, symbol_, sessionId);
    }

    /// @notice Registers players and mints their starting balance of one token (the stablecoin).
    function addPlayers(uint256 sessionId, address[] calldata players, uint256 tokenIndex, uint256 startAmount)
        external
        onlyOperator
    {
        Session storage s = sessions[sessionId];
        if (s.state != State.Active) revert SessionNotActive();
        if (tokenIndex >= s.tokens.length) revert BadTokenIndex();
        GameToken token = GameToken(s.tokens[tokenIndex]);
        for (uint256 i; i < players.length; ++i) {
            address p = players[i];
            if (isMember[sessionId][p]) continue;
            isMember[sessionId][p] = true;
            emit PlayerAdded(sessionId, p);
            if (startAmount > 0) token.mint(p, startAmount);
        }
    }

    /// @notice Extra minting by the host (e.g. topping up the bank). Recipients must be members.
    function mint(uint256 sessionId, uint256 tokenIndex, address[] calldata to, uint256[] calldata amounts)
        external
        onlyOperator
    {
        Session storage s = sessions[sessionId];
        if (s.state != State.Active) revert SessionNotActive();
        if (tokenIndex >= s.tokens.length) revert BadTokenIndex();
        if (to.length != amounts.length) revert LengthMismatch();
        GameToken token = GameToken(s.tokens[tokenIndex]);
        for (uint256 i; i < to.length; ++i) {
            if (!isMember[sessionId][to[i]]) revert NotMember();
            token.mint(to[i], amounts[i]);
        }
    }

    /// @notice Freezes every token of the session in one write.
    function stopSession(uint256 sessionId) external onlyOperator {
        Session storage s = sessions[sessionId];
        if (s.state != State.Active) revert SessionNotActive();
        s.state = State.Stopped;
        emit SessionStopped(sessionId);
    }

    function isTransferAllowed(uint256 sessionId, address to) external view returns (bool) {
        return sessions[sessionId].state == State.Active && isMember[sessionId][to];
    }

    function getSession(uint256 sessionId) external view returns (State state, address bank, address[] memory tokens) {
        Session storage s = sessions[sessionId];
        return (s.state, s.bank, s.tokens);
    }

    function predictToken(uint256 sessionId, uint256 index) external view returns (address) {
        return Clones.predictDeterministicAddress(tokenImplementation, keccak256(abi.encode(sessionId, index)));
    }
}
