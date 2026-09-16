// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { UniswapV3SwapRouter02Adapter } from "../src/UniswapV3SwapRouter02Adapter.sol";
import { IUniswapV3SwapRouter02 } from "../src/interfaces/IUniswapV3SwapRouter02.sol";
import { MockERC20 } from "./mocks/Mocks.sol";
import { Test } from "forge-std/Test.sol";

contract AuditDexFactory {
    address public pool;

    function setPool(address value) external {
        pool = value;
    }

    function feeAmountTickSpacing(uint24) external pure returns (int24) {
        return 10;
    }

    function getPool(address, address, uint24) external view returns (address) {
        return pool;
    }
}

contract AuditPool {
    address public immutable factory;
    address public immutable token0;
    address public immutable token1;
    uint24 public constant fee = 500;

    constructor(address f, address a, address b) {
        factory = f;
        token0 = a;
        token1 = b;
    }
}

contract AuditRouter {
    address public immutable factory;
    uint256 public mode;
    bool public reentrySucceeded;

    constructor(address f) {
        factory = f;
    }

    function setMode(uint256 value) external {
        mode = value;
    }

    function exactInput(IUniswapV3SwapRouter02.ExactInputParams calldata p)
        external
        payable
        returns (uint256 result)
    {
        address input = address(bytes20(p.path[:20]));
        address output = address(bytes20(p.path[23:43]));
        if (mode == 4) {
            (reentrySucceeded,) = msg.sender
                .call(
                    abi.encodeWithSignature(
                        "swap(address,address,uint256,uint256,address)",
                        input,
                        output,
                        p.amountIn,
                        1,
                        p.recipient
                    )
                );
        }
        if (mode != 2) {
            MockERC20(input)
                .transferFrom(msg.sender, address(this), mode == 3 ? p.amountIn / 2 : p.amountIn);
        }
        MockERC20(output).mint(p.recipient, p.amountIn);
        return mode == 1 ? p.amountIn + 1 : p.amountIn;
    }
}

contract SwapAdapterSecurityTest is Test {
    address constant A = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant B = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    AuditDexFactory factory;
    AuditRouter router;
    UniswapV3SwapRouter02Adapter adapter;

    function setUp() public {
        MockERC20 implementation = new MockERC20("Asset", "ASSET", 8);
        vm.etch(A, address(implementation).code);
        vm.etch(B, address(implementation).code);
        factory = new AuditDexFactory();
        router = new AuditRouter(address(factory));
        AuditPool pool = new AuditPool(address(factory), A, B);
        factory.setPool(address(pool));
        UniswapV3SwapRouter02Adapter.Route[] memory routes =
            new UniswapV3SwapRouter02Adapter.Route[](1);
        routes[0] = UniswapV3SwapRouter02Adapter.Route(A, B, 500, address(pool));
        adapter = new UniswapV3SwapRouter02Adapter(
            address(factory), address(router), address(router), routes
        );
        MockERC20(A).mint(alice, 100e8);
        vm.prank(alice);
        MockERC20(A).approve(address(adapter), 100e8);
    }

    function test_audit_adapterClearsApprovalsAndCannotSpendDonations() public {
        MockERC20(A).mint(address(adapter), 50e8);
        MockERC20(B).mint(address(adapter), 40e8);
        vm.prank(alice);
        assertEq(adapter.swap(A, B, 10e8, 10e8, alice), 10e8);
        assertEq(MockERC20(A).balanceOf(address(adapter)), 50e8);
        assertEq(MockERC20(B).balanceOf(address(adapter)), 40e8);
        assertEq(MockERC20(A).allowance(address(adapter), address(router)), 0);
    }

    function testFuzz_audit_adapterRejectsDishonestSettlement(uint256 mode) public {
        mode = bound(mode, 1, 3);
        router.setMode(mode);
        vm.prank(alice);
        vm.expectRevert();
        adapter.swap(A, B, 10e8, 10e8, alice);
        assertEq(MockERC20(A).balanceOf(alice), 100e8);
        assertEq(MockERC20(B).balanceOf(alice), 0);
        assertEq(MockERC20(A).allowance(address(adapter), address(router)), 0);
    }

    function test_audit_adapterBlocksRouterReentry() public {
        router.setMode(4);
        vm.prank(alice);
        adapter.swap(A, B, 10e8, 10e8, alice);
        assertFalse(router.reentrySucceeded());
    }

    function test_audit_adapterCannotUseAnotherWalletApproval() public {
        vm.prank(bob);
        vm.expectRevert();
        adapter.swap(A, B, 10e8, 1, bob);
        assertEq(MockERC20(A).balanceOf(alice), 100e8);
    }

    function test_audit_adapterRejectsSentinelAndStrandingRecipients() public {
        address[4] memory recipients = [address(1), address(2), address(adapter), address(router)];
        for (uint256 i; i < recipients.length; ++i) {
            vm.prank(alice);
            vm.expectRevert(UniswapV3SwapRouter02Adapter.InvalidSwap.selector);
            adapter.swap(A, B, 10e8, 1, recipients[i]);
        }
    }
}
