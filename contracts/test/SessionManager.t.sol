// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SessionManager} from "../src/SessionManager.sol";
import {GameToken} from "../src/GameToken.sol";

contract SessionManagerTest is Test {
    SessionManager manager;
    address operator = makeAddr("operator");
    address bank = makeAddr("bank");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address outsider = makeAddr("outsider");

    uint256 constant SID = 1;
    uint256 constant USDG = 7; // index of the stablecoin in the list below

    function setUp() public {
        manager = new SessionManager(operator);
    }

    function _create(uint256 sid) internal returns (address[] memory tokens) {
        string[] memory names = new string[](8);
        string[] memory symbols = new string[](8);
        uint256[] memory reserves = new uint256[](8);
        string[8] memory n = ["Bitkoin", "Etherion", "BinaCoin", "Solanix", "Ripplex", "Monera", "Daix", "Game Dollar"];
        string[8] memory s = ["BTK", "ETR", "BNC", "SLN", "XRL", "MNR", "DAX", "USDG"];
        for (uint256 i; i < 8; ++i) {
            names[i] = n[i];
            symbols[i] = s[i];
            reserves[i] = 1_000_000 ether;
        }
        vm.prank(operator);
        tokens = manager.createSession(sid, bank, names, symbols, reserves);
    }

    function _players() internal view returns (address[] memory p) {
        p = new address[](2);
        p[0] = alice;
        p[1] = bob;
    }

    function test_createSession_deploysEightClonesAndFundsBank() public {
        address[] memory tokens = _create(SID);
        assertEq(tokens.length, 8);
        assertEq(GameToken(tokens[0]).symbol(), "BTK");
        assertEq(GameToken(tokens[USDG]).balanceOf(bank), 1_000_000 ether);
        assertEq(tokens[3], manager.predictToken(SID, 3));
        (SessionManager.State state, address b,) = manager.getSession(SID);
        assertEq(uint256(state), uint256(SessionManager.State.Active));
        assertEq(b, bank);
    }

    function test_createSession_onlyOperator() public {
        string[] memory e = new string[](0);
        vm.expectRevert(SessionManager.OnlyOperator.selector);
        manager.createSession(SID, bank, e, e, new uint256[](0));
    }

    function test_createSession_twiceReverts() public {
        _create(SID);
        string[] memory e = new string[](0);
        vm.prank(operator);
        vm.expectRevert(SessionManager.SessionExists.selector);
        manager.createSession(SID, bank, e, e, new uint256[](0));
    }

    function test_addPlayers_mintsStartBalanceOnce() public {
        address[] memory tokens = _create(SID);
        vm.startPrank(operator);
        manager.addPlayers(SID, _players(), USDG, 1500 ether);
        manager.addPlayers(SID, _players(), USDG, 1500 ether); // repeated join must not double-mint
        vm.stopPrank();
        assertEq(GameToken(tokens[USDG]).balanceOf(alice), 1500 ether);
        assertTrue(manager.isMember(SID, bob));
    }

    function test_transfers_betweenPlayersAndBank() public {
        address[] memory tokens = _create(SID);
        vm.prank(operator);
        manager.addPlayers(SID, _players(), USDG, 1500 ether);
        GameToken usdg = GameToken(tokens[USDG]);

        vm.prank(alice);
        usdg.transfer(bob, 200 ether);
        vm.prank(bob);
        usdg.transfer(bank, 100 ether);
        vm.prank(bank);
        GameToken(tokens[0]).transfer(alice, 0.005 ether);

        assertEq(usdg.balanceOf(alice), 1300 ether);
        assertEq(usdg.balanceOf(bob), 1600 ether);
        assertEq(GameToken(tokens[0]).balanceOf(alice), 0.005 ether);
    }

    function test_transfer_toOutsiderReverts() public {
        address[] memory tokens = _create(SID);
        vm.prank(operator);
        manager.addPlayers(SID, _players(), USDG, 1500 ether);
        vm.prank(alice);
        vm.expectRevert(GameToken.TransferNotAllowed.selector);
        GameToken(tokens[USDG]).transfer(outsider, 1 ether);
    }

    function test_transfer_toPlayerOfAnotherSessionReverts() public {
        address[] memory t1 = _create(1);
        _create(2);
        address[] memory onlyAlice = new address[](1);
        onlyAlice[0] = alice;
        address[] memory onlyBob = new address[](1);
        onlyBob[0] = bob;
        vm.startPrank(operator);
        manager.addPlayers(1, onlyAlice, USDG, 1500 ether);
        manager.addPlayers(2, onlyBob, USDG, 1500 ether);
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert(GameToken.TransferNotAllowed.selector);
        GameToken(t1[USDG]).transfer(bob, 1 ether);
    }

    function test_stopSession_freezesAllTokens() public {
        address[] memory tokens = _create(SID);
        vm.startPrank(operator);
        manager.addPlayers(SID, _players(), USDG, 1500 ether);
        manager.stopSession(SID);
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert(GameToken.TransferNotAllowed.selector);
        GameToken(tokens[USDG]).transfer(bob, 1 ether);
        vm.prank(operator);
        vm.expectRevert(SessionManager.SessionNotActive.selector);
        manager.addPlayers(SID, _players(), USDG, 1 ether);
    }

    function test_transferFrom_respectsAllowance() public {
        address[] memory tokens = _create(SID);
        vm.prank(operator);
        manager.addPlayers(SID, _players(), USDG, 1500 ether);
        GameToken usdg = GameToken(tokens[USDG]);
        vm.prank(alice);
        usdg.approve(bob, 50 ether);
        vm.startPrank(bob);
        usdg.transferFrom(alice, bob, 50 ether);
        vm.expectRevert(GameToken.InsufficientAllowance.selector);
        usdg.transferFrom(alice, bob, 1);
        vm.stopPrank();
    }

    function test_clone_cannotBeReinitialized() public {
        address[] memory tokens = _create(SID);
        vm.expectRevert(GameToken.AlreadyInitialized.selector);
        GameToken(tokens[0]).initialize("X", "X", 99);
        GameToken impl = GameToken(manager.tokenImplementation());
        vm.expectRevert(GameToken.AlreadyInitialized.selector);
        impl.initialize("X", "X", 99);
    }

    function test_mint_onlyToMembers() public {
        _create(SID);
        address[] memory to = new address[](1);
        to[0] = outsider;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1 ether;
        vm.prank(operator);
        vm.expectRevert(SessionManager.NotMember.selector);
        manager.mint(SID, USDG, to, amounts);
    }

    function test_gas_createSession() public {
        uint256 g = gasleft();
        _create(SID);
        emit log_named_uint("createSession gas", g - gasleft());
    }
}
