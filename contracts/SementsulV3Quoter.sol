// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.24;

// Sementsul DEX — https://sementsul.net/
//
// Исходники: https://github.com/sementsul/sementsul-dex
//
// Квотер: считает, сколько выйдет из обмена, НЕ отправляя транзакцию.
//
// ЗАЧЕМ ОН НУЖЕН
// ---------------
// Агрегатор (1inch, OpenOcean, Pancake SmartRouter) строит маршрут так:
// перебирает площадки, спрашивает у каждой «сколько дашь за 100 USDT?»,
// и ведёт сделку туда, где больше. Спрашивать приходится у контракта,
// потому что посчитать в браузере нельзя: цена зависит от ликвидности в
// диапазонах, а её не видно без чтения тиков.
//
// Без квотера агрегатор не может включить наш пул в перебор: он не станет
// отправлять настоящую транзакцию, чтобы «попробовать» — это стоило бы газа
// на каждый вариант маршрута.
//
// ПОЧЕМУ ЧЕРЕЗ РЕВЕРТ
// -------------------
// Точно посчитать выход можно двумя способами:
//
//   1. Скопировать математику пула в квотер. Тогда любое расхождение
//      (округление, порядок операций) даёт НЕВЕРНУЮ цифру, и агрегатор
//      построит маршрут по цене, которой нет. Сделка отвалится на
//      amountOutMinimum, а виноваты будем мы.
//
//   2. Вызвать настоящий swap и поймать реверт. Пул сам считает выход
//      своей же математикой — расхождение исключено по построению.
//      Агрегатору нужен только ответ, а не исполнение.
//
// Здесь второй способ. `quoteExactInput` вызывает swap, пул считает дельты
// и просит оплату через callback; квотер не платит, а откатывается с
// custom error, в котором лежат обе дельты. Снаружи реверт ловится, числа
// достаются. Поэтому цифра всегда совпадает с реальным исполнением.
//
// Плата: лишний газ на eth_call. Для агрегатора он бесплатен — eth_call не
// попадает в блок.
//
// ЧЕСТНОСТЬ
// ---------
// Квотер ничего не пишет в состояние и не может распоряжаться чужими
// средствами: у него нет ни transferFrom, ни approve, ни прав на пул.
// Ошибочный квотер испортит только расчёт, но не деньги.

import './interfaces.sol';

/// @notice Минимальный набор методов пула, нужный для расчёта.
/// @dev Отдельный интерфейс, а не ISementsulV3Pool: там slot0 объявлен с
///      семью полями (как у Uniswap), а наш пул возвращает пять. Читать
///      slot0 нам всё равно не нужно — swap сообщает всё сам.
interface ISementsulV3PoolQuote {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);

    function token0() external view returns (address);
}

interface ISementsulV3FactoryQuote {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
    function isPool(address pool) external view returns (bool);
}

/// @dev Границы цены из TickMath пула: за них swap не пускает, потому что
///      там ломается точность расчёта.
uint160 constant MIN_SQRT_RATIO = 4295128739;
uint160 constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

/// @notice Квотер для пулов Sementsul V3.
///
/// Работает с любым числом шагов. Маршрут упакован так же, как у Uniswap
/// (token(20) + fee(3) + token(20) + fee(3) + ...), поэтому маршрут,
/// собранный их инструментами, подходит без переделки.
contract SementsulV3Quoter {
    /// @dev Результат расчёта, вынесенный через реверт.
    /// Custom error, а не строка: у него фиксированная раскладка
    /// (селектор 4 байта + два слова), разбирать надёжно и без магии
    /// смещений. Со строкой пришлось бы учитывать ABI-обёртку Error(string)
    /// и считать смещения вручную — источник тонких ошибок.
    error QuoteResult(int256 amount0Delta, int256 amount1Delta);

    /// @dev Пул, который сейчас считаем. Нужен, чтобы отличить свой реверт
    /// от чужого: посторонний контракт может дёрнуть callback, и доверять
    /// ему нельзя.
    address private _poolInUse;

    /// @notice Фабрика, пулы которой считаем. Чужой пул не нужен: за его
    /// ответ нельзя ручаться, а маршрут строится только по нашим.
    address public immutable FACTORY;

    /// @notice WBNB — для маршрутов, начинающихся с нативного BNB.
    /// В квотере это только имя в маршруте, не более.
    address public immutable WBNB;

    constructor(address _factory, address _wbnb) {
        require(_factory != address(0), 'SementsulQuoter: FACTORY_ZERO');
        require(_wbnb != address(0), 'SementsulQuoter: WBNB_ZERO');
        FACTORY = _factory;
        WBNB = _wbnb;
    }

    // ---------- точный вход ----------

    /// @notice Сколько tokenOut получится за amountIn по маршруту.
    /// @param path Упакованный маршрут: token(20)+fee(3)+token(20)...
    ///        Порядок прямой: от того, что отдаём, к тому, что получаем.
    function quoteExactInput(bytes memory path, uint256 amountIn) external returns (uint256 amountOut) {
        uint256 hops = _hopCount(path);
        uint256 amount = amountIn;

        for (uint256 i = 0; i < hops; i++) {
            (address tokenIn, address tokenOut, uint24 fee) = decodeHop(path, i);
            amount = _quoteSingle(tokenIn, tokenOut, fee, amount, true);
        }

        amountOut = amount;
    }

    /// @notice Сколько выйдет из одного пула. Удобно агрегаторам, которые
    /// перебирают пулы по одному.
    /// @param sqrtPriceLimitX96 Предел цены; 0 означает «край диапазона».
    function quoteExactInputSingle(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint160 sqrtPriceLimitX96
    ) external returns (uint256 amountOut) {
        amountOut = _quoteSingleWithLimit(tokenIn, tokenOut, fee, amountIn, true, sqrtPriceLimitX96);
    }

    // ---------- точный выход ----------

    /// @notice Сколько tokenIn нужно, чтобы получить ровно amountOut.
    /// @param path Упакованный маршрут В ОБРАТНОМ порядке, как у Uniswap:
    ///        первым идёт токен, который получаем. Это не наша прихоть —
    ///        агрегаторы передают путь именно так, и совпадение обязательно,
    ///        иначе маршрут прочитается задом наперёд.
    function quoteExactOutput(bytes memory path, uint256 amountOut) external returns (uint256 amountIn) {
        uint256 hops = _hopCount(path);
        uint256 amount = amountOut;

        for (uint256 i = 0; i < hops; i++) {
            // При обратном пути шаг (a, fee, b) означает «b → a»:
            // первым в пути стоит тот токен, который на выходе.
            (address outToken, address inToken, uint24 fee) = decodeHop(path, i);
            amount = _quoteSingle(inToken, outToken, fee, amount, false);
        }

        amountIn = amount;
    }

    /// @notice Сколько нужно отдать, чтобы получить ровно amountOut из одного пула.
    function quoteExactOutputSingle(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountOut,
        uint160 sqrtPriceLimitX96
    ) external returns (uint256 amountIn) {
        amountIn = _quoteSingleWithLimit(tokenIn, tokenOut, fee, amountOut, false, sqrtPriceLimitX96);
    }

    // ---------- обмен с пулом ----------

    /// @notice Пул зовёт это, чтобы получить оплату. Квотер не платит никогда:
    /// он лишь считает. Отсюда реверт, из которого достаётся ответ.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external view {
        require(msg.sender == _poolInUse, 'SementsulQuoter: BAD_POOL');
        revert QuoteResult(amount0Delta, amount1Delta);
    }

    /// @notice То же под именем Pancake: часть инструментов BSC проверяет
    /// именно этот селектор.
    function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external view {
        require(msg.sender == _poolInUse, 'SementsulQuoter: BAD_POOL');
        revert QuoteResult(amount0Delta, amount1Delta);
    }

    // ---------- внутреннее ----------

    /// @dev Один шаг маршрута с лимитом цены по краю диапазона.
    function _quoteSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amount, bool exactIn)
        private
        returns (uint256 result)
    {
        (address token0, address pool) = _resolvePool(tokenIn, tokenOut, fee);
        bool zeroForOne = tokenIn == token0;
        uint160 limit = zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1;
        result = _quoteWithPool(pool, zeroForOne, amount, exactIn, limit);
    }

    /// @dev То же, но с явным лимитом от вызывающего.
    function _quoteSingleWithLimit(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amount,
        bool exactIn,
        uint160 sqrtPriceLimitX96
    ) private returns (uint256 result) {
        (address token0, address pool) = _resolvePool(tokenIn, tokenOut, fee);
        bool zeroForOne = tokenIn == token0;

        uint160 limit = sqrtPriceLimitX96;
        if (limit == 0) {
            limit = zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1;
        } else {
            // Проверяем лимит заранее: иначе пул откатится своей проверкой,
            // и наружу уйдёт непонятная ошибка вместо внятной.
            if (zeroForOne) {
                require(limit < MAX_SQRT_RATIO && limit > MIN_SQRT_RATIO, 'SementsulQuoter: BAD_LIMIT');
            } else {
                require(limit > MIN_SQRT_RATIO && limit < MAX_SQRT_RATIO, 'SementsulQuoter: BAD_LIMIT');
            }
        }

        result = _quoteWithPool(pool, zeroForOne, amount, exactIn, limit);
    }

    /// @dev Главное: вызываем swap, ловим реверт, разбираем дельты.
    function _quoteWithPool(address pool, bool zeroForOne, uint256 amount, bool exactIn, uint160 limit)
        private
        returns (uint256 result)
    {
        _poolInUse = pool;

        // Знак задаёт направление расчёта: положительная сумма — точный вход,
        // отрицательная — точный выход. Ровно как в самом пуле.
        int256 amountSpecified = exactIn ? int256(amount) : -int256(amount);

        // Вызов заведомо откатится: квотер не платит.
        try ISementsulV3PoolQuote(pool).swap(address(this), zeroForOne, amountSpecified, limit, '') returns (
            int256 amount0, int256 amount1
        ) {
            // Сюда попасть не должны: пул требует оплату. Но если пул
            // когда-нибудь разрешит бесплатный обмен — честно вернём его числа.
            _poolInUse = address(0);
            result = _pick(amount0, amount1, zeroForOne, exactIn);
        } catch (bytes memory reason) {
            _poolInUse = address(0);
            result = _decodeRevert(reason, zeroForOne, exactIn);
        }
    }

    /// @dev Достаём дельты из данных реверта.
    /// @dev Раскладка custom error: селектор(4) + amount0(32) + amount1(32),
    ///      итого 68 байт. В памяти `reason` указывает на слово длины,
    ///      данные начинаются с reason+32.
    function _decodeRevert(bytes memory reason, bool zeroForOne, bool exactIn)
        private
        pure
        returns (uint256 result)
    {
        // Не наш реверт — пробрасываем как есть, чтобы агрегатор увидел
        // настоящую причину, а не «0».
        if (reason.length != 68) {
            assembly {
                revert(add(reason, 32), mload(reason))
            }
        }

        int256 amount0;
        int256 amount1;
        assembly {
            // +32 (длина) +4 (селектор) = 36; второе слово — через 32 байта.
            amount0 := mload(add(reason, 36))
            amount1 := mload(add(reason, 68))
        }

        result = _pick(amount0, amount1, zeroForOne, exactIn);
    }

    /// @dev Выбрать нужную дельту по направлению и типу расчёта.
    ///
    /// Соглашение пула: положительная дельта — пул получил, отрицательная —
    /// пул отдал. Значит:
    ///   точный вход  → нужен ВЫХОД, то есть отрицательная дельта;
    ///   точный выход → нужен ВХОД, то есть положительная.
    function _pick(int256 amount0, int256 amount1, bool zeroForOne, bool exactIn)
        private
        pure
        returns (uint256)
    {
        if (exactIn) {
            int256 out = zeroForOne ? amount1 : amount0;
            require(out < 0, 'SementsulQuoter: NO_OUTPUT');
            return uint256(-out);
        } else {
            int256 inp = zeroForOne ? amount0 : amount1;
            require(inp > 0, 'SementsulQuoter: NO_INPUT');
            return uint256(inp);
        }
    }

    /// @dev Найти пул и упорядочить токены. Тот же порядок, что в роутере:
    /// token0 — меньший адрес.
    function _resolvePool(address tokenIn, address tokenOut, uint24 fee)
        private
        view
        returns (address token0, address pool)
    {
        token0 = tokenIn < tokenOut ? tokenIn : tokenOut;
        address token1 = tokenIn < tokenOut ? tokenOut : tokenIn;

        pool = ISementsulV3FactoryQuote(FACTORY).getPool(token0, token1, fee);
        require(pool != address(0), 'SementsulQuoter: POOL_NOT_FOUND');
        require(ISementsulV3FactoryQuote(FACTORY).isPool(pool), 'SementsulQuoter: NOT_OUR_POOL');
    }

    /// @dev Сколько шагов в упакованном маршруте. Формат как у Uniswap.
    function _hopCount(bytes memory path) private pure returns (uint256) {
        require(path.length >= 43 && (path.length - 20) % 23 == 0, 'SementsulQuoter: BAD_PATH');
        return (path.length - 20) / 23;
    }

    /// @dev Достать шаг с номером index из упакованного маршрута.
    /// @dev Та же раскладка, что в роутере: 20 байт адрес, 3 байта fee,
    /// 20 байт адрес, ... Смещения считаются от начала данных.
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