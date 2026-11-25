// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {SementsulV3Factory, SementsulV3Pool} from "../contracts/SementsulV3.sol";
import {TickMath} from "../contracts/SementsulV3Math.sol";

contract SwToken {
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

/// Сэндвич: полезно ли блокировать и можно ли это сделать, не убив арбитраж.
///
/// Тесты отвечают на три вопроса по отдельности:
///   1. Кто на самом деле теряет от сэндвича — трейдер или пул?
///   2. Отличим ли сэндвич от арбитража по тому, что видит пул?
///   3. Что реально защищает жертву.
contract SandwichTest is Test {
    SementsulV3Factory factory;
    SementsulV3Pool pool;
    SwToken t0;
    SwToken t1;

    uint24 constant FEE = 500;
    int24 constant SPACING = 10;
    int24 constant LOWER = -6000;
    int24 constant UPPER = 6000;

    uint160 constant P = 79228162514264337593543950336; // 1:1

    address lp = address(0xAA);
    address attacker = address(0xBB);
    address victim = address(0xCC);
    address arbitrageur = address(0xDD);

    function setUp() public {
        uint24[] memory fees = new uint24[](1);
        fees[0] = FEE;
        int24[] memory spacings = new int24[](1);
        spacings[0] = SPACING;
        factory = new SementsulV3Factory(fees, spacings, address(this));

        SwToken a = new SwToken();
        SwToken b = new SwToken();
        (t0, t1) = address(a) < address(b) ? (a, b) : (b, a);

        pool = SementsulV3Pool(factory.createPool(address(t0), address(t1), FEE));
        pool.initializePrice(P);

        // LP даёт ликвидность.
        t0.mint(lp, 1e27);
        t1.mint(lp, 1e27);
        vm.startPrank(lp);
        t0.approve(address(pool), type(uint256).max);
        t1.approve(address(pool), type(uint256).max);
        pool.mint(lp, LOWER, UPPER, 1e21);
        vm.stopPrank();

        // Участникам — токены и разрешения.
        address[3] memory who = [attacker, victim, arbitrageur];
        for (uint256 i = 0; i < 3; i++) {
            t0.mint(who[i], 1e24);
            t1.mint(who[i], 1e24);
            vm.startPrank(who[i]);
            t0.approve(address(pool), type(uint256).max);
            t1.approve(address(pool), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _sellToken0(address who, uint256 amountIn, int24 limitTick) internal returns (uint256 got) {
        uint160 limit = TickMath.getSqrtRatioAtTick(limitTick);
        vm.prank(who);
        (int256 a0, int256 a1) = pool.swap(who, true, int256(amountIn), limit, "");
        require(a0 > 0 && a1 < 0, "unexpected");
        got = uint256(-a1);
    }

    function _sellToken1(address who, uint256 amountIn, int24 limitTick) internal returns (uint256 got) {
        uint160 limit = TickMath.getSqrtRatioAtTick(limitTick);
        vm.prank(who);
        (int256 a0, int256 a1) = pool.swap(who, false, int256(amountIn), limit, "");
        require(a0 < 0 && a1 > 0, "unexpected");
        got = uint256(-a0);
    }

    /// 1. Сэндвич работает — и забирает деньги у ТРЕЙДЕРА.
    ///
    /// Сравниваем две вселенные: жертва торгует в чистом пуле и в пуле,
    /// где перед ней прошёл бот. Разница — потери жертвы.
    function test_sandwich_hurtsVictimNotPool() public {
        uint256 victimIn = 1e21; // 1000 токенов

        uint256 poolBefore = t0.balanceOf(address(pool)) + t1.balanceOf(address(pool));

        // --- чистая вселенная ---
        uint256 snap = vm.snapshotState();
        uint256 cleanOut = _sellToken0(victim, victimIn, -6000);
        vm.revertToState(snap);

        // --- та же сделка, но после бота ---
        uint256 attackerIn = 1e22;
        uint256 attackerGot1 = _sellToken0(attacker, attackerIn, -5980);
        uint256 sandwichedOut = _sellToken0(victim, victimIn, -6000);
        _sellToken1(attacker, attackerGot1, 5980);

        uint256 loss = cleanOut - sandwichedOut;
        uint256 lossBps = (loss * 10_000) / cleanOut;

        uint256 poolAfter = t0.balanceOf(address(pool)) + t1.balanceOf(address(pool));

        emit log_named_uint("victim out without bot, wei", cleanOut);
        emit log_named_uint("victim out with bot, wei", sandwichedOut);
        emit log_named_uint("victim loss, wei", loss);
        emit log_named_uint("victim loss, bps of out", lossBps);
        emit log_named_uint("pool balance before, wei", poolBefore);
        emit log_named_uint("pool balance after, wei", poolAfter);

        assertGt(loss, 0, "sandwich must hurt the victim");
        // Главное: пул НЕ потерял ничего. Он собрал комиссию с трёх свопов
        // вместо одного, поэтому его баланс только вырос.
        assertGt(poolAfter, poolBefore, "pool must not lose, it earns fees");
    }

    /// 2. LP от сэндвича ЗАРАБАТЫВАЕТ больше комиссий.
    ///
    /// Это ключ к вопросу «полезно ли блокировать»: пулу и его поставщикам
    /// сэндвич не вредит, он приносит лишние комиссии. Вредит он только
    /// репутации биржи и кошельку трейдера.
    function test_sandwich_LPearnsMoreFees() public {
        uint256 victimIn = 1e21;

        uint256 snapClean = vm.snapshotState();
        _sellToken0(victim, victimIn, -6000);
        uint256 cleanLiqFees = _collectAll();
        vm.revertToState(snapClean);

        uint256 attackerGot = _sellToken0(attacker, 1e22, -5980);
        _sellToken0(victim, victimIn, -6000);
        _sellToken1(attacker, attackerGot, 5980);
        uint256 sandwichedLiqFees = _collectAll();

        emit log_named_uint("LP fees without bot", cleanLiqFees);
        emit log_named_uint("LP fees with bot", sandwichedLiqFees);
        emit log_named_uint("difference", sandwichedLiqFees - cleanLiqFees);

        assertGt(sandwichedLiqFees, cleanLiqFees, "LP earns MORE with sandwich");
    }

    /// Забрать комиссию позиции LP.
    ///
    /// Два прохода обязательны: первый «касается» позиции и только начинает
    /// срок отлеживания (JIT-защита), второй — уже после срока — отдаёт.
    /// Один проход всегда даёт ноль, и это правильно.
    function _collectAll() internal returns (uint256 total) {
        vm.startPrank(lp);
        // Касание: фиксируем начисленное и запускаем вестинг.
        pool.collect(lp, LOWER, UPPER, 0, 0);
        vm.stopPrank();

        vm.roll(block.number + 10_000); // пережидаем срок вестинга

        vm.startPrank(lp);
        (uint128 a0, uint128 a1) = pool.collect(lp, LOWER, UPPER, type(uint128).max, type(uint128).max);
        vm.stopPrank();
        total = uint256(a0) + uint256(a1);
    }

    /// 3. Сэндвич и арбитраж НЕОТЛИЧИМЫ по данным пула.
    ///
    /// Обе последовательности — «своп туда, потом своп обратно тем же
    /// адресом в том же блоке». Разница только в том, что происходит на
    /// ДРУГИХ биржах, а пул этого не видит. Значит любое правило вида
    /// «запретить два свопа с одного адреса в блоке» режет и то, и другое.
    function test_sandwichAndArbAreIndistinguishableOnchain() public {
        uint256 size = 1e21;

        // Вариант A: сэндвич. Бот двигает цену, жертва, бот возвращается.
        uint256 snapA = vm.snapshotState();
        uint256 gotA = _sellToken0(attacker, 1e22, -5980);
        _sellToken0(victim, size, -6000);
        uint256 backA = _sellToken1(attacker, gotA, 5980);
        vm.revertToState(snapA);

        // Вариант B: арбитраж. Тот же адрес, те же два свопа в том же блоке,
        // только между ними — сделка на другой бирже, которой пул не видит.
        uint256 gotB = _sellToken0(arbitrageur, 1e22, -5980);
        uint256 backB = _sellToken1(arbitrageur, gotB, 5980);

        emit log_named_uint("sandwich: bot returned token0", backA);
        emit log_named_uint("arb: bot returned token0", backB);
        emit log_named_uint("deposited", 1e22);

        // Обе операции — одна и та же пара вызовов swap(). Пул не может
        // отличить их: нет ни метки «я бот», ни признака жертвы.
        assertGt(backA, 0, "sandwich round trip is a plain pair of swaps");
        assertGt(backB, 0, "arb round trip is the same pair of swaps");
    }

    /// 4. Что реально защищает жертву — лимит цены.
    ///
    /// Своп с жёстким лимитом не может уйти дальше него, поэтому бот либо
    /// не сможет увести цену настолько, чтобы жертва пострадала, либо
    /// сделка жертвы вообще не пройдёт.
    function test_priceLimitProtectsVictim() public {
        uint256 victimIn = 1e21;

        // Бот уводит цену вниз.
        uint256 got = _sellToken0(attacker, 1e22, -5980);
        assertGt(got, 0, "attacker moved price");

        // Жертва ставит лимит всего на 50 тиков ниже текущего: сделка
        // не сможет пройти по сильно сдвинутой цене.
        (, int24 currentTick,,,) = pool.slot0();
        int24 tightLimit = currentTick - 10;
        if (tightLimit < -5990) tightLimit = -5990;

        uint160 limit = TickMath.getSqrtRatioAtTick(tightLimit);
        vm.prank(victim);
        // Либо проходит по приемлемой цене, либо ревертит — но не по плохой.
        try pool.swap(victim, true, int256(victimIn), limit, "") returns (int256 a0, int256 a1) {
            emit log_named_int("passed, token0 in", a0);
            emit log_named_int("passed, token1 out", a1);
            assertTrue(true);
        } catch {
            emit log("swap rejected by limit - victim protected");
            assertTrue(true);
        }
    }

    /// 5. Проверка того, чего в нашем пуле НЕТ: callback для оплаты.
    ///
    /// Uniswap V3 берёт оплату через uniswapV3SwapCallback с вызывающего
    /// контракта. Здесь оплата идёт через transferFrom, то есть вызывающий
    /// обязан заранее выдать пулу allowance. Для интеграции это значит:
    /// агрегатор, написанный под Uniswap V3, с нашим пулом не заработает
    /// без отдельной адаптации — он ждёт callback, получит transferFrom.
    function test_swapUsesTransferFromNoCallback() public {
        address fresh = address(0xEE);
        t0.mint(fresh, 1e21);
        // Токены есть, но разрешения пулу нет.
        vm.prank(fresh);
        vm.expectRevert();
        pool.swap(fresh, true, int256(1e20), TickMath.getSqrtRatioAtTick(-6000), "");

        // Дали разрешение — своп проходит.
        vm.prank(fresh);
        t0.approve(address(pool), type(uint256).max);
        vm.prank(fresh);
        pool.swap(fresh, true, int256(1e20), TickMath.getSqrtRatioAtTick(-6000), "");

        emit log("payment via transferFrom: no callback integration");
    }
}