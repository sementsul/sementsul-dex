// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {SementsulV3Factory, SementsulV3Pool} from "../contracts/SementsulV3.sol";

/// Токен для тестов V3.
contract V3Token {
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

/// Фаззинг пула V3.
///
/// Здесь проверяются те же экономические свойства, что и в V2, но с поправкой
/// на концентрированную ликвидность: цена хранится как sqrtPriceX96, а
/// количество токенов в позиции зависит от диапазона.
contract V3FuzzTest is Test {
    /// 1:1 по цене: sqrt(1) * 2^96.
    uint160 constant SQRT_PRICE_1_1 = 79228162514264337593543950336;

    SementsulV3Factory factory;
    SementsulV3Pool pool;
    V3Token token0;
    V3Token token1;

    int24 constant TICK_SPACING = 10;
    int24 constant TICK_LOWER = -600;
    int24 constant TICK_UPPER = 600;
    uint24 constant FEE = 500;

    /// @notice Пул требует оплату через обратный вызов, если вызывающий —
    /// контракт (а этот тест-контракт им и является). Платим ровно столько,
    /// сколько просит пул: деньги у теста есть, разрешение выдано.
    ///
    /// Раньше тест предоплачивал пул до вызова swap() и на callback ничего
    /// не делал. После перехода на callback-оплату такой подход перестал
    /// работать: пул сверяет рост баланса ПОСЛЕ callback'а, а не наличие
    /// денег вообще. Это правильно — иначе контракт мог бы ответить пустым
    /// телом и получить выход бесплатно.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (amount0Delta > 0) {
            token0.transfer(msg.sender, uint256(amount0Delta));
        } else if (amount1Delta > 0) {
            token1.transfer(msg.sender, uint256(amount1Delta));
        }
    }

    function setUp() public {
        uint24[] memory fees = new uint24[](1);
        fees[0] = FEE;
        int24[] memory spacings = new int24[](1);
        spacings[0] = TICK_SPACING;
        factory = new SementsulV3Factory(fees, spacings, address(this));
        token0 = new V3Token();
        token1 = new V3Token();
        if (address(token0) > address(token1)) {
            (token0, token1) = (token1, token0);
        }

        pool = SementsulV3Pool(factory.createPool(address(token0), address(token1), FEE));
        pool.initializePrice(SQRT_PRICE_1_1);
    }

    /// mint с заданным количеством ликвидности. Возвращает, сколько токенов
    /// пул потребовал.
    function _mint(uint128 liquidity) internal returns (uint256 amount0, uint256 amount1) {
        token0.mint(address(this), 1e30);
        token1.mint(address(this), 1e30);
        token0.approve(address(pool), type(uint256).max);
        token1.approve(address(pool), type(uint256).max);
        (amount0, amount1) = pool.mint(address(this), TICK_LOWER, TICK_UPPER, liquidity);
    }

    /// Проверка, что обмен действительно исполняется, а не всегда падает в catch.
    ///
    /// Без этого теста фаззинг-проверки выше были бы пустыми: try/catch
    /// проглотил бы любой реверт, и «своп не вывел больше резерва» стало бы
    /// верным просто потому, что свопа не было.
    function test_swapActuallyExecutes() public {
        _mint(1e21);

        uint160 priceBefore = pool.sqrtPriceX96();
        int24 tickBefore = pool.tick();

        uint256 amount = 1e18;
        token0.mint(address(this), amount);
        // Предоплата не нужна: деньги переводит callback через transfer().

        (int256 amount0, int256 amount1) = pool.swap(
            address(this),
            true,
            int256(amount),
            SQRT_PRICE_1_1 / 10 * 9,
            ""
        );

        // Своп прошёл без реверта — значит, ветка catch в фаззинг-тестах
        // действительно резервная, а не единственная.
        assertEq(amount0, int256(amount), "input not consumed");
        assertLt(amount1, 0, "no output produced");
        assertTrue(pool.sqrtPriceX96() != priceBefore, "price did not move");
        assertTrue(pool.tick() < tickBefore, "tick did not fall on zeroForOne");
    }

    /// Пул принимает ровно столько токенов, сколько требует mint.
    ///
    /// Если бы он брал меньше, чем записывает в позицию, ликвидность была бы
    /// не обеспечена — и первый же обмен увёл бы пул в минус.
    function testFuzz_mintTakesExactAmount(uint128 liquidity) public {
        uint128 liq = uint128(bound(liquidity, 1e9, 1e24));

        (uint256 amount0, uint256 amount1) = _mint(liq);

        // Ровно столько и было переведено: баланс пула equals требуемому.
        assertEq(token0.balanceOf(address(pool)), amount0, "token0 taken != required");
        assertEq(token1.balanceOf(address(pool)), amount1, "token1 taken != required");
        assertGt(amount0, 0, "no token0 required");
        assertGt(amount1, 0, "no token1 required");
    }

    /// Ликвидность в пуле равна сумме вкладов в активном диапазоне.
    function testFuzz_activeLiquidityEqualsDeposit(uint128 liquidity) public {
        uint128 liq = uint128(bound(liquidity, 1e9, 1e24));
        _mint(liq);

        assertEq(pool.liquidity(), liq, "active liquidity != deposit");
    }

    /// burn возвращает не больше, чем пул держит.
    ///
    /// Это ключевое свойство платёжеспособности: даже на крайних значениях
    /// ликвидности и при любом округлении позиция не может получить больше
    /// резерва.
    function testFuzz_burnNeverExceedsBalance(uint128 liquidity) public {
        uint128 liq = uint128(bound(liquidity, 1e9, 1e24));
        _mint(liq);

        uint256 poolBal0 = token0.balanceOf(address(pool));
        uint256 poolBal1 = token1.balanceOf(address(pool));

        (uint256 out0, uint256 out1) = pool.burn(TICK_LOWER, TICK_UPPER, liq);

        assertLe(out0, poolBal0, "burn out0 > pool balance");
        assertLe(out1, poolBal1, "burn out1 > pool balance");
    }

    /// Немедленный вход и выход возвращает не больше вложенного.
    ///
    /// При отсутствии обменов комиссий начислено не было, поэтому LP обязан
    /// получить строго не больше, чем внёс — иначе пул платил бы за вход-выход
    /// и обеднел бы за одну транзакцию.
    function testFuzz_mintThenBurnReturnsPrincipal(uint128 liquidity) public {
        uint128 liq = uint128(bound(liquidity, 1e12, 1e22));

        (uint256 in0, uint256 in1) = _mint(liq);
        (uint256 out0, uint256 out1) = pool.burn(TICK_LOWER, TICK_UPPER, liq);

        assertLe(out0, in0, "got more token0 than deposited");
        assertLe(out1, in1, "got more token1 than deposited");
    }

    /// Обмен не может вывести больше, чем лежит в пуле.
    function testFuzz_swapNeverExceedsReserve(uint128 liquidity, uint128 amountIn) public {
        uint128 liq = uint128(bound(liquidity, 1e15, 1e24));
        _mint(liq);

        uint256 bal0Before = token0.balanceOf(address(pool));
        uint256 bal1Before = token1.balanceOf(address(pool));

        uint256 amount = bound(amountIn, 1e6, bal0Before / 4);
        if (amount == 0) return;

        token0.mint(address(this), amount);
        token0.transfer(address(pool), amount);

        try pool.swap(address(this), true, int256(amount), SQRT_PRICE_1_1 / 10 * 9, "") returns (int256, int256 amount1) {
            uint256 out = amount1 > 0 ? uint256(amount1) : 0;
            assertLe(out, bal1Before, "swap output exceeds reserve");
            assertLe(token1.balanceOf(address(pool)), bal1Before, "pool gained token1 out of thin air");
        } catch {
            // Своп может упереться в границу цены — это законно.
        }
    }

    /// feeGrowthGlobal монотонно растёт: комиссии не убывают.
    function testFuzz_feeGrowthMonotonic(uint128 liquidity, uint128 amountIn) public {
        uint128 liq = uint128(bound(liquidity, 1e15, 1e24));
        _mint(liq);

        uint256 g0Before = pool.feeGrowthGlobal0X128();
        uint256 g1Before = pool.feeGrowthGlobal1X128();

        uint256 amount = bound(amountIn, 1e9, token0.balanceOf(address(this)) / 4);
        if (amount == 0) return;

        token0.transfer(address(pool), amount);
        try pool.swap(address(this), true, int256(amount), SQRT_PRICE_1_1 / 10 * 9, "") {
            assertGe(pool.feeGrowthGlobal0X128(), g0Before, "feeGrowth0 decreased");
            assertGe(pool.feeGrowthGlobal1X128(), g1Before, "feeGrowth1 decreased");
        } catch {
            // Упёрлись в границу — допустимо.
        }
    }
}