// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.24;

// Sementsul DEX — https://sementsul.net/
//
// Исходники: https://github.com/sementsul/sementsul-dex
//
// Роутер со СТАНДАРТНЫМ интерфейсом Uniswap V3 SwapRouter.
//
// ЗАЧЕМ ВТОРОЙ РОУТЕР
// -------------------
// У нас уже есть SementsulV3Router, и он работает: через него торгует наш
// интерфейс. Но его ABI не совпадает с Uniswap:
//
//   Uniswap  exactInputSingle((address,address,uint24,address,uint256,
//                             uint256,uint256,uint160))     → 0x414bf389
//   наш      exactInputSingle((bytes,address,uint256,uint256),uint256)
//                                                            → 0xea7ec9c4
//
// Это разные селекторы, поэтому агрегатор (1inch, OpenOcean, Pancake
// SmartRouter) физически не может вызвать наш роутер, ничего не переписывая.
// А переписывать под каждый DEX он не станет: он зовёт ISwapRouter и ждёт,
// что контракт его поймёт.
//
// Этот роутер говорит на языке Uniswap. Внутри — та же логика, что в нашем:
// находит пул через фабрику, проверяет, что пул наш, и вызывает swap.
//
// ЧТО ВАЖНО ПОНЯТЬ ПРО APPROVE
// ----------------------------
// Разрешение (allowance) привязано к паре «токен + spender». При смене
// роутера старые approve НЕ подхватятся: пользователю придётся один раз
// заново одобрить токены на новый адрес. Это нормально и ожидаемо, но об
// этом надо предупредить — иначе люди увидят «не удалось списать токен»
// и решат, что сломалось.
//
// ПОЧЕМУ НЕ ОДИН РОУТЕР НА ВСЁ
// ----------------------------
// Можно было бы добавить стандартные функции в существующий роутер. Но он
// уже задеплоен, а контракты на цепи не меняются. Вариант «передеплоить
// старый» означал бы, что наш интерфейс перестал работать до обновления
// фронтенда. Два роутера сосуществуют: старый обслуживает наш сайт, новый
// открыт для агрегаторов. Пул один и тот же — оба указывают на ту же
// фабрику, а ликвидность живёт в пуле, не в роутере.

import './interfaces.sol';

// ---------- структуры в раскладке Uniswap ----------
//
// Порядок полей обязан совпадать с Uniswap ПОБАЙТОВО. Селектор считается от
// типов, а не от имён, поэтому перестановка полей молча даст другой
// селектор — и агрегатор снова нас не увидит.

/// @notice Параметры обмена с точным входом в одном пуле.
struct ExactInputSingleParams {
    address tokenIn;
    address tokenOut;
    uint24 fee;
    address recipient;
    uint256 deadline;
    uint256 amountIn;
    uint256 amountOutMinimum;
    uint160 sqrtPriceLimitX96;
}

/// @notice Параметры обмена с точным входом по маршруту.
struct ExactInputParamsStd {
    bytes path;
    address recipient;
    uint256 deadline;
    uint256 amountIn;
    uint256 amountOutMinimum;
}

/// @notice Параметры обмена с точным выходом из одного пула.
struct ExactOutputSingleParams {
    address tokenIn;
    address tokenOut;
    uint24 fee;
    address recipient;
    uint256 deadline;
    uint256 amountOut;
    uint256 amountInMaximum;
    uint160 sqrtPriceLimitX96;
}

/// @notice Параметры обмена с точным выходом по маршруту.
struct ExactOutputParamsStd {
    bytes path;
    address recipient;
    uint256 deadline;
    uint256 amountOut;
    uint256 amountInMaximum;
}

/// @notice Минимальный набор методов пула.
interface SementsulV3PoolStd {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);

    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface ISementsulV3FactoryStd {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
    function isPool(address pool) external view returns (bool);
}

/// @dev Границы цены из TickMath.
uint160 constant MIN_SQRT_RATIO_STD = 4295128739;
uint160 constant MAX_SQRT_RATIO_STD = 1461446703485210103287273052203988822378723970342;

interface IWBNBStd {
    function deposit() external payable;
    function withdraw(uint256) external;
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

/// @notice Роутер с интерфейсом, совпадающим с Uniswap V3 SwapRouter.
///
/// Отличия от Uniswap, о которых надо знать:
///   • WBNB вместо WETH9 — на BSC нативный токен другой;
///   • нет `refundETH`/`unwrapWETH9` с теми же именами, но есть
///     `refundBNB`/`unwrapWBNB`. Имена разные, поэтому агрегатор их не
///     вызовет — и не должен: BNB-обмены он делает через WBNB напрямую;
///   • поддерживаются только наши пулы. Чужой пул отвергается проверкой
///     `isPool`: иначе через нас можно было бы подсунуть контракт, который
///     заберёт деньги.
contract SementsulSwapRouter {
    /// @notice WBNB для BNB-обменов. Пул работает только с ERC-20, поэтому
    /// BNB заворачивается на входе и разворачивается на выходе.
    address public immutable WBNB;

    /// @notice Фабрика, пулы которой обслуживаем. Immutable: новый роутер,
    /// задеплоенный с тем же адресом фабрики, автоматически видит все
    /// существующие пулы. Переносить ничего не нужно.
    address public immutable FACTORY;

    /// @dev Пул, который сейчас обслуживается. Живёт только внутри вызова.
    address private _poolInUse;

    /// @dev Кто платит по текущему шагу: для первого плеча — пользователь,
    /// для последующих — сам роутер.
    address private _payer;

    modifier checkDeadline(uint256 deadline) {
        require(block.timestamp <= deadline, 'SementsulRouter: EXPIRED');
        _;
    }

    constructor(address _factory, address _wbnb) {
        require(_factory != address(0), 'SementsulRouter: FACTORY_ZERO');
        require(_wbnb != address(0), 'SementsulRouter: WBNB_ZERO');
        FACTORY = _factory;
        WBNB = _wbnb;
    }

    receive() external payable {
        // BNB приходит только от WBNB.withdraw() при разворачивании.
        require(msg.sender == WBNB, 'SementsulRouter: NOT_WBNB');
    }

    // ---------- точный вход ----------

    /// @notice Обменять точное количество tokenIn на максимум tokenOut.
    /// @dev Селектор 0x414bf389 — как у Uniswap.
    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        checkDeadline(params.deadline)
        returns (uint256 amountOut)
    {
        amountOut = _swapExactInput(
            params.tokenIn,
            params.tokenOut,
            params.fee,
            params.recipient,
            params.amountIn,
            msg.sender,
            params.sqrtPriceLimitX96
        );

        require(amountOut >= params.amountOutMinimum, 'SementsulRouter: TOO_LITTLE_RECEIVED');
    }

    /// @notice Обменять по маршруту из нескольких пулов.
    /// @dev Селектор 0xc04b8d59 — как у Uniswap.
    function exactInput(ExactInputParamsStd calldata params)
        external
        payable
        checkDeadline(params.deadline)
        returns (uint256 amountOut)
    {
        uint256 hops = _hopCount(params.path);
        uint256 amount = params.amountIn;

        for (uint256 i = 0; i < hops; i++) {
            (address tokenIn, address tokenOut, uint24 fee) = decodeHop(params.path, i);
            // Последний шаг отдаёт пользователю, промежуточные — этому
            // контракту: следующее плечо забирает выход отсюда.
            address recipient = i == hops - 1 ? params.recipient : address(this);
            amount = _swapExactInput(
                tokenIn,
                tokenOut,
                fee,
                recipient,
                amount,
                i == 0 ? msg.sender : address(this),
                0
            );
        }

        require(amount >= params.amountOutMinimum, 'SementsulRouter: TOO_LITTLE_RECEIVED');
        amountOut = amount;
    }

    // ---------- точный выход ----------

    /// @notice Получить ровно tokenOut, потратив не больше amountInMaximum.
    /// @dev Селектор 0xdb3e2198 — как у Uniswap.
    function exactOutputSingle(ExactOutputSingleParams calldata params)
        external
        payable
        checkDeadline(params.deadline)
        returns (uint256 amountIn)
    {
        amountIn = _swapExactOutput(
            params.tokenIn,
            params.tokenOut,
            params.fee,
            params.recipient,
            params.amountOut,
            msg.sender,
            params.sqrtPriceLimitX96
        );

        require(amountIn <= params.amountInMaximum, 'SementsulRouter: TOO_MUCH_REQUESTED');
    }

    /// @notice Получить ровно amountOut по маршруту.
    /// @dev Селектор 0xf28c0498 — как у Uniswap.
    /// @dev Маршрут передаётся В ОБРАТНОМ порядке, от последнего пула к
    /// первому: считать вход нужно с конца.
    function exactOutput(ExactOutputParamsStd calldata params)
        external
        payable
        checkDeadline(params.deadline)
        returns (uint256 amountIn)
    {
        uint256 hops = _hopCount(params.path);
        uint256 amount = params.amountOut;

        for (uint256 i = 0; i < hops; i++) {
            (address tokenIn, address tokenOut, uint24 fee) = decodeHop(params.path, i);
            address recipient = i == hops - 1 ? params.recipient : address(this);
            amount = _swapExactOutput(
                tokenIn,
                tokenOut,
                fee,
                recipient,
                amount,
                i == 0 ? msg.sender : address(this),
                0
            );
        }

        require(amount <= params.amountInMaximum, 'SementsulRouter: TOO_MUCH_REQUESTED');
        amountIn = amount;
    }

    // ---------- служебное ----------

    /// @notice Несколько вызовов в одной транзакции.
    /// @dev Селектор 0xac9650d8 — как у Uniswap.
    function multicall(bytes[] calldata data) external payable returns (bytes[] memory results) {
        results = new bytes[](data.length);
        for (uint256 i = 0; i < data.length; i++) {
            (bool ok, bytes memory result) = address(this).delegatecall(data[i]);
            if (!ok) {
                // Пробрасываем исходную причину, иначе пользователь видит
                // «multicall failed» вместо «слиппедж слишком велик».
                assembly {
                    revert(add(result, 32), mload(result))
                }
            }
            results[i] = result;
        }
    }

    /// @notice Развернуть WBNB в BNB и отдать получателю.
    /// @dev Селектор 0x49404b7c — как у Uniswap unwrapWETH9, но имя другое:
    /// агрегатор зовёт unwrapWETH9, и на BSC это заведомо не сработает.
    /// Оставлено для собственных сценариев и для совместимости с теми, кто
    /// читает ABI, а не имя.
    function unwrapWBNB(uint256 amountMinimum, address recipient) external payable {
        uint256 balance = IWBNBStd(WBNB).balanceOf(address(this));
        require(balance >= amountMinimum, 'SementsulRouter: TOO_LITTLE_WBNB');
        require(balance > 0, 'SementsulRouter: NOTHING_TO_UNWRAP');

        IWBNBStd(WBNB).withdraw(balance);
        (bool ok,) = recipient.call{value: balance}('');
        require(ok, 'SementsulRouter: BNB_SEND_FAILED');
    }

    /// @notice Завернуть BNB в WBNB.
    function wrapBNB(uint256 amountMinimum) external payable {
        require(msg.value >= amountMinimum, 'SementsulRouter: TOO_LITTLE_BNB');
        IWBNBStd(WBNB).deposit{value: msg.value}();
    }

    /// @notice Вернуть оставшийся BNB отправителю.
    function refundBNB() external payable {
        uint256 balance = address(this).balance;
        if (balance > 0) {
            (bool ok,) = msg.sender.call{value: balance}('');
            require(ok, 'SementsulRouter: REFUND_FAILED');
        }
    }

    // ---------- оплата ----------

    /// @notice Оплата обмена, как в Uniswap V3.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        _pay(amount0Delta, amount1Delta, data);
    }

    /// @notice То же под именем Pancake.
    function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        _pay(amount0Delta, amount1Delta, data);
    }

    function _pay(int256 amount0Delta, int256 amount1Delta, bytes calldata) private {
        // Платим только пулу, который сами и вызвали. Иначе посторонний
        // контракт мог бы дёрнуть callback и увести деньги.
        require(msg.sender == _poolInUse, 'SementsulRouter: BAD_POOL');

        uint256 owed = amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
        require(owed > 0, 'SementsulRouter: NOTHING_OWED');

        address payToken =
            amount0Delta > 0 ? SementsulV3PoolStd(msg.sender).token0() : SementsulV3PoolStd(msg.sender).token1();

        // Кто платит. Первое плечо оплачивает пользователь — своих денег у
        // роутера ещё нет. Последующие оплачиваются из того, что роутер
        // получил на предыдущем шаге. Именно ради этого нужен callback: на
        // момент вызова второго пула деньги уже есть, но выдать на них
        // approve заранее было нельзя.
        address payer = _payer;
        if (payer == address(this)) {
            require(IERC20(payToken).transfer(msg.sender, owed), 'SementsulRouter: PAY_FAILED');
        } else {
            require(IERC20(payToken).transferFrom(payer, msg.sender, owed), 'SementsulRouter: PAY_FAILED');
        }
    }

    // ---------- внутреннее ----------

    /// @dev Обмен с точным входом через пул, найденный по фабрике.
    function _swapExactInput(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        address recipient,
        uint256 amountIn,
        address payer,
        uint160 limitFromCaller
    ) private returns (uint256 amountOut) {
        (address token0, address pool) = _resolvePool(tokenIn, tokenOut, fee);
        bool zeroForOne = tokenIn == token0;

        uint160 limit = _limit(zeroForOne, limitFromCaller);

        _poolInUse = pool;
        _payer = payer;
        (int256 amount0, int256 amount1) =
            SementsulV3PoolStd(pool).swap(recipient, zeroForOne, int256(amountIn), limit, '');
        _poolInUse = address(0);
        _payer = address(0);

        amountOut = uint256(-(zeroForOne ? amount1 : amount0));
    }

    /// @dev Обмен с точным выходом.
    function _swapExactOutput(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        address recipient,
        uint256 amountOut,
        address payer,
        uint160 limitFromCaller
    ) private returns (uint256 amountIn) {
        (address token0, address pool) = _resolvePool(tokenIn, tokenOut, fee);
        bool zeroForOne = tokenIn == token0;

        uint160 limit = _limit(zeroForOne, limitFromCaller);

        _poolInUse = pool;
        _payer = payer;
        (int256 amount0, int256 amount1) =
            SementsulV3PoolStd(pool).swap(recipient, zeroForOne, -int256(amountOut), limit, '');
        _poolInUse = address(0);
        _payer = address(0);

        // Про знаки. В соглашении пула положительная дельта значит «пул
        // получил», отрицательная — «пул отдал». При точном ВЫХОДЕ вход
        // приходит ПОЛОЖИТЕЛЬНЫМ, а выход отрицательным. Значит сумма входа —
        // это amount0 при zeroForOne и amount1 иначе, без отрицания.
        amountIn = uint256(zeroForOne ? amount0 : amount1);
    }

    /// @dev Предел цены: 0 от вызывающего означает «край диапазона».
    /// @dev Проверять лимит обязательно: если он сдвинут не в ту сторону,
    /// пул откатится своей проверкой, и наружу уйдёт непонятная ошибка.
    function _limit(bool zeroForOne, uint160 fromCaller) private pure returns (uint160 limit) {
        if (fromCaller == 0) {
            return zeroForOne ? MIN_SQRT_RATIO_STD + 1 : MAX_SQRT_RATIO_STD - 1;
        }

        if (zeroForOne) {
            require(fromCaller < MAX_SQRT_RATIO_STD && fromCaller > MIN_SQRT_RATIO_STD, 'SementsulRouter: BAD_LIMIT');
        } else {
            require(fromCaller > MIN_SQRT_RATIO_STD && fromCaller < MAX_SQRT_RATIO_STD, 'SementsulRouter: BAD_LIMIT');
        }
        return fromCaller;
    }

    /// @dev Найти пул и упорядочить токены.
    function _resolvePool(address tokenIn, address tokenOut, uint24 fee)
        private
        view
        returns (address token0, address pool)
    {
        require(tokenIn != tokenOut, 'SementsulRouter: SAME_TOKEN');

        token0 = tokenIn < tokenOut ? tokenIn : tokenOut;
        address token1 = tokenIn < tokenOut ? tokenOut : tokenIn;

        pool = ISementsulV3FactoryStd(FACTORY).getPool(token0, token1, fee);
        require(pool != address(0), 'SementsulRouter: POOL_NOT_FOUND');
        require(ISementsulV3FactoryStd(FACTORY).isPool(pool), 'SementsulRouter: NOT_OUR_POOL');
    }

    /// @dev Сколько шагов в упакованном маршруте.
    function _hopCount(bytes memory path) private pure returns (uint256) {
        require(path.length >= 43 && (path.length - 20) % 23 == 0, 'SementsulRouter: BAD_PATH');
        return (path.length - 20) / 23;
    }

    /// @dev Достать шаг с номером index из упакованного маршрута.
    /// @dev Раскладка та же, что в первом роутере, и проверена тестами:
    /// 20 байт адрес, 3 байта fee, 20 байт адрес, ... Смещения считаются от
    /// начала данных, а +32 в памяти — это слово длины массива.
    function decodeHop(bytes memory path, uint256 index)
        private
        pure
        returns (address tokenIn, address tokenOut, uint24 fee)
    {
        uint256 offset = index * 23;
        assembly {
            tokenIn := shr(96, mload(add(add(path, 32), offset)))
            fee := shr(232, mload(add(add(path, 52), offset)))
            tokenOut := shr(96, mload(add(add(path, 55), offset)))
        }
    }
}