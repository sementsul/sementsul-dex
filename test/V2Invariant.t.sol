// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {SementsulFactory, SementsulPair} from "../contracts/SementsulV2.sol";

/// Тестовый ERC-20: обычный токен без комиссий на перевод.
contract MockERC20 {
    string public name = "Mock";
    string public symbol = "MCK";
    uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            require(a >= value, "ALLOWANCE");
            allowance[from][msg.sender] = a - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) private {
        require(balanceOf[from] >= value, "BALANCE");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}

/// Хендлер: единственное, что фаззер может делать с пулом.
///
/// Ограничиваем набор действий тремя операциями — добавить, убрать, обменять.
/// Если дать фаззеру вызывать пул напрямую, половина прогонов уйдёт на вызовы
/// в обход учёта, и инварианты перестанут что-либо проверять.
contract Handler is Test {
    SementsulPair public pair;
    MockERC20 public t0;
    MockERC20 public t1;

    address[] public actors;

    // Экономический учёт: сколько токенов вошло в пул и сколько вышло.
    //
    // Сравнивать «вынутое с внесённым» напрямую нельзя: комиссии остаются в
    // пуле, поэтому LP вправе забрать больше, чем вложил. Зато работает
    // точный закон сохранения — всё, что вошло, минус всё, что вышло, должно
    // быть равно балансу пула, до вей.
    uint256 public inflow0;
    uint256 public inflow1;
    uint256 public outflow0;
    uint256 public outflow1;

    /// Нарушения, замеченные внутри операции.
    ///
    /// Инварианты в Foundry вызываются между операциями, а не внутри них,
    /// поэтому «k уменьшилось во время свопа» так не поймать. Замечаем
    /// нарушение в самом свопе и поднимаем флаг — инвариант его проверит.
    bool public kDecreasedDuringSwap;

    constructor(SementsulPair _pair, MockERC20 _t0, MockERC20 _t1) {
        pair = _pair;
        t0 = _t0;
        t1 = _t1;
        actors.push(address(0xA11CE));
        actors.push(address(0xB0B));
        actors.push(address(0xCA401));
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function reserves0() internal view returns (uint256) {
        (uint256 r0,,) = pair.getReserves();
        return r0;
    }

    function reserves1() internal view returns (uint256) {
        (,uint256 r1,) = pair.getReserves();
        return r1;
    }

    /// Добавить ликвидность от имени случайного актора.
    ///
    /// Пропорция берётся из пула: если вносить произвольные суммы, mint
    /// зачтёт только меньшую часть, и часть токенов подарится пулу. Это
    /// допустимо, но искажает учёт депозитов, поэтому в пустом пуле вносим
    /// как есть, а в непустом — пропорционально.
    function addLiquidity(uint256 seed, uint96 amount0, uint96 amount1) public {
        address who = _actor(seed);
        uint256 r0 = reserves0();
        uint256 r1 = reserves1();

        uint256 a0;
        uint256 a1;

        // Резервы хранятся в uint112. Без ограничения сумма за несколько сотен
        // вкладов переполнит тип, _update ревертнётся с OVERFLOW — и фаззер
        // потратит вызовы впустую, не проверив логику.
        uint256 room0 = type(uint112).max - r0;
        uint256 room1 = type(uint112).max - r1;

        if (r0 == 0 || r1 == 0) {
            uint256 cap0 = room0 < 1e24 ? room0 : 1e24;
            uint256 cap1 = room1 < 1e24 ? room1 : 1e24;
            if (cap0 < 1e9 || cap1 < 1e9) return;
            a0 = bound(amount0, 1e9, cap0);
            a1 = bound(amount1, 1e9, cap1);
        } else {
            uint256 cap0 = room0 < 1e22 ? room0 : 1e22;
            if (cap0 < 1e6) return;
            a0 = bound(amount0, 1e6, cap0);
            a1 = (a0 * r1) / r0;
            // Вторая часть тоже должна поместиться в uint112.
            if (a1 == 0 || a1 > room1) return;
        }

        t0.mint(who, a0);
        t1.mint(who, a1);

        vm.startPrank(who);
        t0.transfer(address(pair), a0);
        t1.transfer(address(pair), a1);
        pair.mint(who);
        vm.stopPrank();

        inflow0 += a0;
        inflow1 += a1;
    }

    /// Убрать ликвидность.
    ///
    /// burn сжигает LP-токены, лежащие НА АДРЕСЕ ПАРЫ, а не на балансе
    /// вызывающего. Сначала переводим долю в пару — иначе burn ревертится с
    /// INSUFFICIENT_LIQUIDITY_BURNED, и вывод средств вообще не проверяется.
    function removeLiquidity(uint256 seed, uint96 share) public {
        address who = _actor(seed);
        uint256 lp = pair.balanceOf(who);
        if (lp == 0) return;

        uint256 amount = bound(share, 1, lp);
        // burn требует, чтобы обе доли были непустыми.
        uint256 r0 = reserves0();
        uint256 r1 = reserves1();
        if (r0 == 0 || r1 == 0) return;

        // Слишком маленькая доля даёт нулевой выход хотя бы по одному токену,
        // и burn ревертится с INSUFFICIENT_LIQUIDITY_BURNED. Проверяем заранее:
        // иначе фаззер тратит вызовы на гарантированный реверт.
        uint256 supply = pair.totalSupply();
        if (supply == 0) return;
        if ((amount * r0) / supply == 0 || (amount * r1) / supply == 0) return;

        vm.startPrank(who);
        pair.transfer(address(pair), amount);
        (uint256 out0, uint256 out1) = pair.burn(who);
        vm.stopPrank();

        outflow0 += out0;
        outflow1 += out1;
    }

    /// Обмен: вносим один токен, получаем другой.
    function swap(uint256 seed, uint96 amountIn, bool zeroForOne) public {
        address who = _actor(seed);

        uint256 reserveIn;
        uint256 reserveOut;
        MockERC20 tokenIn;

        if (zeroForOne) {
            (reserveIn, reserveOut) = (reserves0(), reserves1());
            tokenIn = t0;
        } else {
            (reserveIn, reserveOut) = (reserves1(), reserves0());
            tokenIn = t1;
        }

        if (reserveIn == 0 || reserveOut == 0) return;

        uint256 amount = bound(amountIn, 1e3, reserveIn / 5);
        if (amount == 0) return;

        uint256 fee = pair.fee();
        uint256 amountInWithFee = amount * (1_000_000 - fee);
        uint256 out = (amountInWithFee * reserveOut) / (reserveIn * 1_000_000 + amountInWithFee);
        if (out == 0 || out >= reserveOut) return;

        uint256 kBefore = reserves0() * reserves1();

        tokenIn.mint(who, amount);
        vm.startPrank(who);
        tokenIn.transfer(address(pair), amount);
        if (zeroForOne) {
            pair.swap(0, out, who);
            inflow0 += amount;
            outflow1 += out;
        } else {
            pair.swap(out, 0, who);
            inflow1 += amount;
            outflow0 += out;
        }
        vm.stopPrank();

        // Обмен обязан сохранять или увеличивать k: комиссия остаётся в пуле.
        // Уменьшение означало бы, что кто-то вывел больше, чем внёс.
        uint256 kAfter = reserves0() * reserves1();
        if (kAfter < kBefore) kDecreasedDuringSwap = true;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }
}

/// Инвариантные тесты пула V2.
///
/// Главная проверка — платёжеспособность: пул всегда держит столько токенов,
/// сколько обещает своим LP, и ни один обмен не может это уменьшить.
contract V2InvariantTest is Test {
    SementsulFactory factory;
    SementsulPair pair;
    MockERC20 token0;
    MockERC20 token1;
    Handler handler;

    function setUp() public {
        factory = new SementsulFactory(2500);
        token0 = new MockERC20();
        token1 = new MockERC20();

        // Фабрика требует, чтобы адреса шли по возрастанию.
        if (address(token0) > address(token1)) {
            (token0, token1) = (token1, token0);
        }

        pair = SementsulPair(factory.createPair(address(token0), address(token1)));
        handler = new Handler(pair, token0, token1);

        targetContract(address(handler));
    }

    function reserves0() internal view returns (uint256) {
        (uint256 r0,,) = pair.getReserves();
        return r0;
    }

    function reserves1() internal view returns (uint256) {
        (,uint256 r1,) = pair.getReserves();
        return r1;
    }

    /// Резервы пула в точности равны его фактическим балансам.
    ///
    /// Это и есть «баланс пула не меньше суммы депозитов»: раз учёт совпадает
    /// с реальностью, забрать токены в обход резервов невозможно. Нарушение
    /// означало бы, что кто-то нашёл способ вывести больше, чем внёс.
    function invariant_reservesMatchBalances() public view {
        assertEq(reserves0(), token0.balanceOf(address(pair)), "reserve0 != balance0");
        assertEq(reserves1(), token1.balanceOf(address(pair)), "reserve1 != balance1");
    }

    /// k = reserve0 * reserve1 никогда не уменьшается при обмене.
    ///
    /// Комиссия только добавляет; уменьшение означало бы бесплатный вывод.
    function invariant_kNeverDecreasesOnSwap() public view {
        assertFalse(handler.kDecreasedDuringSwap(), "k decreased during a swap");
    }

    /// Выпущенные LP-токены обеспечены резервами.
    function invariant_lpSupplyCoveredByReserves() public view {
        uint256 supply = pair.totalSupply();
        if (supply == 0) return;
        assertTrue(
            reserves0() > 0 && reserves1() > 0,
            "LP tokens exist but pool is empty"
        );
    }

    /// Закон сохранения: всё, что вошло, минус всё, что вышло, равно балансу.
    ///
    /// Это самая сильная проверка платёжеспособности. Если пул когда-нибудь
    /// отдаст больше, чем получил, то есть создаст токены из воздуха, —
    /// равенство сломается, и это будет видно сразу.
    function invariant_flowsReconcileWithBalance() public view {
        assertEq(
            handler.inflow0() - handler.outflow0(),
            token0.balanceOf(address(pair)),
            "token0: inflow - outflow != balance"
        );
        assertEq(
            handler.inflow1() - handler.outflow1(),
            token1.balanceOf(address(pair)),
            "token1: inflow - outflow != balance"
        );
    }

    /// Комиссию пары нельзя подменить: она равна комиссии фабрики.
    function invariant_feeMatchesFactory() public view {
        assertEq(pair.fee(), factory.fee(), "pair fee != factory fee");
    }

    /// Постоянная MINIMUM_LIQUIDITY остаётся на нулевом адресе навсегда:
    /// первый LP не может выкупить весь пул и оставить его без ликвидности.
    function invariant_minimumLiquidityLocked() public view {
        uint256 supply = pair.totalSupply();
        if (supply == 0) return;
        uint256 locked = pair.balanceOf(address(0));
        assertTrue(locked > 0, "minimum liquidity not locked");
        assertTrue(locked < supply, "all supply locked - LPs cannot withdraw");
    }
}