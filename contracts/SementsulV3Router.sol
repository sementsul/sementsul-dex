// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.24;

import './interfaces.sol';
import './SementsulV3Math.sol';

// SementsulV3Router — маршрутизатор для концентрированных пулов.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ КОНТРАКТ.
// Пул умеет ровно один обмен в одном направлении. Всё остальное — «продай
// ровно столько», «купи ровно столько», «проведи через два пула», «верни
// остаток» — собирается из этого примитива, но требует кода, который знает
// порядок вызовов и умеет отвечать на callback оплаты.
//
// ЧТО ЗДЕСЬ ЕСТЬ.
//   exactInputSingle  — точный вход, один пул
//   exactInput        — точный вход, маршрут из нескольких пулов
//   exactOutputSingle — точный выход, один пул
//   exactOutput       — точный выход, маршрут (в обратном порядке)
//   multicall         — несколько обменов в одной транзакции
//   unwrapWBNB        — вернуть BNB вместо обёрнутого
//
// ПОЧЕМУ БЕЗ ПАМЯТИ О ПОЛЬЗОВАТЕЛЯХ.
// Роутер не хранит ничего между вызовами. Всё, что нужно для оплаты
// callback'а, лежит в calldata самого вызова: пул возвращает её обратно
// нетронутой. Поэтому роутер нельзя «заклинить» чужой транзакцией, и он не
// требует отдельного состояния на каждого пользователя.
//
// ПРО БЕЗОПАСНОСТЬ ОПЛАТЫ.
// Пул сам сверяет рост своего баланса после callback'а. Роутер лишь
// переводит деньги от того, кто их дал. Если пользователь не выдал
// разрешение — обмен упадёт целиком, а не «наполовину».

/// @notice Параметры обмена с точным входом.
struct ExactInputParams {
    bytes path; // упакованный маршрут: token(20) + fee(3) + token(20) + fee(3) + ...
    address recipient;
    uint256 amountIn;
    uint256 amountOutMinimum;
}

/// @notice Параметры обмена с точным выходом.
struct ExactOutputParams {
    bytes path;
    address recipient;
    uint256 amountOut;
    uint256 amountInMaximum;
}

/// @notice Минимальный набор методов пула, нужный роутеру.
interface SementsulV3PoolLike {
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

contract SementsulV3Router {
    /// @notice Адрес WBNB. Через него идут ETH-обмены: пул работает только
    /// с ERC-20, поэтому BNB заворачивается на входе и разворачивается на
    /// выходе.
    address public immutable WBNB;

    /// @notice Фабрика, пулы которой обслуживает роутер. Нужна, чтобы найти
    /// пул по паре и тиру и убедиться, что он создан именно нами: доверять
    /// переданному адресу нельзя — подсунутый контракт может забрать всё.
    address public immutable FACTORY;

    /// @notice Дедлайн применяется ко всему вызову целиком, а не к шагу:
    /// иначе в мульти-хопе можно было бы протащить первый шаг до истечения,
    /// а второй — после.
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

    // ---------- обмен с точным входом ----------

    /// @notice Обменять точное количество tokenIn на максимум tokenOut
    /// в одном пуле.
    /// @param params.amountOutMinimum Нижняя граница выхода. Обмен откатится,
    ///        если получилось меньше: это и есть защита трейдера от
    ///        проскальзывания, независимо от того, что успел сделать бот.
    function exactInputSingle(ExactInputParams memory params, uint256 deadline)
        external
        payable
        checkDeadline(deadline)
        returns (uint256 amountOut)
    {
        require(params.path.length == 43, 'SementsulRouter: NOT_SINGLE');
        (address tokenIn, address tokenOut, uint24 fee) = decodeHop(params.path, 0);

        amountOut = _swapExactInput(tokenIn, tokenOut, fee, params.recipient, params.amountIn, msg.sender);

        require(amountOut >= params.amountOutMinimum, 'SementsulRouter: TOO_LITTLE_RECEIVED');
    }

    /// @notice Обменять точное количество tokenIn по маршруту из нескольких
    /// пулов.
    /// @dev Маршрут упакован как token(20) + fee(3) + token(20) + fee(3) + ...
    ///      Так же, как в Uniswap V3, поэтому маршрут, собранный их
    ///      инструментами, подходит без переделки.
    function exactInput(ExactInputParams memory params, uint256 deadline)
        external
        payable
        checkDeadline(deadline)
        returns (uint256 amountOut)
    {
        uint256 hops = _hopCount(params.path);
        uint256 amount = params.amountIn;

        for (uint256 i = 0; i < hops; i++) {
            (address tokenIn, address tokenOut, uint24 fee) = decodeHop(params.path, i);
            // Последний шаг отдаёт пользователю, промежуточные — этому
            // контракту: следующее плечо забирает выход отсюда.
            address recipient = i == hops - 1 ? params.recipient : address(this);
            amount = _swapExactInput(tokenIn, tokenOut, fee, recipient, amount, i == 0 ? msg.sender : address(this));
        }

        require(amount >= params.amountOutMinimum, 'SementsulRouter: TOO_LITTLE_RECEIVED');
        amountOut = amount;
    }

    // ---------- обмен с точным выходом ----------

    /// @notice Получить точное количество tokenOut, потратив не больше
    /// params.amountInMaximum tokenIn.
    ///
    /// Зачем это нужно отдельно. При точном входе трейдер знает, сколько
    /// отдаёт, но не знает, сколько получит. При точном выходе наоборот:
    /// «мне нужно ровно 100 USDT» — и он готов отдать не больше такого-то
    /// количества. Для платежей и закрытия позиций это единственная удобная
    /// форма.
    function exactOutputSingle(ExactOutputParams memory params, uint256 deadline)
        external
        payable
        checkDeadline(deadline)
        returns (uint256 amountIn)
    {
        require(params.path.length == 43, 'SementsulRouter: NOT_SINGLE');
        (address tokenIn, address tokenOut, uint24 fee) = decodeHop(params.path, 0);

        amountIn = _swapExactOutput(tokenIn, tokenOut, fee, params.recipient, params.amountOut, msg.sender);
        require(amountIn <= params.amountInMaximum, 'SementsulRouter: TOO_MUCH_REQUESTED');
    }

    /// @notice Точный выход по маршруту.
    /// @dev Маршрут передаётся в ОБРАТНОМ порядке — от последнего пула к
    /// первому, — потому что считать сумму входа нужно с конца: сколько нужно
    /// отдать на последнем шаге, зависит от того, что придёт с предыдущего.
    function exactOutput(ExactOutputParams memory params, uint256 deadline)
        external
        payable
        checkDeadline(deadline)
        returns (uint256 amountIn)
    {
        uint256 hops = _hopCount(params.path);
        uint256 amount = params.amountOut;

        for (uint256 i = 0; i < hops; i++) {
            (address tokenIn, address tokenOut, uint24 fee) = decodeHop(params.path, i);
            address recipient = i == hops - 1 ? params.recipient : address(this);
            amount = _swapExactOutput(tokenIn, tokenOut, fee, recipient, amount, i == 0 ? msg.sender : address(this));
        }

        require(amount <= params.amountInMaximum, 'SementsulRouter: TOO_MUCH_REQUESTED');
        amountIn = amount;
    }

    // ---------- служебное ----------

    /// @notice Несколько вызовов в одной транзакции.
    /// @dev Каждый элемент — отдельно закодированный вызов этого же
    ///      контракта, включая этот самый multicall. Так работает
    ///      «обменять и добавить ликвидность» одним действием пользователя.
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

    /// @notice Развернуть WBNB в BNB и отправить получателю.
    function unwrapWBNB(uint256 amountMinimum, address recipient) external payable {
        uint256 balance = IERC20(WBNB).balanceOf(address(this));
        require(balance >= amountMinimum, 'SementsulRouter: INSUFFICIENT_WBNB');
        if (balance > 0) {
            IWBNB(WBNB).withdraw(balance);
            (bool ok, ) = recipient.call{value: balance}('');
            require(ok, 'SementsulRouter: BNB_SEND_FAILED');
        }
    }

    /// @notice Завернуть BNB в WBNB и оставить на контракте. Нужно для
    /// ETH-обменов: пользователь отправляет BNB вместе с вызовом, роутер
    /// заворачивает его и дальше торгует как обычным токеном.
    function wrapBNB(uint256 amountMinimum) external payable {
        require(msg.value >= amountMinimum, 'SementsulRouter: INSUFFICIENT_BNB');
        if (msg.value > 0) IWBNB(WBNB).deposit{value: msg.value}();
    }

    /// @notice Вернуть оставшийся BNB вызывающему.
    function refundBNB() external payable {
        uint256 balance = address(this).balance;
        if (balance > 0) {
            (bool ok, ) = msg.sender.call{value: balance}('');
            require(ok, 'SementsulRouter: REFUND_FAILED');
        }
    }

    // ---------- оплата ----------

    /// @dev Оплата обмена. Пул вызывает этот метод после того, как отдал
    /// выход, и ждёт перевод долга.
    ///
    /// Важная деталь про штраф за разворот: пул кладёт в долг сумму входа
    /// ВМЕСТЕ со штрафом, поэтому роутер просто платит то, что просят, и не
    /// пересчитывает штраф сам. Иначе роутер и пул могли бы разойтись в
    /// арифметике, и обмен падал бы на нехватке денег.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        _pay(amount0Delta, amount1Delta, data);
    }

    /// @dev То же под именем Pancake: часть инструментов BSC ищет именно
    /// этот селектор.
    function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        _pay(amount0Delta, amount1Delta, data);
    }

    function _pay(int256 amount0Delta, int256 amount1Delta, bytes calldata) private {
        // Платим только пулу, который сами и вызвали. Иначе посторонний
        // контракт мог бы дёрнуть callback и увести деньги.
        require(msg.sender == _poolInUse, 'SementsulRouter: BAD_POOL');

        uint256 owed = amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
        require(owed > 0, 'SementsulRouter: NOTHING_OWED');

        address payToken = amount0Delta > 0
            ? SementsulV3PoolLike(msg.sender).token0()
            : SementsulV3PoolLike(msg.sender).token1();

        // Кто платит. Первое плечо маршрута оплачивает пользователь — своих
        // денег у роутера ещё нет. Последующие плечи оплачиваются из того,
        // что роутер получил на предыдущем шаге. Это и есть причина, по
        // которой нужен callback: на момент вызова второго пула деньги уже
        // есть, но заранее выдать на них approve было нельзя.
        address payer = _payer;
        if (payer == address(this)) {
            require(IERC20(payToken).transfer(msg.sender, owed), 'SementsulRouter: PAY_FAILED');
        } else {
            require(IERC20(payToken).transferFrom(payer, msg.sender, owed), 'SementsulRouter: PAY_FAILED');
        }
    }

    // ---------- внутреннее ----------

    /// @dev Какой пул сейчас обслуживается. Живёт только внутри вызова:
    /// выставляется перед swap и сбрасывается после.
    address private _poolInUse;

    /// @dev Кто платит по текущему шагу. Для первого плеча это пользователь,
    /// для последующих — сам роутер (деньги пришли с предыдущего шага).
    address private _payer;

    /// @dev Обмен с точным входом через пул, найденный по фабрике.
    function _swapExactInput(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        address recipient,
        uint256 amountIn,
        address payer
    ) private returns (uint256 amountOut) {
        (address token0, address pool) = _resolvePool(tokenIn, tokenOut, fee);
        bool zeroForOne = tokenIn == token0;

        // Лимит цены выставляем на край диапазона: настоящий предел задаёт
        // amountOutMinimum, а лимит цены нужен лишь для того, чтобы пул не
        // ушёл за границы представимых значений.
        uint160 limit = zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1;

        _poolInUse = pool;
        _payer = payer;
        (int256 amount0, int256 amount1) =
            SementsulV3PoolLike(pool).swap(recipient, zeroForOne, int256(amountIn), limit, '');
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
        address payer
    ) private returns (uint256 amountIn) {
        (address token0, address pool) = _resolvePool(tokenIn, tokenOut, fee);
        bool zeroForOne = tokenIn == token0;

        uint160 limit = zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1;

        _poolInUse = pool;
        _payer = payer;
        (int256 amount0, int256 amount1) =
            SementsulV3PoolLike(pool).swap(recipient, zeroForOne, -int256(amountOut), limit, '');
        _poolInUse = address(0);
        _payer = address(0);

        // Про знаки. В соглашении пула положительная дельта значит «пул
        // получил», отрицательная — «пул отдал». При точном ВЫХОДЕ вход
        // приходит ПОЛОЖИТЕЛЬНЫМ (пул его получил), а выход отрицательным.
        // Значит сумма входа — это amount0 при zeroForOne и amount1 иначе,
        // без всякого отрицания. Первая версия отрицала значение и получала
        // в uint256 огромное число: обмен падал на проверке верхней границы.
        amountIn = uint256(zeroForOne ? amount0 : amount1);
    }

    /// @dev Найти пул и упорядочить токены. Вынесено отдельно, чтобы обе
    /// ветки (вход и выход) считали одинаково.
    function _resolvePool(address tokenIn, address tokenOut, uint24 fee)
        private
        view
        returns (address token0, address pool)
    {
        token0 = tokenIn < tokenOut ? tokenIn : tokenOut;
        address token1 = tokenIn < tokenOut ? tokenOut : tokenIn;

        pool = ISementsulV3Factory(FACTORY).getPool(token0, token1, fee);
        require(pool != address(0), 'SementsulRouter: POOL_NOT_FOUND');
        require(ISementsulV3Factory(FACTORY).isPool(pool), 'SementsulRouter: NOT_OUR_POOL');
    }

    /// @dev Сколько шагов в упакованном маршруте.
    function _hopCount(bytes memory path) private pure returns (uint256) {
        require(path.length >= 43 && (path.length - 20) % 23 == 0, 'SementsulRouter: BAD_PATH');
        return (path.length - 20) / 23;
    }

    /// @dev Достать шаг с номером index из упакованного маршрута.
    function decodeHop(bytes memory path, uint256 index)
        private
        pure
        returns (address tokenIn, address tokenOut, uint24 fee)
    {
        uint256 offset = index * 23;
        assembly {
            // Смещение 32 — длина массива в памяти.
            tokenIn := shr(96, mload(add(add(path, 32), offset)))
            fee := shr(232, mload(add(add(path, 52), offset)))
            tokenOut := shr(96, mload(add(add(path, 55), offset)))
        }
    }
}