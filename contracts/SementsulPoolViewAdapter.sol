// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.24;

// Sementsul DEX — https://sementsul.net/
//
// Исходники: https://github.com/sementsul/sementsul-dex
//
// Адаптер: показывает наш пул в раскладке Uniswap V3.
//
// ЧТО ОН ДЕЛАЕТ
// -------------
// Наш пул отдаёт slot0() из ПЯТИ полей, а Uniswap — из СЕМИ:
//
//   Uniswap: sqrtPriceX96, tick, observationIndex, observationCardinality,
//            observationCardinalityNext, feeProtocol, unlocked
//   наш:     sqrtPriceX96, tick, liquidity, fee, tickSpacing
//
// Код, написанный под стандартный ABI, читает наш ответ как Uniswap-овский
// и получает мусор: на третьем слове вместо observationIndex оказывается
// liquidity, и дальше всё едет. Этот адаптер переупаковывает ответ в
// ожидаемую раскладку.
//
// ЧТО ОН НЕ ДЕЛАЕТ И НЕ МОЖЕТ
// ---------------------------
// У нашего пула НЕТ оракула: селекторов observe,
// increaseObservationCardinalityNext и snapshotCumulativesInside в байткоде
// пула нет вовсе. Пул не хранит историю цены — брать её неоткуда.
//
// Поэтому observe() здесь ЧЕСТНО откатывается с внятной причиной, а не
// возвращает нули и не подставляет текущую цену под видом средней.
//
// Это сознательное решение, и его стоит объяснить, потому что соблазн
// «сделать вид, что оракул есть» велик:
//
//   • если вернуть нули, стратегия, которая считает TWAP, получит 0 и
//     разделит на него — или, хуже, воспримет 0 как настоящую цену;
//   • если вернуть текущую цену как «среднюю», получится подделка: TWAP
//     существует именно чтобы сглаживать манипуляции, а цена одного блока
//     и есть то, что TWAP должен игнорировать. Стратегия, построенная на
//     такой подделке, будет обманута — и потеряет деньги;
//   • виноват в этом будет тот, кто задеплоил адаптер.
//
// Поэтому observe() откатывается. Код, которому действительно нужен TWAP,
// увидит ошибку и не станет работать с пулом. Это правильный исход: лучше
// честный отказ, чем тихая подделка.
//
// ЧТО ЭТО ЗНАЧИТ НА ПРАКТИКЕ
// ---------------------------
// Адаптер полезен тому, кто читает состояние: slot0, ticks, positions.
// Он бесполезен тому, кому нужен именно TWAP. Вторым нужен настоящий
// оракул в пуле, а его нельзя добавить без передеплоя пула.

import './interfaces.sol';

/// @dev Раскладка тика как у Uniswap: 8 полей.
/// @dev У нашего пула TickInfo — 5 полей. Недостающие заполняются так,
/// чтобы это было видно: tickCumulativeOutside и secondsPerLiquidityOutsideX128
/// остаются нулями, потому что истории нет. Код, который их использует для
/// расчёта TWAP, получит нули — и обязан проверить observe() заранее, что
/// он и делает, если написан правильно.
struct TickInfoStd {
    uint128 liquidityGross;
    int128 liquidityNet;
    uint256 feeGrowthOutside0X128;
    uint256 feeGrowthOutside1X128;
    int56 tickCumulativeOutside;
    uint160 secondsPerLiquidityOutsideX128;
    uint32 secondsOutside;
    bool initialized;
}

/// @notice Интерфейс нашего пула — только то, что адаптер читает.
interface ISementsulV3PoolAdapter {
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint128 liquidity,
            uint24 fee,
            int24 tickSpacing
        );

    function ticks(int24 tick)
        external
        view
        returns (
            uint128 liquidityGross,
            int128 liquidityNet,
            uint256 feeGrowthOutside0X128,
            uint256 feeGrowthOutside1X128,
            bool initialized
        );

    function positions(bytes32 key)
        external
        view
        returns (
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1,
            uint128 pending0,
            uint128 pending1,
            uint256 vestBlock
        );

    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function tickSpacing() external view returns (int24);
    function liquidity() external view returns (uint128);
    function factory() external view returns (address);
}

/// @notice Показывает один наш пул в раскладке Uniswap V3.
///
/// Почему отдельный контракт, а не «пусть читают как есть». Потому что
/// читать как есть нельзя: раскладка другая, и ошибка молчаливая — числа
/// приходят, просто не те. Молчаливая ошибка хуже явной.
contract SementsulPoolViewAdapter {
    /// @notice Пул, который показываем. Задан навсегда: адаптер — это
    /// очки для одного пула, а не универсальный читатель. Такой выбор
    /// убирает целый класс ошибок: агрегатор не сможет подсунуть чужой
    /// пул и получить за него заведомо неверные числа.
    address public immutable POOL;

    constructor(address _pool) {
        require(_pool != address(0), 'SementsulAdapter: POOL_ZERO');
        POOL = _pool;
    }

    // ---------- раскладка Uniswap ----------

    /// @notice slot0 в раскладке Uniswap: 7 полей.
    /// @dev observationIndex, observationCardinality, observationCardinalityNext
    /// и feeProtocol заполняются нулями: наблюдений нет, протокольной
    /// комиссии у нас нет. unlocked = true: пул не имеет блокировки
    /// на весь контракт, только на уровне вызова.
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint32 feeProtocol,
            bool unlocked
        )
    {
        (sqrtPriceX96, tick,,,) = ISementsulV3PoolAdapter(POOL).slot0();
        return (sqrtPriceX96, tick, 0, 0, 0, 0, true);
    }

    /// @notice ticks в раскладке Uniswap: 8 полей.
    /// @dev tickCumulativeOutside и secondsPerLiquidityOutsideX128 = 0:
    /// истории нет. secondsOutside = 0 по той же причине.
    function ticks(int24 tick) external view returns (TickInfoStd memory) {
        (
            uint128 liquidityGross,
            int128 liquidityNet,
            uint256 feeGrowthOutside0X128,
            uint256 feeGrowthOutside1X128,
            bool initialized
        ) = ISementsulV3PoolAdapter(POOL).ticks(tick);

        return TickInfoStd({
            liquidityGross: liquidityGross,
            liquidityNet: liquidityNet,
            feeGrowthOutside0X128: feeGrowthOutside0X128,
            feeGrowthOutside1X128: feeGrowthOutside1X128,
            tickCumulativeOutside: 0,
            secondsPerLiquidityOutsideX128: 0,
            secondsOutside: 0,
            initialized: initialized
        });
    }

    /// @notice positions в раскладке Uniswap: 5 полей.
    /// @dev Наш пул отдаёт 8 полей (есть pending0, pending1, vestBlock —
    /// наша механика вестинга комиссий). В раскладку Uniswap они не влезают,
    /// поэтому здесь только пять стандартных. Кому нужны pending — читает
    /// пул напрямую, и это правильно: это наше расширение, а не Uniswap.
    function positions(bytes32 key)
        external
        view
        returns (
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        )
    {
        (liquidity, feeGrowthInside0LastX128, feeGrowthInside1LastX128, tokensOwed0, tokensOwed1,,,) =
            ISementsulV3PoolAdapter(POOL).positions(key);
    }

    // ---------- то, чего нет ----------

    /// @notice Оракула в пуле нет. Откат с внятной причиной.
    /// @dev Почему не нули: см. комментарий в начале файла. Коротко —
    /// нули выглядят как данные, и на них построят стратегию.
    function observe(uint32[] calldata)
        external
        pure
        returns (int56[] memory, uint160[] memory)
    {
        revert('SementsulAdapter: NO_ORACLE');
    }

    /// @notice Наблюдений в пуле нет, увеличивать нечего.
    function increaseObservationCardinalityNext(uint16) external pure {
        revert('SementsulAdapter: NO_ORACLE');
    }

    /// @notice Снимок накопленных значений невозможен: их не существует.
    function snapshotCumulativesInside(int24, int24) external pure returns (int56, uint160, uint32) {
        revert('SementsulAdapter: NO_ORACLE');
    }

    // ---------- прозрачные прокси ----------

    /// @dev Эти методы совпадают у нас и у Uniswap, поэтому просто
    /// пробрасываются. Отдельные функции нужны, чтобы читатель не
    /// переключался между двумя адресами.
    function token0() external view returns (address) {
        return ISementsulV3PoolAdapter(POOL).token0();
    }

    function token1() external view returns (address) {
        return ISementsulV3PoolAdapter(POOL).token1();
    }

    function fee() external view returns (uint24) {
        return ISementsulV3PoolAdapter(POOL).fee();
    }

    function tickSpacing() external view returns (int24) {
        return ISementsulV3PoolAdapter(POOL).tickSpacing();
    }

    function liquidity() external view returns (uint128) {
        return ISementsulV3PoolAdapter(POOL).liquidity();
    }

    function factory() external view returns (address) {
        return ISementsulV3PoolAdapter(POOL).factory();
    }

    /// @notice Максимальная ликвидность на тик — константа Uniswap.
    function maxLiquidityPerTick() external pure returns (uint128) {
        return 11505743598341114571880798222544994;
    }
}