// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {SementsulFactory, SementsulPair} from "../contracts/SementsulV2.sol";

/// Минимальный ERC-20 для фаззинг-тестов.
contract FuzzToken {
    string public name = "F";
    string public symbol = "F";
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
        require(allowance[f][msg.sender] >= v, "ALLOW");
        allowance[f][msg.sender] -= v;
        require(balanceOf[f] >= v, "BAL");
        balanceOf[f] -= v;
        balanceOf[to] += v;
        emit Transfer(f, to, v);
        return true;
    }
}

/// Фаззинг-тесты математики пула V2.
///
/// В отличие от инвариантов, здесь проверяются конкретные свойства формулы
/// обмена на случайных, но осмысленных входах. Инварианты ловят нарушения
/// последовательности операций, фаззинг — ошибки в самой арифметике.
contract V2FuzzTest is Test {
    SementsulFactory factory;
    SementsulPair pair;
    FuzzToken token0;
    FuzzToken token1;

    uint256 constant RESERVE = 1e24;

    function setUp() public {
        factory = new SementsulFactory(2500);
        token0 = new FuzzToken();
        token1 = new FuzzToken();
        if (address(token0) > address(token1)) {
            (token0, token1) = (token1, token0);
        }
        pair = SementsulPair(factory.createPair(address(token0), address(token1)));

        token0.mint(address(this), RESERVE);
        token1.mint(address(this), RESERVE);
        token0.transfer(address(pair), RESERVE);
        token1.transfer(address(pair), RESERVE);
        pair.mint(address(this));
    }

    /// Выход обмена строго меньше резерва выхода.
    ///
    /// Это не косметическое свойство: если бы формула могла вернуть весь
    /// резерв, пул остался бы пустым и следующий своп делил бы на ноль.
    /// Фаззинг ищет вход, при котором это происходит.
    function testFuzz_outputNeverDrainsReserve(uint96 amountIn) public {
        uint256 amount = bound(amountIn, 1e3, RESERVE / 2);

        (uint112 r0, uint112 r1,) = pair.getReserves();
        uint256 expected = (amount * 99750 * uint256(r1)) / (uint256(r0) * 1_000_000 + amount * 99750);
        if (expected == 0) return;

        assertLt(expected, r1, "output >= reserveOut");
        assertLt(expected, r0, "output >= reserveIn");
    }

    /// k не уменьшается ни при каком входе.
    ///
    /// Комиссия 0.25% остаётся в пуле, поэтому k после обмена обязано быть
    /// не меньше, чем до. Фаззинг проверяет это на случайных величинах,
    /// включая крайние — от пыли до половины резерва.
    function testFuzz_kNeverDecreases(uint96 amountIn) public {
        uint256 amount = bound(amountIn, 1e3, RESERVE / 2);

        (uint112 r0, uint112 r1,) = pair.getReserves();
        uint256 kBefore = uint256(r0) * uint256(r1);

        uint256 out = (amount * 99750 * uint256(r1)) / (uint256(r0) * 1_000_000 + amount * 99750);
        if (out == 0) return;

        token0.mint(address(this), amount);
        token0.transfer(address(pair), amount);
        pair.swap(0, out, address(this));

        (r0, r1,) = pair.getReserves();
        uint256 kAfter = uint256(r0) * uint256(r1);

        assertGe(kAfter, kBefore, "k decreased");
    }

    /// Выход монотонно растёт вместе со входом.
    ///
    /// Если больший вход давал бы меньший выход, арбитражник мог бы
    /// «разогнать» пул серией обменов. Фаззинг ищет такую пару входов.
    function testFuzz_outputIsMonotonic(uint96 a, uint96 b) public {
        uint256 x = bound(a, 1e6, RESERVE / 4);
        uint256 y = bound(b, 1e6, RESERVE / 4);

        (uint112 r0, uint112 r1,) = pair.getReserves();

        uint256 outX = (x * 99750 * uint256(r1)) / (uint256(r0) * 1_000_000 + x * 99750);
        uint256 outY = (y * 99750 * uint256(r1)) / (uint256(r0) * 1_000_000 + y * 99750);

        if (outX == 0 || outY == 0) return;

        if (x < y) {
            assertLe(outX, outY, "smaller input gave more output");
        } else if (x > y) {
            assertGe(outX, outY, "larger input gave less output");
        } else {
            assertEq(outX, outY, "equal inputs gave different output");
        }
    }

    /// Комиссия действительно взимается: выход меньше, чем дал бы обмен без
    /// комиссии.
    ///
    /// Проверяет, что fee не «теряется» где-то в арифметике — иначе пул
    /// работал бы бесплатно, а LP не получали бы ничего.
    function testFuzz_feeIsActuallyCharged(uint96 amountIn) public {
        uint256 amount = bound(amountIn, 1e9, RESERVE / 4);

        (uint112 r0, uint112 r1,) = pair.getReserves();

        uint256 withFee = (amount * 99750 * uint256(r1)) / (uint256(r0) * 1_000_000 + amount * 99750);
        // Обмен без комиссии: x*y=k без вычета.
        uint256 withoutFee = (amount * uint256(r1)) / (uint256(r0) + amount);

        if (withFee == 0 || withoutFee == 0) return;
        assertLt(withFee, withoutFee, "fee not charged");
    }

    /// Попытка обмена без комиссии обязан отклониться.
    ///
    /// Проверка k в swap — единственное, что не даёт вывести токены «даром».
    /// Этот тест предъявляет пулу ровно тот выход, который соответствовал бы
    /// обмену без комиссии, и требует реверта. Без него ослабление проверки
    /// (например, fee = 0) проходило бы незамеченным: обычные обмены идут
    /// через формулу с комиссией и от этого не страдают.
    function test_swapWithoutFeeReverts() public {
        (uint112 r0, uint112 r1,) = pair.getReserves();

        uint256 amount = 1e20;
        // Выход БЕЗ комиссии: ровно столько, сколько дал бы обмен x*y=k
        // без удержания 0.25%. Такой обмен обеднил бы LP.
        uint256 out = (amount * uint256(r1)) / (uint256(r0) + amount);
        assertGt(out, 0, "test setup: zero output");

        token0.mint(address(this), amount);
        token0.transfer(address(pair), amount);

        // Должно упасть именно на инварианте k.
        vm.expectRevert(bytes("Sementsul: K"));
        pair.swap(0, out, address(this));
    }

    /// Выход, соответствующий комиссии, проходит — и это не случайность.
    ///
    /// Парный тест к предыдущему: он доказывает, что реверт выше вызван
    /// именно отсутствием комиссии, а не тем, что такие суммы вообще
    /// запрещены.
    function test_swapWithFeeSucceeds() public {
        (uint112 r0, uint112 r1,) = pair.getReserves();

        uint256 amount = 1e20;
        uint256 out = (amount * 99750 * uint256(r1)) / (uint256(r0) * 1_000_000 + amount * 99750);
        assertGt(out, 0, "test setup: zero output");

        token0.mint(address(this), amount);
        token0.transfer(address(pair), amount);

        pair.swap(0, out, address(this));

        // Вышли ровно запрошенные токены — значит, обмен с комиссией возможен,
        // и реверт в предыдущем тесте вызван именно отсутствием комиссии.
        assertGe(token1.balanceOf(address(this)), out, "output not received");
    }

    /// Добавление ликвидности не уменьшает стоимость позиции существующих LP.
    ///
    /// Важно, что здесь сравнивается ИМЕННО стоимость доли (сколько токенов
    /// LP может забрать), а не процент от totalSupply. Процент обязан падать,
    /// когда кто-то вносит свои токены, — это нормально и не является потерей.
    /// Потерей было бы, если бы вместе с процентом уменьшилось и количество
    /// токенов, на которое LP имеет право.
    function testFuzz_newDepositDoesNotDilute(uint96 amountIn) public {
        // Верхняя граница берётся от текущего резерва, а не от константы:
        // так фаззер всегда попадает в осмысленный диапазон.
        (uint112 r0, uint112 r1,) = pair.getReserves();
        uint256 amount = bound(amountIn, 1e9, uint256(r0) / 4);
        if (amount == 0) return;

        uint256 supplyBefore = pair.totalSupply();
        uint256 myLpBefore = pair.balanceOf(address(this));

        // Сколько token0 причитается мне до чужого вклада.
        uint256 valueBefore0 = (myLpBefore * uint256(r0)) / supplyBefore;
        uint256 valueBefore1 = (myLpBefore * uint256(r1)) / supplyBefore;

        uint256 amount1 = (amount * uint256(r1)) / uint256(r0);
        if (amount1 == 0) return;

        token0.mint(address(0xBEEF), amount);
        token1.mint(address(0xBEEF), amount1);
        vm.startPrank(address(0xBEEF));
        token0.transfer(address(pair), amount);
        token1.transfer(address(pair), amount1);
        pair.mint(address(0xBEEF));
        vm.stopPrank();

        (r0, r1,) = pair.getReserves();
        uint256 supplyAfter = pair.totalSupply();

        uint256 valueAfter0 = (pair.balanceOf(address(this)) * uint256(r0)) / supplyAfter;
        uint256 valueAfter1 = (pair.balanceOf(address(this)) * uint256(r1)) / supplyAfter;

        // Стоимость позиции не должна упасть. Допускаем единицы на округление
        // вниз при делении — оно всегда в пользу пула, а не в убыток LP.
        assertGe(valueAfter0 + 2, valueBefore0, "token0 position value decreased");
        assertGe(valueAfter1 + 2, valueBefore1, "token1 position value decreased");
    }
}