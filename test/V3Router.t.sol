// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {SementsulV3Factory, SementsulV3Pool} from "../contracts/SementsulV3.sol";
import {SementsulV3Router, ExactInputParams, ExactOutputParams} from "../contracts/SementsulV3Router.sol";
import {TickMath} from "../contracts/SementsulV3Math.sol";

contract RoutedToken {
    string public name = "T";
    string public symbol = "T";
    uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 a) external {
        totalSupply += a;
        balanceOf[to] += a;
        emit Transfer(address(0), to, a);
    }

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        emit Approval(msg.sender, s, v);
        return true;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        require(balanceOf[msg.sender] >= v, "BAL");
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        emit Transfer(msg.sender, to, v);
        return true;
    }

    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        uint256 a = allowance[f][msg.sender];
        if (a != type(uint256).max) {
            require(a >= v, "ALLOW");
            allowance[f][msg.sender] = a - v;
        }
        require(balanceOf[f] >= v, "BAL");
        balanceOf[f] -= v;
        balanceOf[to] += v;
        emit Transfer(f, to, v);
        return true;
    }
}

/// Роутер V3: то, без чего пулы не видны ни агрегаторам, ни ботам.
contract RouterTest is Test {
    SementsulV3Factory factory;
    SementsulV3Router router;
    RoutedToken tA;
    RoutedToken tB;
    RoutedToken tC;

    SementsulV3Pool poolAB;
    SementsulV3Pool poolBC;

    uint24 constant FEE = 500;
    int24 constant SPACING = 10;
    int24 constant LOWER = -6000;
    int24 constant UPPER = 6000;
    uint160 constant P = 79228162514264337593543950336; // 1:1

    address lp = address(0xAA);
    address user = address(0xC0);
    address wbnbStub = address(0xBEEF);

    function setUp() public {
        uint24[] memory fees = new uint24[](1);
        fees[0] = FEE;
        int24[] memory spacings = new int24[](1);
        spacings[0] = SPACING;
        factory = new SementsulV3Factory(fees, spacings, address(this));

        tA = new RoutedToken();
        tB = new RoutedToken();
        tC = new RoutedToken();

        // Упорядочиваем: пул требует token0 < token1.
        (RoutedToken lo, RoutedToken hi) = address(tA) < address(tB) ? (tA, tB) : (tB, tA);
        poolAB = SementsulV3Pool(factory.createPool(address(lo), address(hi), FEE));

        (RoutedToken lo2, RoutedToken hi2) = address(tB) < address(tC) ? (tB, tC) : (tC, tB);
        poolBC = SementsulV3Pool(factory.createPool(address(lo2), address(hi2), FEE));

        // Обе пары стартуют с цены 1:1.
        if (poolAB.slot0.selector == bytes4(0)) {} // заглушка не нужна
        poolAB.initializePrice(P);
        poolBC.initializePrice(P);

        _addLiquidity(poolAB, lo, hi);
        _addLiquidity(poolBC, lo2, hi2);

        router = new SementsulV3Router(address(factory), wbnbStub);

        RoutedToken[3] memory all = [tA, tB, tC];
        for (uint256 i = 0; i < 3; i++) {
            all[i].mint(user, 1e24);
            vm.startPrank(user);
            all[i].approve(address(router), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _addLiquidity(SementsulV3Pool pool, RoutedToken t0, RoutedToken t1) internal {
        t0.mint(lp, 1e27);
        t1.mint(lp, 1e27);
        vm.startPrank(lp);
        t0.approve(address(pool), type(uint256).max);
        t1.approve(address(pool), type(uint256).max);
        pool.mint(lp, LOWER, UPPER, 1e23);
        vm.stopPrank();
    }

    /// Упаковать маршрут: token(20) + fee(3) + token(20) + ...
    function _encodePath(address[] memory tokens, uint24[] memory fees) internal pure returns (bytes memory path) {
        require(tokens.length == fees.length + 1, "path len");
        path = abi.encodePacked(tokens[0]);
        for (uint256 i = 0; i < fees.length; i++) {
            path = abi.encodePacked(path, fees[i], tokens[i + 1]);
        }
    }

    /// 1. Главное: контракт может торговать через пул, не выдавая approve
    /// пулу. Платит роутер в callback'е. Именно этого не хватало агрегаторам.
    function test_exactInputSingle_paysViaCallback() public {
        address[] memory path = new address[](2);
        path[0] = address(tA);
        path[1] = address(tB);
        uint24[] memory fees = new uint24[](1);
        fees[0] = FEE;

        uint256 before = tB.balanceOf(user);

        vm.prank(user);
        uint256 out = router.exactInputSingle(
            ExactInputParams({path: _encodePath(path, fees), recipient: user, amountIn: 1e20, amountOutMinimum: 0}),
            block.timestamp + 100
        );

        assertGt(out, 0, "must receive output");
        assertEq(tB.balanceOf(user) - before, out, "output must reach the user");
    }

    /// 2. Мульти-хоп: A -> B -> C за одну транзакцию.
    ///
    /// Это и есть та форма, которой пользуются агрегаторы. Проверяем, что
    /// промежуточный пул отдаёт выход роутеру, и тот расплачивается им же.
    function test_exactInput_multiHop() public {
        address[] memory path = new address[](3);
        path[0] = address(tA);
        path[1] = address(tB);
        path[2] = address(tC);
        uint24[] memory fees = new uint24[](2);
        fees[0] = FEE;
        fees[1] = FEE;

        uint256 before = tC.balanceOf(user);

        vm.prank(user);
        uint256 out = router.exactInput(
            ExactInputParams({path: _encodePath(path, fees), recipient: user, amountIn: 1e20, amountOutMinimum: 0}),
            block.timestamp + 100
        );

        assertGt(out, 0, "multi-hop must produce output");
        assertEq(tC.balanceOf(user) - before, out, "final token must reach the user");
    }

    /// 3. Мульти-хоп даёт меньше, чем один хоп: платим комиссию дважды.
    function test_multiHop_costsMoreFees() public {
        address[] memory one = new address[](2);
        one[0] = address(tA);
        one[1] = address(tB);
        uint24[] memory f1 = new uint24[](1);
        f1[0] = FEE;

        vm.prank(user);
        uint256 singleOut = router.exactInputSingle(
            ExactInputParams({path: _encodePath(one, f1), recipient: user, amountIn: 1e20, amountOutMinimum: 0}),
            block.timestamp + 100
        );

        address[] memory two = new address[](3);
        two[0] = address(tA);
        two[1] = address(tB);
        two[2] = address(tC);
        uint24[] memory f2 = new uint24[](2);
        f2[0] = FEE;
        f2[1] = FEE;

        vm.prank(user);
        uint256 multiOut = router.exactInput(
            ExactInputParams({path: _encodePath(two, f2), recipient: user, amountIn: 1e20, amountOutMinimum: 0}),
            block.timestamp + 100
        );

        emit log_named_uint("single hop out", singleOut);
        emit log_named_uint("two hop out", multiOut);
        assertLt(multiOut, singleOut, "two hops must cost more in fees");
    }

    /// 4. amountOutMinimum работает: слишком высокий минимум откатывает.
    function test_exactInputSingle_revertsOnSlippage() public {
        address[] memory path = new address[](2);
        path[0] = address(tA);
        path[1] = address(tB);
        uint24[] memory fees = new uint24[](1);
        fees[0] = FEE;

        vm.prank(user);
        vm.expectRevert(bytes("SementsulRouter: TOO_LITTLE_RECEIVED"));
        router.exactInputSingle(
            ExactInputParams({
                path: _encodePath(path, fees),
                recipient: user,
                amountIn: 1e20,
                amountOutMinimum: 1e30 // невозможно много
            }),
            block.timestamp + 100
        );
    }

    /// 5. Дедлайн работает.
    function test_revertsAfterDeadline() public {
        address[] memory path = new address[](2);
        path[0] = address(tA);
        path[1] = address(tB);
        uint24[] memory fees = new uint24[](1);
        fees[0] = FEE;

        vm.warp(1000);
        vm.prank(user);
        vm.expectRevert(bytes("SementsulRouter: EXPIRED"));
        router.exactInputSingle(
            ExactInputParams({path: _encodePath(path, fees), recipient: user, amountIn: 1e20, amountOutMinimum: 0}),
            999
        );
    }

    /// 6. Точный выход: получаем РОВНО столько, сколько просили.
    function test_exactOutputSingle() public {
        address[] memory path = new address[](2);
        path[0] = address(tA);
        path[1] = address(tB);
        uint24[] memory fees = new uint24[](1);
        fees[0] = FEE;

        uint256 want = 5e18;
        uint256 before = tB.balanceOf(user);

        vm.prank(user);
        uint256 spent = router.exactOutputSingle(
            ExactOutputParams({
                path: _encodePath(path, fees),
                recipient: user,
                amountOut: want,
                amountInMaximum: 1e21
            }),
            block.timestamp + 100
        );

        assertEq(tB.balanceOf(user) - before, want, "must receive EXACTLY the requested amount");
        assertGt(spent, 0, "must spend something");
        emit log_named_uint("exact output: spent tokenIn", spent);
        emit log_named_uint("exact output: received tokenOut", want);
    }

    /// 7. Точный выход уважает верхнюю границу входа.
    function test_exactOutputSingle_revertsOnTooMuchIn() public {
        address[] memory path = new address[](2);
        path[0] = address(tA);
        path[1] = address(tB);
        uint24[] memory fees = new uint24[](1);
        fees[0] = FEE;

        vm.prank(user);
        vm.expectRevert(bytes("SementsulRouter: TOO_MUCH_REQUESTED"));
        router.exactOutputSingle(
            ExactOutputParams({
                path: _encodePath(path, fees),
                recipient: user,
                amountOut: 5e18,
                amountInMaximum: 1 // заведомо мало
            }),
            block.timestamp + 100
        );
    }

    /// 8. Роутер отказывается торговать несуществующий пул.
    function test_revertsOnUnknownPool() public {
        address[] memory path = new address[](2);
        path[0] = address(tA);
        path[1] = address(tC); // пары A/C нет
        uint24[] memory fees = new uint24[](1);
        fees[0] = FEE;

        vm.prank(user);
        vm.expectRevert(bytes("SementsulRouter: POOL_NOT_FOUND"));
        router.exactInputSingle(
            ExactInputParams({path: _encodePath(path, fees), recipient: user, amountIn: 1e20, amountOutMinimum: 0}),
            block.timestamp + 100
        );
    }

    /// 9. Роутер отказывается торговать пул с неверным тиром.
    function test_revertsOnWrongTier() public {
        address[] memory path = new address[](2);
        path[0] = address(tA);
        path[1] = address(tB);
        uint24[] memory fees = new uint24[](1);
        fees[0] = 3000; // такого тира у фабрики нет

        vm.prank(user);
        vm.expectRevert(bytes("SementsulRouter: POOL_NOT_FOUND"));
        router.exactInputSingle(
            ExactInputParams({path: _encodePath(path, fees), recipient: user, amountIn: 1e20, amountOutMinimum: 0}),
            block.timestamp + 100
        );
    }

    /// 10. Посторонний контракт не может дёрнуть callback роутера.
    function test_callbackRejectsStranger() public {
        vm.prank(address(0xDEAD));
        vm.expectRevert(bytes("SementsulRouter: BAD_POOL"));
        router.uniswapV3SwapCallback(1, 0, "");
    }

    /// 11. Без разрешения роутеру обмен падает целиком, а не наполовину.
    function test_revertsWithoutApproval() public {
        address[] memory path = new address[](2);
        path[0] = address(tA);
        path[1] = address(tB);
        uint24[] memory fees = new uint24[](1);
        fees[0] = FEE;

        address broke = address(0xBAD);
        tA.mint(broke, 1e20);
        // Разрешение не выдаём.

        vm.prank(broke);
        vm.expectRevert();
        router.exactInputSingle(
            ExactInputParams({path: _encodePath(path, fees), recipient: broke, amountIn: 1e20, amountOutMinimum: 0}),
            block.timestamp + 100
        );

        // Баланс не изменился: обмен откатился целиком.
        assertEq(tA.balanceOf(broke), 1e20, "no partial execution");
    }
}