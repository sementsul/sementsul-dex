// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {SementsulV3Factory, SementsulV3Pool} from "../contracts/SementsulV3.sol";

contract BugToken {
    string public name = "V";
    string public symbol = "V";
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

/// Регрессия на «запертую позицию».
///
/// Дефект: первый минт в ещё не инициализированный диапазон, содержащий
/// текущую цену, в пуле, где уже накоплены комиссии, записывал в позицию
/// last = feeGrowthGlobal. Следующее обращение считало inside ≈ 0, разность
/// inside - last уходила в минус и Solidity 0.8 падал с Panic(0x11).
/// Позиция переставала отвечать и на collect, и на burn — деньги запирались.
///
/// Чинится пересчётом снимка комиссии ПОСЛЕ инициализации тиков.
///
/// Файл держит обе стороны: сценарии, которые обязаны работать, и проверку,
/// что снимок не берётся из устаревшего замера.
contract StuckPositionRegressionTest is Test {
    uint160 constant SQRT_PRICE_1_1 = 79228162514264337593543950336;

    SementsulV3Factory factory;
    SementsulV3Pool pool;
    BugToken token0;
    BugToken token1;

    int24 constant SPACING = 10;
    uint24 constant FEE = 500;

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (amount0Delta > 0) token0.transfer(msg.sender, uint256(amount0Delta));
        else if (amount1Delta > 0) token1.transfer(msg.sender, uint256(amount1Delta));
    }

    function setUp() public {
        uint24[] memory fees = new uint24[](1);
        fees[0] = FEE;
        int24[] memory spacings = new int24[](1);
        spacings[0] = SPACING;
        factory = new SementsulV3Factory(fees, spacings, address(this));

        token0 = new BugToken();
        token1 = new BugToken();
        if (address(token0) > address(token1)) (token0, token1) = (token1, token0);

        pool = SementsulV3Pool(factory.createPool(address(token0), address(token1), FEE));
        pool.initializePrice(SQRT_PRICE_1_1);

        token0.mint(address(this), 1e36);
        token1.mint(address(this), 1e36);
        token0.approve(address(pool), type(uint256).max);
        token1.approve(address(pool), type(uint256).max);

        // Вестинг выключаем: он тут не при чём и мешает видеть чистую арифметику.
        factory.setJitDelayBlocks(FEE, 0);
    }

    function _key(address owner, int24 lo, int24 hi) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(owner, lo, hi));
    }

    function _swap0For1(uint256 amount) internal {
        pool.swap(address(this), true, int256(amount), SQRT_PRICE_1_1 / 10, "");
    }

    /// ГЛАВНЫЙ ТЕСТ: раньше падал с Panic(0x11).
    function test_firstMintIntoFreshRangeDoesNotLock() public {
        pool.mint(address(this), -600, 600, 1e21);
        _swap0For1(1e18);
        assertGt(pool.feeGrowthGlobal0X128(), 0, "no fees accrued");

        int24 lo = -100;
        int24 hi = 100;
        pool.mint(address(this), lo, hi, 1e20);

        // Ключевая проверка: снимок НЕ равен глобальной комиссии.
        (, uint256 last0,,,,,,) = pool.positions(_key(address(this), lo, hi));
        assertTrue(last0 != pool.feeGrowthGlobal0X128(), "last snapshotted from stale inside");

        // И обе операции проходят.
        pool.collect(address(this), lo, hi, type(uint128).max, type(uint128).max);
        pool.burn(lo, hi, 1e20);
    }

    /// Позиция остаётся рабочей и после роста комиссии: разность не уходит
    /// в минус ни на одном шаге.
    function test_collectWorksAsFeesGrow() public {
        pool.mint(address(this), -600, 600, 1e21);
        _swap0For1(1e18);

        int24 lo = -100;
        int24 hi = 100;
        pool.mint(address(this), lo, hi, 1e20);

        // Накапливаем комиссию: гоняем цену туда-обратно внутри диапазона.
        for (uint256 i = 0; i < 20; i++) {
            pool.swap(address(this), true, 1e15, SQRT_PRICE_1_1 * 99 / 100, "");
            pool.swap(address(this), false, 1e15, SQRT_PRICE_1_1 * 101 / 100, "");
        }

        // Несколько сборов подряд — каждый не должен падать.
        for (uint256 i = 0; i < 3; i++) {
            pool.collect(address(this), lo, hi, type(uint128).max, type(uint128).max);
        }

        pool.burn(lo, hi, 1e20);
    }

    /// Диапазон целиком выше цены: тики инициализируются с outside = 0,
    /// пересчёт ничего не ломает.
    function test_freshRangeAbovePriceStillWorks() public {
        pool.mint(address(this), -600, 600, 1e21);
        _swap0For1(1e18);

        int24 lo = 200;
        int24 hi = 300;
        pool.mint(address(this), lo, hi, 1e20);

        pool.collect(address(this), lo, hi, type(uint128).max, type(uint128).max);
        pool.burn(lo, hi, 1e20);
    }

    /// Повторный вход в тот же диапазон (тики уже есть) — не регрессия.
    function test_existingRangeStillWorks() public {
        pool.mint(address(this), -600, 600, 1e21);
        _swap0For1(1e18);
        pool.mint(address(this), -600, 600, 1e20);

        pool.collect(address(this), -600, 600, type(uint128).max, type(uint128).max);
    }

    /// Пул без накопленных комиссий: снимок нулевой, всё как раньше.
    function test_firstMintWithoutFeesStillWorks() public {
        pool.mint(address(this), -600, 600, 1e21);
        pool.collect(address(this), -600, 600, type(uint128).max, type(uint128).max);
        pool.burn(-600, 600, 1e21);
    }

    /// После полного вывода и повторного входа позиция снова считается
    /// свежей — снимок обязан пересчитаться, иначе та же ошибка вернётся.
    function test_reentryAfterFullExitDoesNotLock() public {
        pool.mint(address(this), -600, 600, 1e21);
        _swap0For1(1e18);

        int24 lo = -100;
        int24 hi = 100;
        pool.mint(address(this), lo, hi, 1e20);
        pool.burn(lo, hi, 1e20);

        // Позиция пуста, но тики могли остаться инициализированными за счёт
        // другой ликвидности. Если gross стал нулём — тики сброшены, и вход
        // снова «свежий».
        _swap0For1(1e17);
        pool.mint(address(this), lo, hi, 1e20);
        pool.collect(address(this), lo, hi, type(uint128).max, type(uint128).max);
        pool.burn(lo, hi, 1e20);
    }
}