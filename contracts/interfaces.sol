// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.24;

// Sementsul DEX — https://sementsul.net/
//
// Исходники: https://github.com/sementsul/sementsul-dex
//
// Общие интерфейсы протокола Sementsul.
// Файл самодостаточен: никаких импортов, чтобы контракты собирались без
// внешних зависимостей и node_modules.
//
// Единица комиссии везде одна: 1e-6 (сотая базисного пункта).
//   fee = 2500  → 0.25%  (как Pancake V2)
//   fee = 500   → 0.05%
//   fee = 50    → 0.005% (ниже минимально возможного у Pancake V3)
// Базисные пункты здесь не годятся: 0.005% — это 0.5 bps, а дробных bps нет.

interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}

interface IWBNB is IERC20 {
    function deposit() external payable;
    function withdraw(uint256) external;
}

interface ISementsulPair {
    function initialize(address token0, address token1) external;
    function token0() external view returns (address);
    function token1() external view returns (address);
    function factory() external view returns (address);
    function fee() external view returns (uint24);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function mint(address to) external returns (uint256 liquidity);
    function burn(address to) external returns (uint256 amount0, uint256 amount1);
    function swap(uint256 amount0Out, uint256 amount1Out, address to) external;
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

interface ISementsulFactory {
    function fee() external view returns (uint24);
    function getPair(address tokenA, address tokenB) external view returns (address);
    function pairFor(address tokenA, address tokenB) external view returns (address);
    function createPair(address tokenA, address tokenB) external returns (address);
    function allPairs(uint256) external view returns (address);
    function allPairsLength() external view returns (uint256);
    function isPair(address) external view returns (bool);
}

interface ISementsulV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function tickSpacing() external view returns (int24);
    function liquidity() external view returns (uint128);
    function slot0() external view returns (
        uint160 sqrtPriceX96,
        int24 tick,
        uint16 observationIndex,
        uint16 observationCardinality,
        uint16 observationCardinalityNext,
        uint8 feeProtocol,
        bool unlocked
    );
}

interface ISementsulV3Factory {
    function tickSpacingFor(uint24 fee) external view returns (int24);
    function jitDelayBlocks(uint24 fee) external view returns (uint64);
    function feeTiers(uint256 index) external view returns (uint24);
    function feeTiersLength() external view returns (uint256);
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);
    function poolFor(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
    function isPool(address pool) external view returns (bool);
    /// @notice Коэффициент штрафа за разворот в блоке для тира. 0 — выключено.
    function reversalPenaltyK(uint24 fee) external view returns (uint24);
    /// @notice Потолок ставки штрафа в единицах 1e-6 (100_000 = 10%).
    function maxReversalPenalty() external view returns (uint24);
    /// @notice Отметить своп пула в текущей транзакции и узнать, является ли
    /// она маршрутом более чем через один пул нашей фабрики.
    function noteSwap(address pool) external returns (bool multiPoolRoute);
}

/// @notice Обратный вызов для оплаты обмена, как в Uniswap V3.
///
/// Зачем он нужен, если у нас уже есть transferFrom. Причина не в удобстве, а
/// в совместимости: агрегаторы (1inch, OpenOcean, ParaSwap) и готовые
/// арбитражные боты собирают маршрут через НЕСКОЛЬКО пулов в одной
/// транзакции. Деньги у них появляются только после первого плеча — то есть
/// в момент вызова второго пула. Заранее выдать approve на сумму, которой ещё
/// нет, они не могут. Uniswap V3 решает это callback'ом: пул сам просит
/// оплату, когда уже отдал выход. Без такого вызова наши пулы для них
/// невидимы: маршрут не собирается, сделка отваливается на нехватке allowance.
interface IUniswapV3SwapCallback {
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

/// @notice То же под именем Pancake. Часть инструментов экосистемы BSC
/// проверяет наличие именно этого селектора, поэтому пул реализует оба.
interface IPancakeV3SwapCallback {
    function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}