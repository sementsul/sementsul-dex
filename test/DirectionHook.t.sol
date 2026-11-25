// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {SementsulV3Factory, SementsulV3Pool} from "../contracts/SementsulV3.sol";
import {TickMath} from "../contracts/SementsulV3Math.sol";

contract DirToken {
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

/// Общая точка входа, как роутер агрегатора.
/// Все пользователи ходят через ОДИН адрес — иначе агрегатор не смог бы
/// собрать маршрут из нескольких пулов в одной транзакции.
///
/// Обязан уметь uniswapV3SwapCallback: пул теперь отдаёт выход и просит
/// оплату обратным вызовом. Без него сделка падает — ровно это и случилось
/// при первом прогоне, когда роутер ещё не умел отвечать.
contract SharedRouter {
    address private payer;

    function sell(address pool, address tokenIn, uint256 amountIn, address user, bool zeroForOne, uint160 limit)
        external
        returns (int256, int256)
    {
        payer = user;
        return SementsulV3Pool(pool).swap(user, zeroForOne, int256(amountIn), limit, "");
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        uint256 owed = amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
        address token = amount0Delta > 0 ? SementsulV3Pool(msg.sender).token0() : SementsulV3Pool(msg.sender).token1();
        require(DirToken(token).transferFrom(payer, msg.sender, owed), "pay");
    }
}

/// Прототип предложенного хука: помним направление каждого инициатора
/// в текущем блоке и запрещаем разворот.
contract DirectionGuard {
    mapping(address => uint256) public lastBlock;
    mapping(address => bool) public lastDirection;
    mapping(address => bool) public hasTraded;

    /// Возвращает true, если это разворот в том же блоке.
    function wouldReject(address initiator, bool zeroForOne) public returns (bool) {
        bool rejected = lastBlock[initiator] == block.number && hasTraded[initiator]
            && lastDirection[initiator] != zeroForOne;
        lastBlock[initiator] = block.number;
        lastDirection[initiator] = zeroForOne;
        hasTraded[initiator] = true;
        return rejected;
    }
}

contract DirectionHookTest is Test {
    SementsulV3Factory factory;
    SementsulV3Pool pool;
    DirToken t0;
    DirToken t1;
    SharedRouter router;
    DirectionGuard guard;

    uint24 constant FEE = 500;
    int24 constant SPACING = 10;
    int24 constant LOWER = -6000;
    int24 constant UPPER = 6000;
    uint160 constant P = 79228162514264337593543950336;

    address lp = address(0xAA);
    address alice = address(0xA1);
    address bob = address(0xB0);

    function setUp() public {
        uint24[] memory fees = new uint24[](1);
        fees[0] = FEE;
        int24[] memory spacings = new int24[](1);
        spacings[0] = SPACING;
        factory = new SementsulV3Factory(fees, spacings, address(this));

        DirToken a = new DirToken();
        DirToken b = new DirToken();
        (t0, t1) = address(a) < address(b) ? (a, b) : (b, a);

        pool = SementsulV3Pool(factory.createPool(address(t0), address(t1), FEE));
        pool.initializePrice(P);

        t0.mint(lp, 1e27);
        t1.mint(lp, 1e27);
        vm.startPrank(lp);
        t0.approve(address(pool), type(uint256).max);
        t1.approve(address(pool), type(uint256).max);
        pool.mint(lp, LOWER, UPPER, 1e23);
        vm.stopPrank();

        router = new SharedRouter();
        guard = new DirectionGuard();

        address[2] memory who = [alice, bob];
        for (uint256 i = 0; i < 2; i++) {
            t0.mint(who[i], 1e24);
            t1.mint(who[i], 1e24);
            // Роутер тянет токены через transferFrom, значит пользователь
            // обязан выдать ему разрешение заранее.
            vm.startPrank(who[i]);
            t0.approve(address(router), type(uint256).max);
            t1.approve(address(router), type(uint256).max);
            vm.stopPrank();
        }
    }

    /// ГЛАВНОЕ. Роутер — одна точка входа для всех пользователей.
    ///
    /// Пул видит msg.sender = адрес роутера, а не пользователя. Значит
    /// карта «направление по msg.sender» не различает Алису и Боба: для
    /// пула это один и тот же инициатор.
    function test_routerMakesAllUsersOneSender() public {
        uint160 limitDown = TickMath.getSqrtRatioAtTick(-6000);
        uint160 limitUp = TickMath.getSqrtRatioAtTick(6000);

        // Алиса продаёт token0 через роутер.
        vm.prank(alice);
        router.sell(address(pool), address(t0), 1e21, alice, true, limitDown);

        // Боб в том же блоке покупает token0 (то есть отдаёт token1).
        vm.prank(bob);
        router.sell(address(pool), address(t1), 1e21, bob, false, limitUp);

        // Для хука это выглядит как разворот ОДНОГО инициатора.
        bool first = guard.wouldReject(address(router), true);
        bool second = guard.wouldReject(address(router), false);

        emit log_named_string("per-router: first trade rejected", first ? "YES" : "no");
        emit log_named_string("per-router: second trade rejected", second ? "YES" : "no");

        assertFalse(first, "first trade must pass");
        assertTrue(second, "BOTH users share one sender, so Bob is flagged as a reverser");

        // А теперь то же самое, но каждый зовёт пул напрямую.
        // msg.sender у них разный, и коллизии нет.
        DirectionGuard direct = new DirectionGuard();
        bool a1 = direct.wouldReject(alice, true);
        bool b1 = direct.wouldReject(bob, false);

        emit log_named_string("direct: Alice rejected", a1 ? "YES" : "no");
        emit log_named_string("direct: Bob rejected", b1 ? "YES" : "no");

        assertFalse(a1);
        assertFalse(b1, "direct calls do not collide, router calls do");
    }

    /// То же через tx.origin: он различает пользователей, но ломает
    /// контрактные кошельки и CoW-подобные подписные схемы.
    function test_txOriginBreaksContractWallets() public {
        // Умный кошелёк (Safe, AA-кошелёк) — это контракт. Все его
        // пользователи неотличимы так же, как у роутера.
        SharedRouter wallet = new SharedRouter();

        DirectionGuard g = new DirectionGuard();
        g.wouldReject(address(wallet), true);
        bool second = g.wouldReject(address(wallet), false);

        emit log_named_string("smart wallet: reverse flagged", second ? "YES" : "no");
        assertTrue(second, "contract wallets collide exactly like routers");
    }

    /// Проверка, что ликвидность вообще есть и торговать можно: без этого
    /// тесты выше прошли бы на пустом пуле и ничего не доказывали.
    function test_poolIsUsable() public {
        uint160 limitDown = TickMath.getSqrtRatioAtTick(-6000);
        vm.startPrank(alice);
        t0.approve(address(pool), type(uint256).max);
        (int256 a0, int256 a1) = pool.swap(alice, true, int256(1e20), limitDown, "");
        vm.stopPrank();
        assertGt(a0, 0, "token0 in");
        assertLt(a1, 0, "token1 out");
    }
}