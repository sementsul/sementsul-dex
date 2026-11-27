// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {SementsulV3Factory, SementsulV3Pool} from "../contracts/SementsulV3.sol";
import {SementsulV3Quoter} from "../contracts/SementsulV3Quoter.sol";
import {SementsulSwapRouter, ExactInputSingleParams, ExactInputParamsStd, ExactOutputSingleParams, ExactOutputParamsStd} from "../contracts/SementsulSwapRouter.sol";
import {SementsulPoolViewAdapter, TickInfoStd} from "../contracts/SementsulPoolViewAdapter.sol";
import {SementsulV3Router, ExactInputParams} from "../contracts/SementsulV3Router.sol";

contract QtToken {
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

/// Квотер, роутер со стандартным ABI и адаптер.
///
/// Что здесь важно проверить, помимо очевидного:
///   • квотер даёт ТУ ЖЕ цифру, что реальный обмен. Если расходится —
///     агрегатор построит маршрут по несуществующей цене;
///   • селекторы роутера совпадают с Uniswap. Это единственная причина,
///     по которой он вообще нужен;
///   • адаптер не подделывает TWAP: observe обязан откатываться.
contract QuoterRouterAdapterTest is Test {
    SementsulV3Factory factory;
    SementsulV3Quoter quoter;
    SementsulSwapRouter newRouter;
    SementsulV3Router oldRouter;
    SementsulPoolViewAdapter adapter;

    QtToken tA;
    QtToken tB;
    QtToken tC;

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

        tA = new QtToken();
        tB = new QtToken();
        tC = new QtToken();

        (QtToken lo, QtToken hi) = address(tA) < address(tB) ? (tA, tB) : (tB, tA);
        poolAB = SementsulV3Pool(factory.createPool(address(lo), address(hi), FEE));

        (QtToken lo2, QtToken hi2) = address(tB) < address(tC) ? (tB, tC) : (tC, tB);
        poolBC = SementsulV3Pool(factory.createPool(address(lo2), address(hi2), FEE));

        poolAB.initializePrice(P);
        poolBC.initializePrice(P);

        _addLiquidity(poolAB, lo, hi);
        _addLiquidity(poolBC, lo2, hi2);

        quoter = new SementsulV3Quoter(address(factory), wbnbStub);
        newRouter = new SementsulSwapRouter(address(factory), wbnbStub);
        oldRouter = new SementsulV3Router(address(factory), wbnbStub);
        adapter = new SementsulPoolViewAdapter(address(poolAB));

        QtToken[3] memory all = [tA, tB, tC];
        for (uint256 i = 0; i < 3; i++) {
            all[i].mint(user, 1e24);
            vm.startPrank(user);
            all[i].approve(address(newRouter), type(uint256).max);
            all[i].approve(address(oldRouter), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _addLiquidity(SementsulV3Pool pool, QtToken t0, QtToken t1) internal {
        t0.mint(lp, 1e27);
        t1.mint(lp, 1e27);
        vm.startPrank(lp);
        t0.approve(address(pool), type(uint256).max);
        t1.approve(address(pool), type(uint256).max);
        pool.mint(lp, LOWER, UPPER, 1e23);
        vm.stopPrank();
    }

    function _encodePath(address[] memory tokens, uint24[] memory fees) internal pure returns (bytes memory path) {
        require(tokens.length == fees.length + 1, "path len");
        path = abi.encodePacked(tokens[0]);
        for (uint256 i = 0; i < fees.length; i++) {
            path = abi.encodePacked(path, fees[i], tokens[i + 1]);
        }
    }

    function _singlePath(address a, address b) internal pure returns (bytes memory) {
        address[] memory tokens = new address[](2);
        tokens[0] = a;
        tokens[1] = b;
        uint24[] memory fees = new uint24[](1);
        fees[0] = FEE;
        return _encodePath(tokens, fees);
    }

    // ==================== СЕЛЕКТОРЫ ====================

    /// Главное, ради чего затевался роутер: селекторы должны совпасть
    /// с Uniswap. Иначе агрегатор к нам не обратится.
    /// Значения взяты из самих сигнатур Uniswap V3 SwapRouter.
    function test_routerSelectorsMatchUniswap() public pure {
        assertEq(SementsulSwapRouter.exactInputSingle.selector, bytes4(0x414bf389), "exactInputSingle");
        assertEq(SementsulSwapRouter.exactInput.selector, bytes4(0xc04b8d59), "exactInput");
        assertEq(SementsulSwapRouter.exactOutputSingle.selector, bytes4(0xdb3e2198), "exactOutputSingle");
        assertEq(SementsulSwapRouter.exactOutput.selector, bytes4(0xf28c0498), "exactOutput");
        assertEq(SementsulSwapRouter.multicall.selector, bytes4(0xac9650d8), "multicall");
        assertEq(SementsulSwapRouter.uniswapV3SwapCallback.selector, bytes4(0xfa461e33), "callback");
    }

    /// Квотер тоже должен совпасть: агрегаторы зовут его по стандартным
    /// сигнатурам.
    function test_quoterSelectorsMatchUniswap() public pure {
        assertEq(SementsulV3Quoter.quoteExactInput.selector, bytes4(0xcdca1753), "quoteExactInput");
        assertEq(SementsulV3Quoter.quoteExactInputSingle.selector, bytes4(0xf7729d43), "quoteExactInputSingle");
        assertEq(SementsulV3Quoter.quoteExactOutput.selector, bytes4(0x2f80bb1d), "quoteExactOutput");
        assertEq(SementsulV3Quoter.quoteExactOutputSingle.selector, bytes4(0x30d07f21), "quoteExactOutputSingle");
    }

    // ==================== КВОТЕР ====================

    /// Ключевая проверка: квотер не врёт.
    /// Сравниваем его ответ с реальным исполнением того же обмена.
    function testFuzz_quoterMatchesActualSwap(uint96 amountIn) public {
        amountIn = uint96(_safeAmount(bound(amountIn, 1e9, 1e20)));

        uint256 quoted = quoter.quoteExactInputSingle(address(tA), address(tB), FEE, amountIn, 0);

        // Теперь исполняем ровно тот же обмен.
        uint256 balBefore = tB.balanceOf(user);
        vm.prank(user);
        newRouter.exactInputSingle(
            ExactInputSingleParams({
                tokenIn: address(tA),
                tokenOut: address(tB),
                fee: FEE,
                recipient: user,
                deadline: block.timestamp,
                amountIn: amountIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        uint256 actual = tB.balanceOf(user) - balBefore;

        // Допуск в 1 wei: квотер считает через swap, но порядок округления
        // в самом пуле может дать единицу разницы на границе.
        assertApproxEqAbs(quoted, actual, 1, "quoter must match actual");
    }

    /// Квотер по маршруту из двух пулов.
    function testFuzz_quoterMultiHop(uint96 amountIn) public {
        amountIn = uint96(_safeAmount(bound(amountIn, 1e9, 1e18)));

        bytes memory path = _encodePath(
            _addr3(address(tA), address(tB), address(tC)),
            _fees2()
        );

        uint256 quoted = quoter.quoteExactInput(path, amountIn);
        assertGt(quoted, 0, "quote must be positive");
    }

    /// Точный выход: сколько нужно отдать.
    function testFuzz_quoterExactOutput(uint96 amountOut) public {
        amountOut = uint96(_safeAmount(bound(amountOut, 1e9, 1e18)));

        uint256 quotedIn = quoter.quoteExactOutputSingle(address(tA), address(tB), FEE, amountOut, 0);
        assertGt(quotedIn, 0, "quote must be positive");

        // Исполняем и проверяем, что потратили столько же.
        uint256 balBefore = tA.balanceOf(user);
        vm.prank(user);
        newRouter.exactOutputSingle(
            ExactOutputSingleParams({
                tokenIn: address(tA),
                tokenOut: address(tB),
                fee: FEE,
                recipient: user,
                deadline: block.timestamp,
                amountOut: amountOut,
                amountInMaximum: type(uint256).max,
                sqrtPriceLimitX96: 0
            })
        );
        uint256 actualIn = balBefore - tA.balanceOf(user);

        assertApproxEqAbs(quotedIn, actualIn, 2, "exactOutput quote must match");
    }

    /// Квотер не должен принимать чужой пул: доверять переданному адресу
    /// нельзя.
    function test_quoterRejectsUnknownPool() public {
        vm.expectRevert();
        quoter.quoteExactInputSingle(address(tA), address(tC), 3000, 1e18, 0);
    }

    /// Монотонность: больше на входе — не меньше на выходе.
    /// Это fuzz-инвариант, который ловит арифметические ошибки.
    function testFuzz_quoteIsMonotonic(uint96 a, uint96 b) public {
        a = uint96(_safeAmount(bound(a, 1e9, 1e17)));
        b = uint96(_safeAmount(bound(b, a + 1, 1e17)));

        uint256 qa = quoter.quoteExactInputSingle(address(tA), address(tB), FEE, a, 0);
        uint256 qb = quoter.quoteExactInputSingle(address(tA), address(tB), FEE, b, 0);

        assertGe(qb, qa, "more in must not give less out");
    }

    /// Квотер ничего не меняет в пуле: после расчёта состояние то же.
    function test_quoteDoesNotChangePoolState() public {
        (uint160 p0, int24 t0, uint128 l0,,) = poolAB.slot0();
        uint256 f0 = poolAB.feeGrowthGlobal0X128();
        uint256 f1 = poolAB.feeGrowthGlobal1X128();

        quoter.quoteExactInputSingle(address(tA), address(tB), FEE, 1e18, 0);

        (uint160 p1, int24 t1, uint128 l1,,) = poolAB.slot0();
        assertEq(p0, p1, "price changed");
        assertEq(t0, t1, "tick changed");
        assertEq(l0, l1, "liquidity changed");
        assertEq(f0, poolAB.feeGrowthGlobal0X128(), "feeGrowth0 changed");
        assertEq(f1, poolAB.feeGrowthGlobal1X128(), "feeGrowth1 changed");
    }

    // ==================== НОВЫЙ РОУТЕР ====================

    /// Обмен через новый роутер работает так же, как через старый.
    function test_newRouter_exactInputSingle() public {
        uint256 before = tB.balanceOf(user);
        vm.prank(user);
        uint256 out = newRouter.exactInputSingle(
            ExactInputSingleParams({
                tokenIn: address(tA),
                tokenOut: address(tB),
                fee: FEE,
                recipient: user,
                deadline: block.timestamp,
                amountIn: 1e18,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        assertGt(out, 0, "no output");
        assertEq(tB.balanceOf(user) - before, out, "balance mismatch");
    }

    /// Старый роутер продолжает работать: мы ничего не сломали.
    function test_oldRouterStillWorks() public {
        address[] memory path = new address[](2);
        path[0] = address(tA);
        path[1] = address(tB);
        uint24[] memory fees = new uint24[](1);
        fees[0] = FEE;

        vm.prank(user);
        uint256 out = oldRouter.exactInput(
            ExactInputParams({
                path: _encodePath(path, fees),
                recipient: user,
                amountIn: 1e18,
                amountOutMinimum: 0
            }),
            block.timestamp
        );
        assertGt(out, 0, "old router broke");
    }

    /// Слиппедж: если выход меньше минимума — откат.
    function test_newRouter_slippageProtection() public {
        vm.prank(user);
        vm.expectRevert(bytes("SementsulRouter: TOO_LITTLE_RECEIVED"));
        newRouter.exactInputSingle(
            ExactInputSingleParams({
                tokenIn: address(tA),
                tokenOut: address(tB),
                fee: FEE,
                recipient: user,
                deadline: block.timestamp,
                amountIn: 1e18,
                amountOutMinimum: 1e30,
                sqrtPriceLimitX96: 0
            })
        );
    }

    /// Дедлайн истёк — откат.
    function test_newRouter_deadlineExpired() public {
        vm.warp(1000);
        vm.prank(user);
        vm.expectRevert(bytes("SementsulRouter: EXPIRED"));
        newRouter.exactInputSingle(
            ExactInputSingleParams({
                tokenIn: address(tA),
                tokenOut: address(tB),
                fee: FEE,
                recipient: user,
                deadline: 999,
                amountIn: 1e18,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
    }

    /// Мультихоп через новый роутер.
    function test_newRouter_multihop() public {
        bytes memory path = _encodePath(_addr3(address(tA), address(tB), address(tC)), _fees2());

        vm.prank(user);
        uint256 out = newRouter.exactInput(
            ExactInputParamsStd({
                path: path,
                recipient: user,
                deadline: block.timestamp,
                amountIn: 1e18,
                amountOutMinimum: 0
            })
        );
        assertGt(out, 0, "multihop failed");
    }

    /// Чужой пул не пройдёт: проверка isPool обязательна, иначе через нас
    /// можно подсунуть контракт, который заберёт деньги.
    function test_newRouter_rejectsForeignPool() public {
        vm.prank(user);
        vm.expectRevert(bytes("SementsulRouter: POOL_NOT_FOUND"));
        newRouter.exactInputSingle(
            ExactInputSingleParams({
                tokenIn: address(tA),
                tokenOut: address(tC),
                fee: 3000, // такого тира нет
                recipient: user,
                deadline: block.timestamp,
                amountIn: 1e18,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
    }

    /// Один и тот же токен с обеих сторон — откат с внятной причиной,
    /// иначе пул искался бы сам с собой.
    function test_newRouter_rejectsSameToken() public {
        vm.prank(user);
        vm.expectRevert(bytes("SementsulRouter: SAME_TOKEN"));
        newRouter.exactInputSingle(
            ExactInputSingleParams({
                tokenIn: address(tA),
                tokenOut: address(tA),
                fee: FEE,
                recipient: user,
                deadline: block.timestamp,
                amountIn: 1e18,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
    }

    /// Оба роутера видят ОДИН И ТОТ ЖЕ пул: ликвидность не переносится,
    /// потому что она в пуле, а не в роутере.
    function test_bothRoutersSamePool() public {
        assertEq(newRouter.FACTORY(), address(factory));
        assertEq(oldRouter.FACTORY(), address(factory));
        assertEq(factory.getPool(address(tA) < address(tB) ? address(tA) : address(tB), address(tA) < address(tB) ? address(tB) : address(tA), FEE), address(poolAB));
    }

    /// Мультиколл: несколько действий одной транзакцией.
    function test_newRouter_multicall() public {
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeWithSelector(
            SementsulSwapRouter.exactInputSingle.selector,
            ExactInputSingleParams({
                tokenIn: address(tA),
                tokenOut: address(tB),
                fee: FEE,
                recipient: user,
                deadline: block.timestamp,
                amountIn: 1e18,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );

        vm.prank(user);
        bytes[] memory results = newRouter.multicall(calls);
        assertEq(results.length, 1, "multicall failed");
    }

    // ==================== АДАПТЕР ====================

    /// Адаптер отдаёт 7 полей, как Uniswap, и числа верные.
    function test_adapter_slot0Layout() public {
        (
            uint160 sp,
            int24 tk,
            uint16 oi,
            uint16 oc,
            uint16 ocn,
            uint32 fp,
            bool unlocked
        ) = adapter.slot0();

        (uint160 realSp, int24 realTick, uint128 realLiq,,) = poolAB.slot0();

        assertEq(sp, realSp, "price mismatch");
        assertEq(tk, realTick, "tick mismatch");
        assertGt(realLiq, 0, "pool must have liquidity");

        // Нули честные: наблюдений нет, протокольной комиссии нет.
        assertEq(oi, 0, "observationIndex");
        assertEq(oc, 0, "observationCardinality");
        assertEq(ocn, 0, "observationCardinalityNext");
        assertEq(fp, 0, "feeProtocol");
        assertTrue(unlocked, "pool is not globally locked");
    }

    /// Адаптер отдаёт 8 полей тика, как Uniswap.
    function test_adapter_ticksLayout() public {
        TickInfoStd memory ti = adapter.ticks(LOWER);
        assertTrue(ti.initialized, "tick must be initialized");
        assertGt(ti.liquidityGross, 0, "gross must be positive");
        assertGt(ti.liquidityNet, 0, "net must be positive at lower bound");
    }

    /// КЛЮЧЕВОЕ: адаптер не подделывает TWAP. observe обязан откатываться.
    /// Если этот тест когда-нибудь упадёт — значит кто-то сделал вид, что
    /// оракул есть, и на этом построят убыточную стратегию.
    function test_adapter_observeReverts() public {
        uint32[] memory ago = new uint32[](1);
        ago[0] = 0;
        vm.expectRevert(bytes("SementsulAdapter: NO_ORACLE"));
        adapter.observe(ago);
    }

    function test_adapter_increaseCardinalityReverts() public {
        vm.expectRevert(bytes("SementsulAdapter: NO_ORACLE"));
        adapter.increaseObservationCardinalityNext(10);
    }

    function test_adapter_snapshotReverts() public {
        vm.expectRevert(bytes("SementsulAdapter: NO_ORACLE"));
        adapter.snapshotCumulativesInside(LOWER, UPPER);
    }

    /// Прозрачные прокси отдают то же, что пул.
    function test_adapter_passthrough() public {
        assertEq(adapter.token0(), poolAB.token0(), "token0");
        assertEq(adapter.token1(), poolAB.token1(), "token1");
        assertEq(adapter.fee(), poolAB.fee(), "fee");
        assertEq(adapter.tickSpacing(), poolAB.tickSpacing(), "spacing");
        assertEq(adapter.liquidity(), poolAB.liquidity(), "liquidity");
        assertEq(adapter.factory(), poolAB.factory(), "factory");
    }

    /// Адаптер привязан к одному пулу и не даёт подсунуть другой.
    function test_adapter_pinnedToPool() public {
        assertEq(adapter.POOL(), address(poolAB), "adapter must be pinned");
        vm.expectRevert();
        new SementsulPoolViewAdapter(address(0));
    }

    /// @dev Округлить сумму вниз до кратного 1e6 wei.
    ///
    /// Зачем. В пуле есть дефект: если после шага обмена остаётся ровно
    /// 1 wei, цикл while не завершается — цена не сдвигается, остаток не
    /// убывает, вызов съедает весь газ. Подтверждено на задеплоенном пуле:
    /// 1e18+1 и 10e18+1 падают, 1e18 и 1e18+2 проходят.
    ///
    /// Пул неизменяем, поэтому дефект не чинится здесь. Тесты новых
    /// контрактов гоняем на суммах, которые в эту щель не попадают,
    /// и отдельным тестом ниже фиксируем сам дефект.
    function _safeAmount(uint256 a) internal pure returns (uint256) {
        return (a / 1e6) * 1e6;
    }

    /// Дефект пула: сумма с остатком 1 wei зацикливает swap.
    ///
    /// Тест ограничивает газ, поэтому зависание превращается в обычный
    /// реверт — иначе forge не смог бы его завершить. Это и есть
    /// наблюдаемое поведение: транзакция съедает весь газ и откатывается.
    function test_poolDustAmountHangsSwap() public {
        // Сначала убеждаемся, что «нормальная» сумма проходит.
        vm.prank(user);
        uint256 out = newRouter.exactInputSingle(
            ExactInputSingleParams({
                tokenIn: address(tA),
                tokenOut: address(tB),
                fee: FEE,
                recipient: user,
                deadline: block.timestamp,
                amountIn: 1e18,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        assertGt(out, 0, "normal amount must work");

        // Теперь сумма с остатком 1 wei. Ожидаем, что вызов не завершится
        // нормально: он упрётся в газ.
        vm.prank(user);
        (bool ok,) = address(newRouter).call{gas: 800_000}(
            abi.encodeWithSelector(
                SementsulSwapRouter.exactInputSingle.selector,
                ExactInputSingleParams({
                    tokenIn: address(tA),
                    tokenOut: address(tB),
                    fee: FEE,
                    recipient: user,
                    deadline: block.timestamp,
                    amountIn: 1e18 + 1,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                })
            )
        );

        // Дефект существует, пока ok == false. Если когда-нибудь пул
        // переделают и это начнёт проходить — тест упадёт, и это будет
        // поводом перечитать документацию, а не поводом радоваться.
        assertFalse(ok, "KNOWN DEFECT: dust amount (x+1 wei) must hang");
    }

    // ==================== ВСПОМОГАТЕЛЬНОЕ ====================

    function _addr3(address a, address b, address c) internal pure returns (address[] memory r) {
        r = new address[](3);
        r[0] = a;
        r[1] = b;
        r[2] = c;
    }

    function _fees2() internal pure returns (uint24[] memory r) {
        r = new uint24[](2);
        r[0] = FEE;
        r[1] = FEE;
    }
}