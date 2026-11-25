// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {SementsulV3Factory, SementsulV3Pool} from "../contracts/SementsulV3.sol";

contract JitToken {
    string public name = "J";
    string public symbol = "J";
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

/// Замер доли комиссий, которую забирает JIT-бот.
///
/// JIT (just-in-time) — бот, который вливает большую ликвидность прямо перед
/// чужим свопом и убирает её сразу после. Комиссии делятся пропорционально
/// ликвидности в момент свопа, поэтому бот забирает почти всё, не неся риска.
///
/// Стенд воспроизводит это: честный LP стоит в пуле заранее, бот входит перед
/// свопом и выходит сразу после. Считаем, какая доля комиссий ушла боту.
///
/// Размер бота — 10× от честного LP. Именно из этого отношения получается
/// наблюдавшаяся доля 10/11 = 90.9%: бот зарабатывает не потому, что он
/// «умнее», а потому что его ликвидность в момент свопа больше.
contract JitTest is Test {
    uint160 constant P = 79228162514264337593543950336; // цена 1:1
    int24 constant SPACING = 10;
    int24 constant LOWER = -6000;
    int24 constant UPPER = 6000;
    uint24 constant FEE = 500;

    address honest = address(0x600D);
    address jit = address(0xBAD);
    address trader = address(0x7AD);

    struct Stand {
        SementsulV3Factory factory;
        SementsulV3Pool pool;
        JitToken t0;
        JitToken t1;
    }

    /// Свежий стенд на каждый прогон: токены уникальны, поэтому фабрика не
    /// упирается в POOL_EXISTS, а состояния прогонов не смешиваются.
    function _deploy() internal returns (Stand memory s) {
        uint24[] memory fees = new uint24[](1);
        fees[0] = FEE;
        int24[] memory spacings = new int24[](1);
        spacings[0] = SPACING;
        s.factory = new SementsulV3Factory(fees, spacings, address(this));
        s.t0 = new JitToken();
        s.t1 = new JitToken();
        if (address(s.t0) > address(s.t1)) (s.t0, s.t1) = (s.t1, s.t0);

        s.pool = SementsulV3Pool(s.factory.createPool(address(s.t0), address(s.t1), FEE));
        s.pool.initializePrice(P);

        address[3] memory who = [honest, jit, trader];
        for (uint256 i = 0; i < 3; i++) {
            s.t0.mint(who[i], 1e31);
            s.t1.mint(who[i], 1e31);
            vm.startPrank(who[i]);
            s.t0.approve(address(s.pool), type(uint256).max);
            s.t1.approve(address(s.pool), type(uint256).max);
            vm.stopPrank();
        }
    }

    /// Один прогон: честный LP + JIT-бот + своп.
    /// delay — сколько блоков комиссия должна отлежаться (0 = без защиты).
    function _run(uint64 delay) internal returns (uint256 honestFees, uint256 jitFees) {
        Stand memory s = _deploy();
        s.factory.setJitDelayBlocks(FEE, delay);

        uint128 honestLiq = 1e21;
        uint128 jitLiq = 1e22; // 10x — как у реального JIT-бота

        // Честный LP входит заранее и остаётся.
        vm.prank(honest);
        s.pool.mint(honest, LOWER, UPPER, honestLiq);
        vm.roll(block.number + 5);

        // JIT-бот входит прямо перед свопом.
        vm.prank(jit);
        s.pool.mint(jit, LOWER, UPPER, jitLiq);

        // Своп, на котором бот зарабатывает.
        vm.prank(trader);
        s.pool.swap(trader, true, int256(1e20), P / 10 * 9, "");

        // Бот выходит сразу после свопа и пытается забрать комиссию.
        vm.prank(jit);
        s.pool.burn(LOWER, UPPER, jitLiq);
        vm.prank(jit);
        (uint128 j0,) = s.pool.collect(jit, LOWER, UPPER, type(uint128).max, type(uint128).max);

        // Честный LP забирает своё. При включённом вестинге комиссия сначала
        // попадает в pending, поэтому нужен второй заход после срока.
        if (delay > 0) {
            vm.prank(honest);
            s.pool.collect(honest, LOWER, UPPER, type(uint128).max, type(uint128).max);
            vm.roll(block.number + delay + 1);
        }
        vm.prank(honest);
        (uint128 h0,) = s.pool.collect(honest, LOWER, UPPER, type(uint128).max, type(uint128).max);

        jitFees = uint256(j0);
        honestFees = uint256(h0);
    }

    /// Базовая уязвимость без защиты: бот забирает почти всё.
    function test_baseline_jitStealsMostFees() public {
        (uint256 honestFees, uint256 jitFees) = _run(0);
        uint256 total = honestFees + jitFees;
        assertGt(total, 0, "no fees at all - stand is broken");

        uint256 jitShare = (jitFees * 10000) / total;
        emit log_named_uint("bez zashity: komissiy u bota, bp", jitShare);
        emit log_named_uint("bez zashity: komissiy u chestnogo LP, bp", (honestFees * 10000) / total);

        // Воспроизводим наблюдение 90.9% (10/11).
        assertEq(jitShare, 9090, "expected the original 90.9% split");
    }

    /// С вестингом бот не получает ничего: он снимает ликвидность до истечения
    /// срока, и незачисленные комиссии сгорают пропорционально снятому.
    function test_jit_withVesting_getsNothing() public {
        (uint256 honestFees, uint256 jitFees) = _run(100);

        emit log_named_uint("s vestingom: komissiy u bota", jitFees);
        emit log_named_uint("s vestingom: komissiy u chestnogo LP", honestFees);

        assertEq(jitFees, 0, "JIT must not receive fees under vesting");
        assertGt(honestFees, 0, "honest LP must still receive fees");
    }

    /// Честный LP ничего не теряет, если забирает комиссию и ждёт срок:
    /// сумма его комиссий не зависит от наличия вестинга.
    function test_honestLp_keepsAllFees() public {
        (uint256 honestNoDelay,) = _run(0);
        (uint256 honestWithDelay,) = _run(100);
        assertEq(honestWithDelay, honestNoDelay, "honest LP must not lose fees to vesting");
    }

    /// JIT не может обойти защиту, оставив «пылинку» ликвидности: сгорает
    /// доля, пропорциональная снятому.
    function test_jit_cannotBypassWithDust() public {
        Stand memory s = _deploy();
        s.factory.setJitDelayBlocks(FEE, 100);

        vm.prank(honest);
        s.pool.mint(honest, LOWER, UPPER, 1e21);
        vm.roll(block.number + 5);

        uint128 jitLiq = 1e22;
        vm.prank(jit);
        s.pool.mint(jit, LOWER, UPPER, jitLiq);

        vm.prank(trader);
        s.pool.swap(trader, true, int256(1e20), P / 10 * 9, "");

        // Снимаем 99.999%, оставляя «пылинку» — в надежде, что комиссия
        // останется в позиции и её можно будет забрать позже.
        uint128 keep = jitLiq / 100000;
        vm.prank(jit);
        s.pool.burn(LOWER, UPPER, jitLiq - keep);

        vm.roll(block.number + 101);

        vm.prank(jit);
        (uint128 j0,) = s.pool.collect(jit, LOWER, UPPER, type(uint128).max, type(uint128).max);

        emit log_named_uint("dust-obhod: komissiy u bota", j0);

        // Даже после срока бот получает лишь долю, равную оставленной
        // пылинке (0.001% начисленного), а не всё.
        (uint256 honestExpected,) = _run(0);
        assertLt(uint256(j0), honestExpected / 1000, "dust bypass must not recover fees");
    }

    /// ЧЕСТНЫЙ ТЕСТ ГРАНИЦЫ ЗАЩИТЫ: вестинг НЕ уничтожает комиссию бота, если
    /// бот готов подождать срок. Он лишь откладывает выплату. Этот тест
    /// фиксирует именно это — чтобы не заявлять больше, чем есть.
    function test_bypass_waitingOutVesting_doesPay() public {
        Stand memory s = _deploy();
        uint64 delay = 100;
        s.factory.setJitDelayBlocks(FEE, delay);

        vm.prank(honest);
        s.pool.mint(honest, LOWER, UPPER, 1e21);
        vm.roll(block.number + 5);

        uint128 jitLiq = 1e22;
        vm.prank(jit);
        s.pool.mint(jit, LOWER, UPPER, jitLiq);

        vm.prank(trader);
        s.pool.swap(trader, true, int256(1e20), P / 10 * 9, "");

        // Учёт комиссии ленивый: срок вестинга стартует не в момент свопа,
        // а в момент первого обращения к позиции. Поэтому бот «заводит
        // часы» дешёвым collect, затем ждёт и только потом выходит.
        vm.prank(jit);
        s.pool.collect(jit, LOWER, UPPER, type(uint128).max, type(uint128).max);

        vm.roll(block.number + delay + 1);

        vm.prank(jit);
        s.pool.burn(LOWER, UPPER, jitLiq);
        vm.prank(jit);
        (uint128 j0,) = s.pool.collect(jit, LOWER, UPPER, type(uint128).max, type(uint128).max);

        emit log_named_uint("obhod ozhidaniem: komissiy u bota", j0);

        // Защита работает через ЭКОНОМИКУ удержания, а не через невозможность
        // забрать: чтобы получить комиссию, бот обязан держать ликвидность в
        // пуле ещё `delay` блоков и всё это время нести риск цены.
        assertGt(uint256(j0), 0, "waiting out the delay does recover fees - documented limit");
    }
}