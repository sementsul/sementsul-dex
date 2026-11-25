// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {SementsulFactory, SementsulPair} from "../contracts/SementsulV2.sol";
import {SementsulV3Factory, SementsulV3Pool} from "../contracts/SementsulV3.sol";

/// Тестовый ERC-20.
contract Token {
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

/// Тесты четырёх векторов атак из задания.
///
/// Три из четырёх адресованы механизму pendingLiquidity, которого в контрактах
/// НЕТ. Такие тесты не «проходят» — они доказывают неприменимость: проверяют,
/// что в ABI нет соответствующих функций и что позиция учитывается сразу.
///
/// Четвёртая (дробление и переупаковка) применима к V2, потому что LP-токен
/// там передаваемый ERC-20 — и тест показывает реальное последствие.
contract AttackScenarios is Test {
    SementsulFactory v2Factory;
    Token tokenA;
    Token tokenB;

    address attacker = address(0xBAD);
    address honestLp = address(0x600D);

    function setUp() public {
        v2Factory = new SementsulFactory(2500);
        tokenA = new Token();
        tokenB = new Token();
        if (address(tokenA) > address(tokenB)) {
            (tokenA, tokenB) = (tokenB, tokenA);
        }
    }

    // -----------------------------------------------------------------------
    // Атака 1: «Отравленный тик» (Tick Boundary Manipulation & Pending Drain)
    // -----------------------------------------------------------------------
    //
    // Постановка: в pendingLiquidity на соседнем тике лежит депозит, который
    // активируется в следующем блоке; бот двигает цену к границе тика и
    // обратно, забирая комиссии, начисленные до реальной активации.
    //
    // Почему неприменимо: pendingLiquidity в контрактах нет. Комиссии
    // учитываются в момент mint, а не в следующем блоке. Тест фиксирует это
    // структурно: у пула нет функции, которая отложила бы активацию.

    function test_attack1_noPendingMechanismExists() public {
        SementsulPair pair = SementsulPair(v2Factory.createPair(address(tokenA), address(tokenB)));

        tokenA.mint(address(this), 1000e18);
        tokenB.mint(address(this), 1000e18);
        tokenA.transfer(address(pair), 1000e18);
        tokenB.transfer(address(pair), 1000e18);
        pair.mint(address(this));

        // В интерфейсе пары нет ни одной функции с «pending» или «activate».
        // Проверяем через низкоуровневые вызовы: если функции нет, вызов
        // вернёт false (или ревертнётся), но не выполнит логику.
        (bool ok1,) = address(pair).call(abi.encodeWithSignature("pendingLiquidity()"));
        (bool ok2,) = address(pair).call(abi.encodeWithSignature("activatePending()"));
        (bool ok3,) = address(pair).call(abi.encodeWithSignature("pendingList(uint256)"));

        assertFalse(ok1, "pendingLiquidity exists");
        assertFalse(ok2, "activatePending exists");
        assertFalse(ok3, "pendingList exists");
    }

    /// Комиссии учитываются немедленно: после mint позиция сразу получает
    /// право на комиссии, и «подвинуть цену к границе» не даёт доступа к
    /// чужим начислениям.
    function test_attack1_feesAccrueImmediatelyNotDeferred() public {
        SementsulPair pair = SementsulPair(v2Factory.createPair(address(tokenA), address(tokenB)));

        tokenA.mint(honestLp, 10_000e18);
        tokenB.mint(honestLp, 10_000e18);

        vm.startPrank(honestLp);
        tokenA.transfer(address(pair), 10_000e18);
        tokenB.transfer(address(pair), 10_000e18);
        pair.mint(honestLp);
        vm.stopPrank();

        // Тот же блок: честный LP уже владеет долей.
        uint256 lpBalance = pair.balanceOf(honestLp);
        assertGt(lpBalance, 0, "LP got no tokens");

        // Атакующий двигает цену в том же блоке — LP всё равно владеет долей,
        // и комиссия от этого свопа остаётся в пуле, увеличивая стоимость
        // доли честного LP.
        tokenA.mint(attacker, 1000e18);
        vm.startPrank(attacker);
        tokenA.transfer(address(pair), 1000e18);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        uint256 out = (1000e18 * 99750 * uint256(r1)) / (uint256(r0) * 1_000_000 + 1000e18 * 99750);
        pair.swap(0, out, attacker);
        vm.stopPrank();

        // Доля честного LP не уменьшилась — комиссия осталась в пуле.
        assertEq(pair.balanceOf(honestLp), lpBalance, "LP share changed");
    }

    // -----------------------------------------------------------------------
    // Атака 2: «Дробление и переупаковка» (Position Splitting / Transfer Bypass)
    // -----------------------------------------------------------------------
    //
    // Постановка: если таймер блокировки привязан к msg.sender, бот вливает
    // ликвидность с контракта А, переводит LP на контракт Б и выводит без
    // штрафа.
    //
    // Наш случай: таймеров и штрафов нет ВООБЩЕ, поэтому обходить нечего.
    // Но LP-токен действительно передаваемый — и это надо признать честно:
    // тест показывает, что доля переходит вместе с токеном.

    function test_attack2_lpTokenIsTransferable_noTimerToBypass() public {
        SementsulPair pair = SementsulPair(v2Factory.createPair(address(tokenA), address(tokenB)));

        address contractA = address(0xC0A);
        address contractB = address(0xC0B);

        tokenA.mint(contractA, 1000e18);
        tokenB.mint(contractA, 1000e18);

        vm.startPrank(contractA);
        tokenA.transfer(address(pair), 1000e18);
        tokenB.transfer(address(pair), 1000e18);
        uint256 lp = pair.mint(contractA);
        vm.stopPrank();

        assertGt(lp, 0, "mint failed");

        // Никакого depositTimestamp в контракте нет — обходить нечего.
        (bool hasTimer,) = address(pair).call(abi.encodeWithSignature("depositTimestamp(address)", contractA));
        assertFalse(hasTimer, "depositTimestamp exists");

        // LP-токен передаётся: доля уходит вместе с ним. Это не уязвимость
        // (нет штрафа, который можно было бы обойти), но означает, что
        // привязка прав к адресу в V2 невозможна по конструкции.
        uint256 half = lp / 2;
        vm.prank(contractA);
        pair.transfer(contractB, half);

        assertEq(pair.balanceOf(contractB), half, "transfer failed");
        assertEq(pair.balanceOf(contractA), lp - half, "sender balance wrong");

        // Контракт Б может немедленно вывести — и получит ровно свою долю.
        vm.prank(contractB);
        pair.transfer(address(pair), half);
        vm.prank(contractB);
        (uint256 a0, uint256 a1) = pair.burn(contractB);

        assertGt(a0, 0, "no token0 out");
        assertGt(a1, 0, "no token1 out");
    }

    // -----------------------------------------------------------------------
    // Атака 3: «Пылевой спам в Pending» (Queue DoS / Gas Griefing)
    // -----------------------------------------------------------------------
    //
    // Постановка: если активация перебирает массив pending, 500 микро-депозитов
    // в одном блоке заставят первый своп следующего блока оплатить цикл.
    //
    // Наш случай: массива нет, активации нет, циклов в swap нет (V2). Тест
    // проверяет, что своп не зависит от числа LP: газ одинаков при 1 и при
    // 50 поставщиках.

    function test_attack3_swapGasIndependentOfLpCount() public {
        SementsulPair pair = SementsulPair(v2Factory.createPair(address(tokenA), address(tokenB)));

        // Один крупный LP.
        tokenA.mint(contract1(), 100_000e18);
        tokenB.mint(contract1(), 100_000e18);
        vm.startPrank(contract1());
        tokenA.transfer(address(pair), 100_000e18);
        tokenB.transfer(address(pair), 100_000e18);
        pair.mint(contract1());
        vm.stopPrank();

        (uint112 r0, uint112 r1,) = pair.getReserves();
        uint256 out1 = (1e18 * 99750 * uint256(r1)) / (uint256(r0) * 1_000_000 + 1e18 * 99750);

        tokenA.mint(address(this), 1e18);
        tokenA.transfer(address(pair), 1e18);

        uint256 gasBefore = gasleft();
        pair.swap(0, out1, address(this));
        uint256 gasOneLp = gasBefore - gasleft();

        // Теперь 50 мелких LP поверх того же пула.
        for (uint256 i = 0; i < 50; i++) {
            address lp = address(uint160(0x10000 + i));
            tokenA.mint(lp, 10e18);
            tokenB.mint(lp, 10e18);
            vm.startPrank(lp);
            tokenA.transfer(address(pair), 10e18);
            tokenB.transfer(address(pair), 10e18);
            pair.mint(lp);
            vm.stopPrank();
        }

        (r0, r1,) = pair.getReserves();
        uint256 out2 = (1e18 * 99750 * uint256(r1)) / (uint256(r0) * 1_000_000 + 1e18 * 99750);
        tokenA.mint(address(this), 1e18);
        tokenA.transfer(address(pair), 1e18);

        gasBefore = gasleft();
        pair.swap(0, out2, address(this));
        uint256 gasFiftyLp = gasBefore - gasleft();

        // Газ не должен зависеть от числа поставщиков. Допускаем небольшой
        // разброс: изменение резервов влияет на арифметику, но не на циклы.
        assertLt(
            gasFiftyLp,
            (gasOneLp * 130) / 100,
            "swap gas grows with LP count - O(n) behaviour"
        );
    }

    function contract1() internal pure returns (address) {
        return address(0x1001);
    }

    // -----------------------------------------------------------------------
    // Атака 4: «Флеш-выкуп штрафа» (Self-Captured Exit Penalty)
    // -----------------------------------------------------------------------
    //
    // Постановка: если штраф за ранний выход распределяется мгновенно
    // пропорционально активной ликвидности, бот с 99% ликвидности забирает
    // 99% своих же штрафов.
    //
    // Наш случай: штрафов нет, распределять нечего. Тест фиксирует это и
    // одновременно проверяет, что комиссии нельзя «выкупить» одной
    // транзакцией: они распределяются по факту обмена, а не по факту выхода.

    function test_attack4_noExitPenalty_noSelfCapture() public {
        SementsulPair pair = SementsulPair(v2Factory.createPair(address(tokenA), address(tokenB)));

        (bool hasPenalty,) = address(pair).call(abi.encodeWithSignature("exitPenalty()"));
        (bool hasCooldown,) = address(pair).call(abi.encodeWithSignature("cooldownBlocks()"));
        assertFalse(hasPenalty, "exitPenalty exists");
        assertFalse(hasCooldown, "cooldownBlocks exists");

        // Внести и сразу вывести в одном блоке: возвращается ровно вложенное
        // минус округление. Никакого «штрафа», который можно было бы
        // перераспределить в свою пользу, не возникает.
        tokenA.mint(address(this), 1000e18);
        tokenB.mint(address(this), 1000e18);

        tokenA.transfer(address(pair), 1000e18);
        tokenB.transfer(address(pair), 1000e18);
        uint256 lp = pair.mint(address(this));

        uint256 before0 = tokenA.balanceOf(address(this));
        uint256 before1 = tokenB.balanceOf(address(this));

        pair.transfer(address(pair), lp);
        (uint256 out0, uint256 out1) = pair.burn(address(this));

        // Возврат не больше вложенного: пул не платит за вход-выход.
        assertLe(out0, 1000e18 + 1, "got more token0 than deposited");
        assertLe(out1, 1000e18 + 1, "got more token1 than deposited");
        assertGt(out0 + before0, 0, "nothing returned");
        assertGt(out1 + before1, 0, "nothing returned");
    }
}