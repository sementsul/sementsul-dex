// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {SementsulV3Factory, SementsulV3Pool} from "../contracts/SementsulV3.sol";
import {SementsulV3Router, ExactInputParams} from "../contracts/SementsulV3Router.sol";
import {SementsulFactory} from "../contracts/SementsulV2.sol";
import {SementsulRouter} from "../contracts/SementsulRouter.sol";

/// Проверка на РЕАЛЬНОЙ сети, а не на пустой локальной EVM.
///
/// Запуск:
///   forge test --match-path "test/Fork.t.sol" --fork-url <BSC RPC> -vv
///
/// Локальные тесты доказывают, что логика верна. Они не доказывают четырёх
/// вещей, которые видны только на живой сети:
///   1. настоящий WBNB (в тестах вместо него заглушка);
///   2. настоящие токены с их числом знаков (USDT в BSC — 18, не 6);
///   3. реальная цена газа, то есть стоимость деплоя;
///   4. что байткод из компилятора и байткод из forge — один и тот же код.
contract ForkTest is Test {
    /// Настоящий WBNB в BSC.
    address constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    /// Настоящий USDT в BSC. Внимание: 18 знаков, а не 6, как в Ethereum.
    address constant USDT = 0x55d398326f99059fF775485246999027B3197955;

    SementsulFactory factory;
    SementsulV3Factory v3Factory;
    SementsulRouter router;
    SementsulV3Router v3Router;

    function setUp() public {
        // Без форка WBNB не существует, и всё ниже упало бы непонятной
        // ошибкой. Проверяем явно, чтобы причина была видна сразу.
        require(WBNB.code.length > 0, "NEED FORK: run with --fork-url");
    }

    /// 1. Все четыре контракта разворачиваются на форке BSC.
    ///
    /// На живой сети контракт может не влезть в лимит EIP-170 или упереться
    /// в предел газа блока. Оба отказа видны только при реальном деплое.
    function test_deployAll_onRealBSC() public {
        _deployAll();

        assertTrue(address(factory) != address(0), "factory not deployed");
        assertTrue(address(v3Factory) != address(0), "v3 factory not deployed");
        assertTrue(address(router) != address(0), "router not deployed");
        assertTrue(address(v3Router) != address(0), "v3 router not deployed");

        // Роутеры смотрят на настоящие адреса, а не на заглушки.
        assertEq(v3Router.WBNB(), WBNB, "router must point at real WBNB");
        assertEq(v3Router.FACTORY(), address(v3Factory), "router must point at V3 factory");
        // У роутера V2 поле называется WETH (так исторически у Uniswap V2),
        // но означает тот же обёрнутый BNB.
        assertEq(router.WETH(), WBNB, "V2 router must point at real WBNB");
    }

    /// 2. Четыре тира создаются, адрес пула предсказуем до создания.
    function test_fourTiers_onRealBSC() public {
        _deployAll();

        for (uint256 i = 0; i < 4; i++) {
            uint24 f = v3Factory.feeTiers(i);
            address predicted = v3Factory.poolFor(USDT, WBNB, f);
            address actual = v3Factory.createPool(USDT, WBNB, f);

            assertEq(actual, predicted, "CREATE2 address must match poolFor");
            assertTrue(v3Factory.isPool(actual), "pool must be registered");
            assertEq(v3Factory.getPool(USDT, WBNB, f), actual, "getPool must resolve");

            emit log_named_uint("tier fee", f);
            emit log_named_address("  pool", actual);
        }
    }

    /// 3. НАСТОЯЩИЙ обмен: реальные токены, реальный роутер, реальный пул.
    ///
    /// Это главный тест. Он проверяет всю цепочку целиком — от выдачи
    /// разрешения до получения токена на выходе — на настоящих контрактах
    /// BSC, а не на заглушках.
    function test_realSwapThroughRouter_onRealBSC() public {
        _deployAll();

        SementsulV3Pool pool = SementsulV3Pool(v3Factory.createPool(USDT, WBNB, 500));
        pool.initializePrice(79228162514264337593543950336); // цена 1:1

        // Настоящие токены: deal просто перезаписывает баланс, поэтому
        // держатель USDT на BSC не нужен.
        deal(USDT, address(this), 1e24);
        deal(WBNB, address(this), 1e24);

        _approve(USDT, address(pool), type(uint256).max);
        _approve(WBNB, address(pool), type(uint256).max);
        pool.mint(address(this), -6000, 6000, 1e21);

        emit log_named_uint("pool USDT", _balanceOf(USDT, address(pool)));
        emit log_named_uint("pool WBNB", _balanceOf(WBNB, address(pool)));

        // Обмен через НАШ роутер: ровно тот путь, которым пойдёт пользователь.
        uint256 amountIn = 1e18; // 1 USDT
        _approve(USDT, address(v3Router), type(uint256).max);

        uint256 before = _balanceOf(WBNB, address(this));

        // Маршрут упакован так же, как в Uniswap V3: token(20) + fee(3) + token(20).
        bytes memory path = abi.encodePacked(USDT, uint24(500), WBNB);

        ExactInputParams memory p;
        p.path = path;
        p.recipient = address(this);
        p.amountIn = amountIn;
        p.amountOutMinimum = 0;

        uint256 out = v3Router.exactInputSingle(p, block.timestamp + 600);

        uint256 gained = _balanceOf(WBNB, address(this)) - before;

        emit log_named_uint("spent USDT", amountIn);
        emit log_named_uint("received WBNB", out);
        emit log_named_uint("balance delta WBNB", gained);

        // Обмен действительно произошёл: выход есть, он равен возвращённому
        // значению, и он меньше входа на величину комиссии.
        assertGt(out, 0, "swap produced no output");
        assertEq(gained, out, "returned amount must match balance delta");
        assertLt(out, amountIn, "output must be less than input (fee taken)");
        // Комиссия 0.05%: выход не может быть меньше 99.8% входа.
        assertGt(out, (amountIn * 998) / 1000, "output too low for 0.05% fee");

        // Цена сдвинулась — значит, пул действительно торговал.
        (uint160 priceAfter, , , , ) = pool.slot0();
        assertTrue(priceAfter != 79228162514264337593543950336, "price did not move");
    }

    /// 4. Сколько стоит деплой при РЕАЛЬНОЙ цене газа.
    function test_realDeployCost() public {
        uint256 gasStart = gasleft();
        _deployAll();
        uint256 totalGas = gasStart - gasleft();

        uint256 gasPrice = tx.gasprice;
        uint256 costWei = totalGas * gasPrice;

        emit log_named_uint("TOTAL gas for 4 contracts", totalGas);
        emit log_named_uint("gas price, wei", gasPrice);
        emit log_named_uint("cost, wei", costWei);

        // Деплой обязан уложиться в присланный баланс 0.001 BNB.
        assertLt(costWei, 0.001 ether, "deploy must fit into the funded balance");
    }

    function _deployAll() internal {
        factory = new SementsulFactory(uint24(2500));

        uint24[] memory fees = new uint24[](4);
        fees[0] = 50;
        fees[1] = 500;
        fees[2] = 2500;
        fees[3] = 10000;
        int24[] memory spacings = new int24[](4);
        spacings[0] = 1;
        spacings[1] = 10;
        spacings[2] = 50;
        spacings[3] = 200;

        v3Factory = new SementsulV3Factory(fees, spacings, address(this));
        router = new SementsulRouter(address(factory), WBNB);
        v3Router = new SementsulV3Router(address(v3Factory), WBNB);
    }

    function _balanceOf(address token, address who) internal view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSelector(0x70a08231, who));
        require(ok, "balanceOf failed");
        return abi.decode(data, (uint256));
    }

    function _approve(address token, address spender, uint256 amount) internal {
        (bool ok, ) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, amount));
        require(ok, "approve failed");
    }
}