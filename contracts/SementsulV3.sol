// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.24;

import './interfaces.sol';
import './SementsulV3Math.sol';

// SementsulV3Factory — фабрика концентрированных пулов (аналог V3).
//
// ТИРЫ КОМИССИИ.
// Раньше комиссия была immutablе-полем фабрики: одна фабрика — один тир. Из-за
// этого пара могла иметь ровно один пул, а индексаторы и роутеры, привыкшие
// звать getPool(token0, token1, fee), получали реверт — то есть наши пулы
// были для них невидимы.
//
// Теперь тиров четыре, как в Uniswap V3 и Pancake V3, и они задаются при
// создании фабрики списком. Внешний API повторяет Uniswap:
//   getPool(token0, token1, fee) -> address
//   PoolCreated(token0, token1, fee, tickSpacing, pool)
// Этого достаточно, чтобы индексатор подхватил пулы без правок с его стороны.
//
// Комиссия по-прежнему может быть любой — список тиров это параметр
// конструктора, а не константа в коде. Именно это позволяет выставить
// 0.005%, которого у Pancake нет.
//
// Шаг тика задаётся каждому тиру: шаг определяет минимальную ширину диапазона
// и должен соответствовать комиссии (узкая комиссия — мелкий шаг).
contract SementsulV3Factory {
    /// @notice Предел комиссии — 1%, как у верхнего тира Uniswap и Pancake.
    /// Выше начинается не биржа, а способ отобрать деньги у того, кто
    /// добавил ликвидность, не разобравшись. Набор тиров задаётся при
    /// создании, но этот потолок переписать нельзя.
    uint24 public constant MAX_FEE = 10_000;
    uint24 public constant MIN_FEE = 1;
    /// @notice Больше четырёх тиров держать незачем: это предел, после которого
    /// ликвидность дробится между пулами одной пары и каждая становится слишком
    /// тонкой, чтобы торговать без проскальзывания.
    uint256 public constant MAX_TIERS = 4;

    /// @notice Администратор фабрики. Один, и права у него узкие.
    ///
    /// Раньше здесь было два поля: feeTo («получатель комиссии протокола») и
    /// feeToSetter. Я убрал feeTo и переименовал второе в admin, потому что
    /// первое вводило в заблуждение.
    ///
    /// feeTo не использовался ни разу: пул к нему не обращался, комиссия
    /// протокола не взималась. Поле обещало механизм, которого не было. А
    /// любой адрес, который можно переназначить, — это рычаг, из-за которого
    /// людям приходится верить владельцу на слово вместо чтения кода.
    ///
    /// Права admin — только то, что видно в этом файле: задержка JIT и штраф
    /// за разворот. Ни вывода средств, ни изменения комиссии обмена, ни
    /// подмены адресов пулов у него нет. Администратор выбирается при
    /// создании фабрики и дальше не меняется.
    address public immutable admin;

    /// @notice Включённые тиры: комиссия => шаг тика. Ноль означает, что тир
    /// не включён, — поэтому ни одна настоящая комиссия не может быть нулевой.
    mapping(uint24 => int24) public tickSpacingFor;
    uint24[] public feeTiers;

    /// @notice Пулы по паре и тиру. Публичный mapping даёт ровно ту сигнатуру,
    /// которую ждут индексаторы: getPool(address,address,uint24).
    mapping(address => mapping(address => mapping(uint24 => address))) public getPool;

    address[] public allPools;
    /// @notice Только пулы, созданные этой фабрикой. Роутер обязан сверяться
    /// с фабрикой: подсунутый контракт может отдать всю ликвидность, если
    /// доверять его словам.
    mapping(address => bool) public isPool;

    /// @notice Защита от JIT: сколько блоков комиссия должна «отлежаться»,
    /// прежде чем её можно забрать. Своё значение на каждый тир.
    /// Смысл: JIT-бот входит перед чужим свопом и выходит сразу после. Если
    /// начисленное не выдаётся мгновенно, бот вынужден держать позицию ещё
    /// jitDelayBlocks блоков и всё это время нести риск цены.
    ///
    /// Почему задержка привязана к ставке. Прибыль бота пропорциональна
    /// комиссии, а риск — корню из времени удержания. Приравняв, получаем
    /// время безубыточности T ∝ fee². Значит одинаково «неудобная» для бота
    /// задержка должна расти как квадрат комиссии: на 1% держать нужно
    /// намного дольше, чем на 0.01%, иначе защита есть только на бумаге.
    mapping(uint24 => uint64) public jitDelayBlocks;

    /// @notice Коэффициент штрафа за РАЗВОРОТ направления внутри одного блока.
    /// Значение в единицах 1e-6: 1_000_000 означает «ставка штрафа равна
    /// сдвигу цены» (сдвиг 1% -> ставка 1%). Ноль означает «выключено».
    ///
    /// Почему именно пропорционально сдвигу, а не фиксированный процент.
    /// Прибыль сэндвич-бота растёт как КВАДРАТ сдвига цены, который он сам же
    /// и создаёт: он покупает, толкая цену, продаёт по сдвинутой цене и
    /// возвращается. Фиксированный штраф (скажем 1%) растёт ЛИНЕЙНО от суммы,
    /// поэтому на крупных сдвигах он отстаёт: при пуле $100k и штрафе 1%
    /// бот на сдвиге 2% зарабатывает $39 и платит $20 — остаётся в плюсе.
    /// Штраф, пропорциональный сдвигу, растёт с той же скоростью (квадрат), и
    /// тогда бот в минусе при любом размере.
    ///
    /// По умолчанию выключено (0). Причина честная: механизм обходится
    /// переносом второго плеча в следующий блок (0.448 с на BSC), а цена
    /// ошибки — до 10% с легального пользователя, который в одном блоке
    /// случайно сходил в обе стороны. Включать только после замера доли
    /// ложных срабатываний на реальном трафике.
    mapping(uint24 => uint24) public reversalPenaltyK;

    /// @notice Потолок штрафа, чтобы защита не превратилась в запрет торговли.
    /// 100_000 = 10%. Дальше это уже не анти-сэндвич, а конфискация.
    uint24 public maxReversalPenalty = 100_000;

    /// @notice Отметка последнего пула, торговавшего в блоке. Нужна для
    /// правила «не наказывать, если это похоже на маршрут через несколько
    /// пулов»: сэндвич и треугольный арбитраж неотличимы внутри одного пула,
    /// но арбитраж обычно задевает несколько пулов, а сэндвич — один.
    ///
    /// Точность намеренно грубая, и это осознанный выбор в пользу
    /// безопасности: два независимых пользователя, торгующих в разных пулах
    /// одного блока, тоже дадут «маршрут», и штраф не сработает. Это ложрица
    /// в сторону НЕнаказания — лучше пропустить бота, чем взять 10% с того,
    /// кто просто торговал.
    address public lastSwapPool;
    uint256 public lastSwapBlock;

    event PoolCreated(
        address indexed token0,
        address indexed token1,
        uint24 indexed fee,
        int24 tickSpacing,
        address pool
    );
    event PoolCountChanged(uint256 poolCount);
    event JitDelayChanged(uint24 indexed fee, uint64 previous, uint64 next);
    event ReversalPenaltyChanged(uint24 indexed fee, uint24 previous, uint24 next);
    event MaxReversalPenaltyChanged(uint24 previous, uint24 next);

    modifier onlyAdmin() {
        require(msg.sender == admin, 'Sementsul: FORBIDDEN');
        _;
    }

    /// @param _fees Комиссии тиров в единицах 1e-6: 500 = 0.05%.
    /// @param _spacings Шаг тика для каждого тира, в том же порядке.
    /// @param _admin Администратор: управляет только задержкой JIT и штрафом.
    constructor(uint24[] memory _fees, int24[] memory _spacings, address _admin) {
        require(_admin != address(0), 'Sementsul: ADMIN_ZERO');
        require(_fees.length > 0 && _fees.length <= MAX_TIERS, 'Sementsul: TIER_COUNT');
        require(_fees.length == _spacings.length, 'Sementsul: TIER_LENGTH');

        for (uint256 i = 0; i < _fees.length; i++) {
            uint24 f = _fees[i];
            int24 s = _spacings[i];
            require(f >= MIN_FEE && f <= MAX_FEE, 'Sementsul: FEE_RANGE');
            require(s > 0 && s <= 16383, 'Sementsul: SPACING_RANGE');
            require(tickSpacingFor[f] == 0, 'Sementsul: DUP_FEE');

            tickSpacingFor[f] = s;
            feeTiers.push(f);
            // Защита включена с рождения фабрики: пул, созданный без неё, уже
            // нельзя «починить» задним числом для тех, кто в него вошёл.
            jitDelayBlocks[f] = _defaultJitDelay(f);
        }

        admin = _admin;
    }

    /// @notice Задержка по умолчанию для тира.
    ///
    /// Теория говорит, что время безубыточности бота растёт как КВАДРАТ
    /// ставки: прибыль пропорциональна комиссии, а риск — корню из времени
    /// удержания. Беда в том, что на нашем наборе тиров (0.005%...1%) квадрат
    /// даёт разброс в 40 000 раз. Никакая одна шкала с разумным минимумом и
    /// максимумом такой разброс не выражает: нижние тиры просто упираются в
    /// минимум и получают одинаковую задержку, то есть привязка к ставке
    /// вырождается ровно там, где она нужнее всего.
    ///
    /// Поэтому шкала линейная: 150 блоков минимум плюс 2 блока на каждую
    /// единицу комиссии (1e-6). Получается:
    ///   0.005% ->  250 блоков (≈112 с)
    ///   0.05%  -> 1150 блоков (≈8.6 мин)
    ///   0.25%  -> 5150 блоков (≈38 мин)
    ///   1%     -> 20150 блоков (≈2.5 ч)
    /// Каждый тир получает своё значение, порядок монотонный.
    ///
    /// Честно про границу: на 0.005% даже 250 блоков не делают удержание
    /// убыточным — бот их переждёт. Линейная шкала даёт монотонность и
    /// осмысленный минимум, но не превращает низкую комиссию в защищённую.
    function _defaultJitDelay(uint24 _fee) internal pure returns (uint64) {
        uint256 d = 150 + uint256(_fee) * 2;
        if (d > 200_000) d = 200_000;
        return uint64(d);
    }

    function feeTiersLength() external view returns (uint256) {
        return feeTiers.length;
    }

    function allPoolsLength() external view returns (uint256) {
        return allPools.length;
    }

    /// @notice Создать пул для пары в заданном тире.
    function createPool(address tokenA, address tokenB, uint24 _fee) external returns (address pool) {
        require(tokenA != tokenB, 'Sementsul: IDENTICAL_ADDRESSES');
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), 'Sementsul: ZERO_ADDRESS');

        int24 spacing = tickSpacingFor[_fee];
        require(spacing != 0, 'Sementsul: FEE_NOT_ENABLED');
        require(getPool[token0][token1][_fee] == address(0), 'Sementsul: POOL_EXISTS');

        // Соль включает комиссию: без неё пулы разных тиров одной пары
        // получили бы одинаковый адрес и второй createPool упал бы.
        pool = address(new SementsulV3Pool{salt: keccak256(abi.encode(token0, token1, _fee))}());
        SementsulV3Pool(pool).initialize(token0, token1, _fee, spacing);

        getPool[token0][token1][_fee] = pool;
        getPool[token1][token0][_fee] = pool;
        allPools.push(pool);
        isPool[pool] = true;

        emit PoolCreated(token0, token1, _fee, spacing, pool);
        emit PoolCountChanged(allPools.length);
    }

    /// @notice Адрес пула, который createPool создаст для этой пары и тира.
    function poolFor(address tokenA, address tokenB, uint24 _fee) external view returns (address pool) {
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        bytes32 salt = keccak256(abi.encode(token0, token1, _fee));
        bytes32 hash = keccak256(
            abi.encodePacked(hex'ff', address(this), salt, keccak256(type(SementsulV3Pool).creationCode))
        );
        pool = address(uint160(uint256(hash)));
    }

    /// @notice Изменить защиту от JIT для конкретного тира.
    /// Ноль означает «защита выключена». Это осознанно разрешено: возможность
    /// измерить проблему нужна, чтобы показать её в тестах. По умолчанию ноль
    /// не стоит ни на одном тире — при создании фабрики выставляется значение
    /// из _defaultJitDelay.
    ///
    /// Право выключить защиту — единственное, что здесь есть. Администратор не
    /// может ни забрать ликвидность, ни изменить комиссию, ни подменить пул.
    function setJitDelayBlocks(uint24 _fee, uint64 _blocks) external onlyAdmin {
        require(tickSpacingFor[_fee] != 0, 'Sementsul: FEE_NOT_ENABLED');
        require(_blocks <= 200_000, 'Sementsul: DELAY_RANGE');
        emit JitDelayChanged(_fee, jitDelayBlocks[_fee], _blocks);
        jitDelayBlocks[_fee] = _blocks;
    }

    /// @notice Включить или изменить штраф за разворот в блоке для тира.
    /// @param _fee Тир комиссии.
    /// @param _k Коэффициент: 1_000_000 = ставка штрафа равна сдвигу цены.
    ///        0 выключает механизм.
    ///
    /// Верхняя граница 5_000_000 (то есть штраф в 5 раз больше сдвига) —
    /// защита от ошибки настройки. Потолок самой ставки задаётся отдельно в
    /// maxReversalPenalty и по умолчанию равен 10%.
    function setReversalPenaltyK(uint24 _fee, uint24 _k) external onlyAdmin {
        require(tickSpacingFor[_fee] != 0, 'Sementsul: FEE_NOT_ENABLED');
        require(_k <= 5_000_000, 'Sementsul: K_RANGE');
        emit ReversalPenaltyChanged(_fee, reversalPenaltyK[_fee], _k);
        reversalPenaltyK[_fee] = _k;
    }

    /// @notice Потолок ставки штрафа. Ограничен 10%: выше это уже не защита
    /// от сэндвича, а отъём денег у обычного трейдера, который ошибся курсом.
    function setMaxReversalPenalty(uint24 _max) external onlyAdmin {
        require(_max <= 100_000, 'Sementsul: MAX_PENALTY_RANGE');
        emit MaxReversalPenaltyChanged(maxReversalPenalty, _max);
        maxReversalPenalty = _max;
    }

    /// @notice Отметить, что пул `pool` торговал в этой транзакции, и сказать,
    /// похоже ли это на маршрут через несколько пулов.
    ///
    /// Возвращает true, если в этом блоке УЖЕ торговал другой пул. Тогда
    /// разворот в текущем пуле не наказывается: это может быть треугольный
    /// арбитраж (пользователь или бот выравнивает цену сразу в нескольких
    /// пулах), а наказывать арбитраж мы не хотим — он приносит ликвидность и
    /// сводит цену к рыночной.
    ///
    /// Вызывать может только пул этой фабрики: иначе любой контракт подделал
    /// бы «маршрут» одной транзакцией и обошёл штраф.
    function noteSwap(address pool) external returns (bool multiPoolRoute) {
        require(isPool[msg.sender], 'Sementsul: FORBIDDEN');
        pool; // параметр нужен для читаемости вызова на стороне пула

        if (lastSwapBlock == block.number && lastSwapPool != address(0) && lastSwapPool != msg.sender) {
            return true; // в блоке уже торговал ДРУГОЙ пул — считаем маршрутом
        }

        lastSwapPool = msg.sender;
        lastSwapBlock = block.number;
        return false;
    }
}

// Состояние позиции. Комиссии хранятся не как «сколько начислено», а как
// зафиксированный снимок роста: так начисление не требует перебора позиций
// при каждом обмене.
struct Position {
    uint128 liquidity;
    uint256 feeGrowthInside0LastX128;
    uint256 feeGrowthInside1LastX128;
    uint128 tokensOwed0;
    uint128 tokensOwed1;
    // ---- защита от JIT ----
    // Начисленное за последние jitDelayBlocks комиссии лежат здесь, а не в
    // tokensOwed: забрать их можно только после вестинга, и только если
    // ликвидность всё это время оставалась в пуле.
    uint128 pending0;
    uint128 pending1;
    // Блок, в котором pending становится доступным. 0 — нечего вестинговать.
    uint64 vestBlock;
}

struct Slot0 {
    uint160 sqrtPriceX96;
    int24 tick;
    uint16 observationIndex;
    uint16 observationCardinality;
    uint16 observationCardinalityNext;
    uint8 feeProtocol;
}

struct TickInfo {
    uint128 liquidityGross;
    int128 liquidityNet;
    uint256 feeGrowthOutside0X128;
    uint256 feeGrowthOutside1X128;
    bool initialized;
}

struct SwapState {
    int256 amountSpecifiedRemaining;
    int256 amountCalculated;
    uint160 sqrtPriceX96;
    int24 tick;
    uint128 liquidity;
    uint256 feeGrowthGlobalX128;
}

struct StepComputations {
    uint160 sqrtPriceStartX96;
    int24 tickNext;
    bool initialized;
    uint160 sqrtPriceNextX96;
    uint256 amountIn;
    uint256 amountOut;
    uint256 feeAmount;
}

// SementsulV3Pool — пул с концентрированной ликвидностью.
//
// Ликвидность сосредоточена в диапазонах между тиками; цена движется по
// кривой внутри каждого диапазона; комиссия начисляется пропорционально доле
// в диапазоне, а не всему пулу. Это то же устройство, что в Uniswap V3, но
// без оракула истории и без флеш-займов: они не нужны для обмена, а история
// цен и так собирается индексером из событий Swap.
contract SementsulV3Pool {
    uint256 public constant FEE_DENOMINATOR = 1e6;
    int24 public constant MIN_TICK = -887272;
    int24 public constant MAX_TICK = 887272;

    address public factory;
    address public token0;
    address public token1;
    uint24 public fee;
    int24 public tickSpacing;

    uint160 public sqrtPriceX96;
    int24 public tick;
    uint128 public liquidity;

    /// @notice Снимок состояния одним вызовом: цена, тик и ликвидность.
    /// Отдельные геттеры sqrtPriceX96() и tick() остаются, но внешние
    /// инструменты (Uniswap-подобные боты, наш собственный инструмент
    /// передвижения диапазона) традиционно читают slot0(). Без него
    /// приходится делать три запроса вместо одного, а часть готового кода
    /// просто не находит функцию. Порядок полей совпадает с Uniswap V3
    /// для первых двух, дальше — наши значения.
    function slot0()
        external
        view
        returns (uint160 sqrtPriceX96_, int24 tick_, uint128 liquidity_, uint24 fee_, int24 tickSpacing_)
    {
        return (sqrtPriceX96, tick, liquidity, fee, tickSpacing);
    }

    uint256 public feeGrowthGlobal0X128;
    uint256 public feeGrowthGlobal1X128;

    mapping(int24 => TickInfo) public ticks;
    mapping(int16 => uint256) public tickBitmap;
    mapping(bytes32 => Position) public positions;

    uint256 private unlocked = 1;
    modifier lock() {
        require(unlocked == 1, 'Sementsul: LOCKED');
        unlocked = 2;
        _;
        unlocked = 1;
    }

    // ---- состояние для callback-оплаты ----
    // Сколько вызывающий должен за текущий обмен (вход + штраф). Живёт только
    // внутри одного swap(): переданное значение не переживает транзакцию.
    uint256 private _callbackOwed;
    bool private _callbackActive;

    // ---- состояние для штрафа за разворот ----
    // Направление последнего обмена в блоке и цена на входе в блок. Нужны,
    // чтобы понять, развернулся ли инициатор, и насколько он сдвинул цену.
    struct BlockReversal {
        uint256 blockNumber;
        uint160 priceStart;
        int8 lastDirection; // 1 = zeroForOne, -1 = обратный
        bool traded;
    }
    BlockReversal private _reversal;

    event Initialize(uint160 sqrtPriceX96, int24 tick);
    event Mint(
        address sender,
        address indexed owner,
        int24 indexed tickLower,
        int24 indexed tickUpper,
        uint128 amount,
        uint256 amount0,
        uint256 amount1
    );
    event Burn(
        address indexed owner,
        int24 indexed tickLower,
        int24 indexed tickUpper,
        uint128 amount,
        uint256 amount0,
        uint256 amount1
    );
    event Swap(
        address indexed sender,
        address indexed recipient,
        int256 amount0,
        int256 amount1,
        uint160 sqrtPriceX96,
        uint128 liquidity,
        int24 tick
    );
    event Collect(
        address indexed owner,
        address recipient,
        int24 indexed tickLower,
        int24 indexed tickUpper,
        uint128 amount0,
        uint128 amount1
    );
    event ReversalPenaltyPaid(
        address indexed payer,
        bool zeroForOne,
        uint256 shiftBps,
        uint256 rateBps,
        uint256 penalty0,
        uint256 penalty1
    );

    constructor() {
        factory = msg.sender;
    }

    function initialize(address _token0, address _token1, uint24 _fee, int24 _tickSpacing) external {
        require(msg.sender == factory, 'Sementsul: FORBIDDEN');
        require(token0 == address(0), 'Sementsul: ALREADY_INITIALIZED');
        token0 = _token0;
        token1 = _token1;
        // Комиссия и шаг приходят от фабрики по конкретному тиру: одна фабрика
        // теперь обслуживает четыре пула на пару, и «взять fee() у фабрики»
        // больше не имеет смысла — у неё нет единственной комиссии.
        fee = _fee;
        tickSpacing = _tickSpacing;
    }

    /// @notice Начальная цена. Без неё нельзя посчитать, сколько токенов
    /// соответствует диапазону, поэтому обмен и ликвидность недоступны до
    /// этого вызова.
    function initializePrice(uint160 _sqrtPriceX96) external lock {
        require(sqrtPriceX96 == 0, 'Sementsul: PRICE_SET');
        require(
            _sqrtPriceX96 > TickMath.MIN_SQRT_RATIO && _sqrtPriceX96 < TickMath.MAX_SQRT_RATIO,
            'Sementsul: PRICE_RANGE'
        );
        sqrtPriceX96 = _sqrtPriceX96;
        int24 t = TickMath.getTickAtSqrtRatio(_sqrtPriceX96);
        tick = t;
        emit Initialize(_sqrtPriceX96, t);
    }

    function getReserves() external view returns (uint256, uint256) {
        return (IERC20(token0).balanceOf(address(this)), IERC20(token1).balanceOf(address(this)));
    }

    // ---------- ликвидность ----------

    /// @notice Добавить ликвидность в диапазон.
    /// Пропорция токенов определяется ценой: внутри диапазона нужны оба, ниже
    /// него — только token0, выше — только token1.
    function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount)
        external
        lock
        returns (uint256 amount0, uint256 amount1)
    {
        require(amount > 0, 'Sementsul: AMOUNT_ZERO');
        require(tickLower < tickUpper, 'Sementsul: TICK_ORDER');
        require(tickLower >= MIN_TICK && tickUpper <= MAX_TICK, 'Sementsul: TICK_RANGE');
        require(tickLower % tickSpacing == 0 && tickUpper % tickSpacing == 0, 'Sementsul: TICK_SPACING');
        require(sqrtPriceX96 != 0, 'Sementsul: NOT_INITIALIZED');

        _modifyPosition(recipient, tickLower, tickUpper, int128(amount));

        (amount0, amount1) = _amountsForLiquidity(sqrtPriceX96, tickLower, tickUpper, amount, true);

        if (amount0 > 0) {
            require(IERC20(token0).transferFrom(msg.sender, address(this), amount0), 'Sementsul: TF_0');
        }
        if (amount1 > 0) {
            require(IERC20(token1).transferFrom(msg.sender, address(this), amount1), 'Sementsul: TF_1');
        }

        emit Mint(msg.sender, recipient, tickLower, tickUpper, amount, amount0, amount1);
    }

    /// @notice Снять ликвидность. Начисленные комиссии остаются в позиции
    /// и забираются через collect.
    function burn(int24 tickLower, int24 tickUpper, uint128 amount)
        external
        lock
        returns (uint256 amount0, uint256 amount1)
    {
        require(amount > 0, 'Sementsul: AMOUNT_ZERO');
        bytes32 key = _positionKey(msg.sender, tickLower, tickUpper);
        require(positions[key].liquidity >= amount, 'Sementsul: INSUFFICIENT_LIQUIDITY');

        _modifyPosition(msg.sender, tickLower, tickUpper, -int128(amount));

        (amount0, amount1) = _amountsForLiquidity(sqrtPriceX96, tickLower, tickUpper, amount, false);

        if (amount0 > 0) require(IERC20(token0).transfer(msg.sender, amount0), 'Sementsul: T_0');
        if (amount1 > 0) require(IERC20(token1).transfer(msg.sender, amount1), 'Sementsul: T_1');

        emit Burn(msg.sender, tickLower, tickUpper, amount, amount0, amount1);
    }

    /// @notice Забрать начисленные комиссии.
    function collect(
        address recipient,
        int24 tickLower,
        int24 tickUpper,
        uint128 amount0Requested,
        uint128 amount1Requested
    ) external lock returns (uint128 amount0, uint128 amount1) {
        bytes32 key = _positionKey(msg.sender, tickLower, tickUpper);

        // Сначала фиксируем всё, что накопилось: иначе часть комиссии
        // останется незаписанной в tokensOwed и потеряется.
        _modifyPosition(msg.sender, tickLower, tickUpper, 0);

        Position storage position = positions[key];

        // Переводим отлежавшееся из pending в доступное. Если срок вестинга
        // ещё не вышел, здесь ничего не произойдёт и забрать будет нечего —
        // именно это и останавливает JIT-бота.
        _settlePending(position);

        amount0 = amount0Requested > position.tokensOwed0 ? position.tokensOwed0 : amount0Requested;
        amount1 = amount1Requested > position.tokensOwed1 ? position.tokensOwed1 : amount1Requested;

        if (amount0 > 0) {
            position.tokensOwed0 -= amount0;
            require(IERC20(token0).transfer(recipient, amount0), 'Sementsul: T_0');
        }
        if (amount1 > 0) {
            position.tokensOwed1 -= amount1;
            require(IERC20(token1).transfer(recipient, amount1), 'Sementsul: T_1');
        }
        emit Collect(msg.sender, recipient, tickLower, tickUpper, amount0, amount1);
    }

    // ---------- обмен ----------

    /// @notice Обмен в одном направлении.
    /// zeroForOne: отдаём token0, цена падает.
    /// amountSpecified > 0 — точный вход, < 0 — точный выход.
    /// sqrtPriceLimitX96 — жёсткая граница цены: за неё обмен не выйдет.
    ///
    /// ОПЛАТА. Если вызывающий — контракт (у него есть код), пул сначала
    /// отдаёт выход и затем требует оплату через uniswapV3SwapCallback. Это
    /// то, чего ждут агрегаторы и арбитражные боты: деньги у них появляются
    /// только после первого плеча маршрута, и заранее выдать approve на сумму,
    /// которой ещё нет, они не могут.
    ///
    /// Для обычного кошелька (кода нет) оплата идёт прежним transferFrom:
    /// кошелёк не умеет отвечать на callback, а ломать привычный путь
    /// «approve + swap» нельзя — на нём работает наш собственный фронтенд.
    ///
    /// Выбор пути определяется наличием кода у msg.sender, а не флагом в
    /// calldata: флаг позволил бы контракту притвориться кошельком и уйти от
    /// оплаты, получив выход.
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external lock returns (int256 amount0, int256 amount1) {
        require(amountSpecified != 0, 'Sementsul: AMOUNT_ZERO');
        require(sqrtPriceX96 != 0, 'Sementsul: NOT_INITIALIZED');
        require(
            zeroForOne
                ? sqrtPriceLimitX96 < sqrtPriceX96 && sqrtPriceLimitX96 > TickMath.MIN_SQRT_RATIO
                : sqrtPriceLimitX96 > sqrtPriceX96 && sqrtPriceLimitX96 < TickMath.MAX_SQRT_RATIO,
            'Sementsul: PRICE_LIMIT'
        );

        // Снимок цены ДО обмена: по нему считается сдвиг для штрафа.
        uint160 priceBefore = sqrtPriceX96;

        bool exactInput = amountSpecified > 0;
        SwapState memory state = SwapState({
            amountSpecifiedRemaining: amountSpecified,
            amountCalculated: 0,
            sqrtPriceX96: sqrtPriceX96,
            tick: tick,
            liquidity: liquidity,
            feeGrowthGlobalX128: zeroForOne ? feeGrowthGlobal0X128 : feeGrowthGlobal1X128
        });

        while (state.amountSpecifiedRemaining != 0 && state.sqrtPriceX96 != sqrtPriceLimitX96) {
            StepComputations memory step;
            step.sqrtPriceStartX96 = state.sqrtPriceX96;

            (step.tickNext, step.initialized) = nextInitializedTickWithinOneWord(
                state.tick,
                tickSpacing,
                zeroForOne
            );
            if (step.tickNext < MIN_TICK) step.tickNext = MIN_TICK;
            if (step.tickNext > MAX_TICK) step.tickNext = MAX_TICK;

            step.sqrtPriceNextX96 = TickMath.getSqrtRatioAtTick(step.tickNext);
            uint160 target = (zeroForOne
                ? step.sqrtPriceNextX96 < sqrtPriceLimitX96
                : step.sqrtPriceNextX96 > sqrtPriceLimitX96)
                ? sqrtPriceLimitX96
                : step.sqrtPriceNextX96;

            (state.sqrtPriceX96, step.amountIn, step.amountOut, step.feeAmount) = SwapMath.computeSwapStep(
                state.sqrtPriceX96,
                target,
                state.liquidity,
                state.amountSpecifiedRemaining,
                fee
            );

            if (exactInput) {
                state.amountSpecifiedRemaining -= int256(step.amountIn + step.feeAmount);
                state.amountCalculated -= int256(step.amountOut);
            } else {
                state.amountSpecifiedRemaining += int256(step.amountOut);
                state.amountCalculated += int256(step.amountIn + step.feeAmount);
            }

            if (state.liquidity > 0) {
                state.feeGrowthGlobalX128 += FullMath.mulDiv(step.feeAmount, 2 ** 128, state.liquidity);
            }

            if (state.sqrtPriceX96 == step.sqrtPriceNextX96) {
                // Дошли до границы диапазона: ликвидность меняется, и тик
                // нужно "пересечь".
                if (step.initialized) {
                    // Передаём накопленное "на лету": обмен мог уже пересечь
                    // предыдущие тики, и в хранилище это значение ещё не
                    // записано. Второй токен в этом обмене комиссии не
                    // начислял, поэтому его глобальное значение берём как есть.
                    _crossTick(
                        step.tickNext,
                        zeroForOne ? state.feeGrowthGlobalX128 : feeGrowthGlobal0X128,
                        zeroForOne ? feeGrowthGlobal1X128 : state.feeGrowthGlobalX128
                    );
                    int128 liquidityNet = ticks[step.tickNext].liquidityNet;
                    if (zeroForOne) liquidityNet = -liquidityNet;
                    state.liquidity = LiquidityMath.addDelta(state.liquidity, liquidityNet);
                }
                state.tick = zeroForOne ? step.tickNext - 1 : step.tickNext;
            } else if (state.sqrtPriceX96 != step.sqrtPriceStartX96) {
                state.tick = TickMath.getTickAtSqrtRatio(state.sqrtPriceX96);
            }
        }

        // Ликвидность ниже по диапазону может закончиться — это не ошибка:
        // обмен прошёл столько, сколько было, и остаток не потрачен. Поэтому
        // здесь нет требования liquidity > 0: при выходе за последний диапазон
        // обмен просто завершается по нулевому остатку входа.
        require(
            state.amountCalculated != 0 || state.sqrtPriceX96 != sqrtPriceX96,
            'Sementsul: NO_SWAP'
        );

        sqrtPriceX96 = state.sqrtPriceX96;
        tick = state.tick;
        liquidity = state.liquidity;
        if (zeroForOne) {
            feeGrowthGlobal0X128 = state.feeGrowthGlobalX128;
        } else {
            feeGrowthGlobal1X128 = state.feeGrowthGlobalX128;
        }

        // Знаки и стороны. Была настоящая ошибка: формула ниже верна только
        // для точного ВХОДА. При точном ВЫХОДЕ сумма входа и сумма выхода
        // меняются местами, потому что amountCalculated тогда накапливает
        // вход, а не выход. Из-за этого amount0 и amount1 при точном выходе
        // возвращались перепутанными, и любой обмен с точным выходом падал.
        //
        // Баг жил незамеченным, потому что точный выход до появления роутера
        // никто не вызывал: наш фронтенд и скрипты работают только с точным
        // входом. Поймал его тест test_exactOutputSingle для роутера.
        //
        // Считаем в блоке, чтобы не добавлять локальные переменные в кадр
        // вызова: swap() и без того упирается в глубину стека.
        {
            int256 received = exactInput
                ? amountSpecified - state.amountSpecifiedRemaining
                : state.amountCalculated;
            int256 paid = exactInput
                ? state.amountCalculated
                : amountSpecified - state.amountSpecifiedRemaining;
            (amount0, amount1) = zeroForOne ? (received, paid) : (paid, received);
        }

        // Штраф за разворот считается ДО выплаты выхода, чтобы он вошёл в
        // сумму, которую платит вызывающий. Вынесено в отдельную функцию:
        // в swap() уже слишком много локальных переменных, и компилятор
        // упирается в глубину стека.
        {
            uint256 p0;
            uint256 p1;
            (p0, p1) = _reversalPenalty(zeroForOne, priceBefore, amount0, amount1);
            _settle(zeroForOne, recipient, amount0, amount1, p0, p1, data);
        }

        emit Swap(msg.sender, recipient, amount0, amount1, state.sqrtPriceX96, state.liquidity, state.tick);
    }

    /// @notice Начислить штраф за разворот в блоке и вернуть его в токенах.
    function _reversalPenalty(bool zeroForOne, uint160 priceBefore, int256 amount0, int256 amount1)
        private
        returns (uint256 penalty0, uint256 penalty1)
    {
        (bool reversal, uint256 shiftBps) = _noteReversal(zeroForOne, priceBefore);
        if (!reversal || shiftBps == 0) return (0, 0);

        uint24 k = ISementsulV3Factory(factory).reversalPenaltyK(fee);
        uint256 rate = (shiftBps * uint256(k)) / 1e6; // ставка в 1e-6
        uint24 cap = ISementsulV3Factory(factory).maxReversalPenalty();
        if (rate > cap) rate = cap;
        if (rate == 0) return (0, 0);

        // Штраф берём с той стороны, которую вызывающий ОТДАЁТ.
        if (amount0 > 0) penalty0 = (uint256(amount0) * rate) / 1e6;
        else if (amount1 > 0) penalty1 = (uint256(amount1) * rate) / 1e6;

        if (penalty0 > 0 || penalty1 > 0) {
            emit ReversalPenaltyPaid(msg.sender, zeroForOne, shiftBps, rate, penalty0, penalty1);
        }
    }

    /// @notice Передать выход и получить оплату.
    ///
    /// Ветка выбирается по наличию кода у msg.sender: кошелёк не умеет
    /// отвечать на callback, поэтому с ним работает привычный transferFrom.
    /// Контракт получает выход сразу и платит в callback'е — так он может
    /// расплатиться деньгами, которые только что получил от предыдущего плеча
    /// маршрута. Именно этого не хватало для агрегаторов.
    function _settle(
        bool zeroForOne,
        address recipient,
        int256 amount0,
        int256 amount1,
        uint256 penalty0,
        uint256 penalty1,
        bytes calldata data
    ) private {
        if (msg.sender.code.length == 0) {
            // ---- кошелёк: тянем деньги напрямую ----
            if (zeroForOne) {
                if (amount1 < 0) require(IERC20(token1).transfer(recipient, uint256(-amount1)), 'Sementsul: OUT_1');
                if (amount0 > 0) {
                    require(
                        IERC20(token0).transferFrom(msg.sender, address(this), uint256(amount0) + penalty0),
                        'Sementsul: IN_0'
                    );
                }
            } else {
                if (amount0 < 0) require(IERC20(token0).transfer(recipient, uint256(-amount0)), 'Sementsul: OUT_0');
                if (amount1 > 0) {
                    require(
                        IERC20(token1).transferFrom(msg.sender, address(this), uint256(amount1) + penalty1),
                        'Sementsul: IN_1'
                    );
                }
            }
            return;
        }

        // ---- контракт: отдаём выход, затем просим оплату ----
        uint256 owed;
        address payToken;
        if (zeroForOne) {
            if (amount1 < 0) require(IERC20(token1).transfer(recipient, uint256(-amount1)), 'Sementsul: OUT_1');
            owed = (amount0 > 0 ? uint256(amount0) : 0) + penalty0;
            payToken = token0;
        } else {
            if (amount0 < 0) require(IERC20(token0).transfer(recipient, uint256(-amount0)), 'Sementsul: OUT_0');
            owed = (amount1 > 0 ? uint256(amount1) : 0) + penalty1;
            payToken = token1;
        }

        uint256 balanceBefore = IERC20(payToken).balanceOf(address(this));

        // ВАЖНО: в callback передаём дельты, УЖЕ включающие штраф.
        //
        // Первая версия передавала «чистые» amount0/amount1, а долг со
        // штрафом держала в отдельном поле. Роутер платил по дельте, то есть
        // без штрафа, и пул откатывал обмен с UNPAID. Ошибку поймали тесты
        // FalsePositive: любая легальная сделка с разворотом в блоке падала.
        //
        // Теперь дельта в callback'е — это ровно то, что нужно заплатить.
        // Так соглашение совпадает с Uniswap: вызывающий платит то, что ему
        // сказали, и не пересчитывает ничего сам.
        int256 cb0 = amount0 > 0 ? amount0 + int256(penalty0) : amount0;
        int256 cb1 = amount1 > 0 ? amount1 + int256(penalty1) : amount1;

        _callbackOwed = owed;
        _callbackActive = true;
        IUniswapV3SwapCallback(msg.sender).uniswapV3SwapCallback(cb0, cb1, data);
        _callbackActive = false;
        _callbackOwed = 0;

        // Единственная настоящая проверка оплаты: баланс должен вырасти хотя
        // бы на долг. Без неё контракт ответил бы на callback пустым телом и
        // получил выход бесплатно.
        require(IERC20(payToken).balanceOf(address(this)) >= balanceBefore + owed, 'Sementsul: UNPAID');
    }

    /// @notice Оплата обмена, как в Uniswap V3.
    ///
    /// Пул вызывает этот метод ПОСЛЕ того, как отдал выход, и ожидает, что
    /// вызывающий переведёт долг. Сумма долга лежит в _callbackOwed: она
    /// включает и стоимость входа, и штраф за разворот, если он начислен.
    /// Сам пул потом сверяет рост баланса, поэтому «пустой» ответ на callback
    /// не даёт получить выход бесплатно.
    ///
    /// Параметр data передаётся обратно без изменений: через него роутер
    /// узнаёт, кто платит и по какому маршруту он идёт.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        _payCallback(amount0Delta, amount1Delta, data);
    }

    /// @notice То же под именем Pancake: часть инструментов BSC ищет именно
    /// этот селектор и без него не считает пул совместимым.
    function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        _payCallback(amount0Delta, amount1Delta, data);
    }

    function _payCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) private {
        // Платит только тот, кого пул сам вызвал. Иначе посторонний контракт
        // мог бы «оплатить» чужой обмен и запутать учёт.
        require(_callbackActive, 'Sementsul: NO_CALLBACK');
        data; // маршрут читает сам вызывающий; пул его только возвращает

        // Платный токен — тот, который вызывающий отдаёт (положительная дельта).
        address payToken = amount0Delta > 0 ? token0 : token1;
        uint256 owed = _callbackOwed;
        require(owed > 0, 'Sementsul: NOTHING_OWED');

        require(IERC20(payToken).transferFrom(msg.sender, address(this), owed), 'Sementsul: CB_PAY');
    }

    // ---------- внутреннее ----------

    /// @notice Определить, является ли текущий обмен разворотом в блоке, и
    /// насколько цена уже сдвинулась.
    ///
    /// Возвращает (разворот?, сдвиг в 1e-6 от стартовой цены).
    ///
    /// Почему это вообще делается. Сэндвич — это покупка перед чужой сделкой
    /// и продажа после. Оба плеча идут в ОДНОМ блоке и в противоположных
    /// направлениях. Значит разворот внутри блока — необходимый признак
    /// сэндвича (но не достаточный: так же выглядит и треугольный арбитраж,
    /// и просто пользователь, который передумал).
    ///
    /// Ограничения, о которых честно. Механизм обходится переносом второго
    /// плеча в следующий блок: на BSC блок 0.448 с, ждать дёшево. Поэтому
    /// штраф — не замена приватному RPC, а дополнительный барьер, который
    /// повышает цену грубого сэндвича в одном блоке. Он выключен по умолчанию
    /// именно из-за этого компромисса.
    function _noteReversal(bool zeroForOne, uint160 priceBefore)
        private
        returns (bool reversal, uint256 shiftBps)
    {
        uint24 k = ISementsulV3Factory(factory).reversalPenaltyK(fee);
        if (k == 0) return (false, 0);

        if (_reversal.blockNumber != block.number) {
            // Первый обмен в блоке: запоминаем точку отсчёта.
            _reversal.blockNumber = block.number;
            _reversal.priceStart = priceBefore;
            _reversal.lastDirection = zeroForOne ? int8(1) : int8(-1);
            _reversal.traded = true;
            return (false, 0);
        }

        bool isReversal = (zeroForOne && _reversal.lastDirection == -1)
            || (!zeroForOne && _reversal.lastDirection == 1);
        _reversal.lastDirection = zeroForOne ? int8(1) : int8(-1);

        if (!isReversal) return (false, 0);

        // Правило маршрута: если в этом блоке уже торговал ДРУГОЙ пул нашей
        // фабрики, это может быть маршрут через несколько пулов (арбитраж или
        // агрегатор). Наказывать его нельзя — там разворот не атака, а способ
        // свести цену к рыночной сразу в нескольких пулах.
        bool multiPool = ISementsulV3Factory(factory).noteSwap(address(this));
        if (multiPool) return (false, 0);

        // Сдвиг от начала блока до текущей цены.
        if (_reversal.priceStart == priceBefore) return (true, 0);
        uint256 big = _reversal.priceStart > priceBefore ? _reversal.priceStart : priceBefore;
        uint256 small = _reversal.priceStart > priceBefore ? priceBefore : _reversal.priceStart;
        shiftBps = ((big - small) * 1_000_000) / big;

        return (true, shiftBps);
    }

    function _positionKey(address owner, int24 tickLower, int24 tickUpper) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(owner, tickLower, tickUpper));
    }

    /// @notice Найти ближайший инициализированный тик в пределах одного
    /// 256-битного слова. Реализовано здесь, а не в библиотеке, потому что
    /// обращается к хранилищу пула напрямую.
    function nextInitializedTickWithinOneWord(int24 tickCurrent, int24 spacing, bool lte)
        internal
        view
        returns (int24 next, bool initialized)
    {
        int24 compressed = tickCurrent / spacing;
        if (tickCurrent < 0 && tickCurrent % spacing != 0) compressed--;

        if (lte) {
            int16 wordPos = int16(compressed >> 8);
            uint256 bitPos = uint256(uint8(uint24(compressed % 256)));
            uint256 mask = (1 << bitPos) - 1 + (1 << bitPos);
            uint256 masked = tickBitmap[wordPos] & mask;

            initialized = masked != 0;
            next = initialized
                ? ((int24(wordPos) << 8) + int24(uint24(mostSignificantBit(masked)))) * spacing
                : (int24(wordPos) << 8) * spacing;
        } else {
            int16 wordPos = int16((compressed + 1) >> 8);
            uint256 bitPos = uint256(uint8(uint24((compressed + 1) % 256)));
            uint256 mask = ~((1 << bitPos) - 1);
            uint256 masked = tickBitmap[wordPos] & mask;

            initialized = masked != 0;
            next = initialized
                ? ((int24(wordPos) << 8) + int24(uint24(leastSignificantBit(masked)))) * spacing
                : ((int24(wordPos) << 8) + 255) * spacing;
        }
    }

    function mostSignificantBit(uint256 x) internal pure returns (uint8 r) {
        require(x > 0, 'Sementsul: MSB');
        if (x >= 0x100000000000000000000000000000000) { x >>= 128; r += 128; }
        if (x >= 0x10000000000000000) { x >>= 64; r += 64; }
        if (x >= 0x100000000) { x >>= 32; r += 32; }
        if (x >= 0x10000) { x >>= 16; r += 16; }
        if (x >= 0x100) { x >>= 8; r += 8; }
        if (x >= 0x10) { x >>= 4; r += 4; }
        if (x >= 0x4) { x >>= 2; r += 2; }
        if (x >= 0x2) r += 1;
    }

    function leastSignificantBit(uint256 x) internal pure returns (uint8 r) {
        require(x > 0, 'Sementsul: LSB');
        r = 255;
        if (x & type(uint128).max > 0) r -= 128; else x >>= 128;
        if (x & type(uint64).max > 0) r -= 64; else x >>= 64;
        if (x & type(uint32).max > 0) r -= 32; else x >>= 32;
        if (x & type(uint16).max > 0) r -= 16; else x >>= 16;
        if (x & type(uint8).max > 0) r -= 8; else x >>= 8;
        if (x & 0xf > 0) r -= 4; else x >>= 4;
        if (x & 0x3 > 0) r -= 2; else x >>= 2;
        if (x & 0x1 > 0) r -= 1;
    }

    /// @param roundUp Округление. При добавлении ликвидности округляем вверх:
    /// лишние wei доплачивает вкладчик. При выводе — вниз: иначе сумма
    /// округлённых вверх долей может превысить то, что реально лежит на пуле,
    /// и последний вывод упрётся в нехватку баланса. Разница в 1 wei
    /// остаётся в пуле и достаётся оставшимся поставщикам.
    function _amountsForLiquidity(uint160 price, int24 tickLower, int24 tickUpper, uint128 liq, bool roundUp)
        internal
        pure
        returns (uint256 amount0, uint256 amount1)
    {
        uint160 sqrtA = TickMath.getSqrtRatioAtTick(tickLower);
        uint160 sqrtB = TickMath.getSqrtRatioAtTick(tickUpper);

        if (price <= sqrtA) {
            amount0 = SqrtPriceMath.getAmount0Delta(sqrtA, sqrtB, liq, roundUp);
        } else if (price < sqrtB) {
            amount0 = SqrtPriceMath.getAmount0Delta(price, sqrtB, liq, roundUp);
            amount1 = SqrtPriceMath.getAmount1Delta(sqrtA, price, liq, roundUp);
        } else {
            amount1 = SqrtPriceMath.getAmount1Delta(sqrtA, sqrtB, liq, roundUp);
        }
    }

    /// @notice Изменить позицию: обновить тики, глобальную ликвидность и
    /// зафиксировать начисленные комиссии.
    /// liquidityDelta = 0 используется для одного лишь сбора комиссий.
    function _modifyPosition(address owner, int24 tickLower, int24 tickUpper, int128 liquidityDelta) private {
        bytes32 key = _positionKey(owner, tickLower, tickUpper);
        Position storage position = positions[key];

        // Комиссия внутри диапазона считается до изменения ликвидности:
        // иначе начисленное пересчиталось бы по новой доле и оказалось
        // неверным.
        (uint256 inside0, uint256 inside1) = _feeGrowthInside(tickLower, tickUpper, tick);

        if (position.liquidity > 0) {
            uint128 owed0 = uint128(
                FullMath.mulDiv(inside0 - position.feeGrowthInside0LastX128, position.liquidity, 2 ** 128)
            );
            uint128 owed1 = uint128(
                FullMath.mulDiv(inside1 - position.feeGrowthInside1LastX128, position.liquidity, 2 ** 128)
            );

            uint64 delay = _jitDelay();
            if (delay == 0) {
                position.tokensOwed0 += owed0;
                position.tokensOwed1 += owed1;
            } else {
                // Сначала снимаем блокировку с того, что уже отлежалось,
                // и только потом добавляем новое: иначе свежая комиссия
                // отодвинула бы срок и старой тоже.
                _settlePending(position);
                if (owed0 > 0 || owed1 > 0) {
                    position.pending0 += owed0;
                    position.pending1 += owed1;
                    // Срок отсчитывается от ПЕРВОЙ неотлежавшей комиссии и
                    // дальше не сдвигается. Если бы каждый новый приход
                    // продлевал срок, в оживлённом пуле комиссию нельзя было
                    // бы забрать никогда — а это уже не защита от JIT, а
                    // конфискация у честного LP.
                    if (position.vestBlock == 0) {
                        position.vestBlock = uint64(block.number) + delay;
                    }
                }
            }
        }

        if (liquidityDelta != 0) {
            // ---- защита от JIT ----
            // Снимать ликвидность до истечения вестинга можно, но вместе с
            // ней сгорает соразмерная доля ещё не разблокированных комиссий.
            // Именно этого JIT-бот и не может себе позволить: он входит ради
            // одного свопа и сразу выходит, то есть снимает 100% — и теряет
            // 100% начисленного. Оставить «пылинку» ликвидности и забрать
            // всё не выйдет по той же пропорции.
            if (liquidityDelta < 0 && (position.pending0 > 0 || position.pending1 > 0)) {
                uint128 gross = position.liquidity;
                uint128 removed = uint128(-liquidityDelta);
                if (removed >= gross) {
                    position.pending0 = 0;
                    position.pending1 = 0;
                    position.vestBlock = 0;
                } else {
                    uint128 keep = gross - removed;
                    position.pending0 = uint128((uint256(position.pending0) * keep) / gross);
                    position.pending1 = uint128((uint256(position.pending1) * keep) / gross);
                }
            }

            // Обе границы получают одинаковый прирост liquidityGross, но
            // противоположный liquidityNet: при входе в диапазон нижняя
            // граница ликвидность добавляет, верхняя — снимает. Инвертировать
            // весь delta нельзя: на верхней границе gross ушёл бы в минус.
            _updateTick(tickLower, liquidityDelta, false, tick);
            _updateTick(tickUpper, liquidityDelta, true, tick);

            if (tick >= tickLower && tick < tickUpper) {
                liquidity = LiquidityMath.addDelta(liquidity, liquidityDelta);
            }

            position.liquidity = LiquidityMath.addDelta(position.liquidity, liquidityDelta);
            require(sqrtPriceX96 != 0, 'Sementsul: NOT_INITIALIZED');
        }

        position.feeGrowthInside0LastX128 = inside0;
        position.feeGrowthInside1LastX128 = inside1;
    }

    /// @notice Срок вестинга для тира этого пула. Читается через вызов, а не
    /// копируется в пул: иначе смену настройки пришлось бы протаскивать в
    /// каждый уже созданный пул.
    function _jitDelay() private view returns (uint64) {
        return SementsulV3Factory(factory).jitDelayBlocks(fee);
    }

    /// @notice Перевести отлежавшиеся комиссии из pending в доступные.
    function _settlePending(Position storage position) private {
        uint64 v = position.vestBlock;
        if (v != 0 && block.number >= v) {
            position.tokensOwed0 += position.pending0;
            position.tokensOwed1 += position.pending1;
            position.pending0 = 0;
            position.pending1 = 0;
            position.vestBlock = 0;
        }
    }

    /// @param isUpper Граница диапазона: у верхней liquidityNet имеет обратный
    /// знак, потому что при пересечении вниз ликвидность снимается.
    function _updateTick(int24 tickToUpdate, int128 liquidityDelta, bool isUpper, int24 tickCurrent) private {
        TickInfo storage info = ticks[tickToUpdate];
        uint128 grossBefore = info.liquidityGross;
        uint128 grossAfter = LiquidityMath.addDelta(grossBefore, liquidityDelta);

        if (grossBefore == 0 && liquidityDelta > 0) {
            // Первая инициализация: комиссия «снаружи» — вся накопленная до
            // тика, если он не выше текущего, иначе ноль.
            if (tickToUpdate <= tickCurrent) {
                info.feeGrowthOutside0X128 = feeGrowthGlobal0X128;
                info.feeGrowthOutside1X128 = feeGrowthGlobal1X128;
            }
            info.initialized = true;
            _flipTick(tickToUpdate);
        }

        info.liquidityGross = grossAfter;
        int128 netDelta = isUpper ? -liquidityDelta : liquidityDelta;
        info.liquidityNet = int128(int256(info.liquidityNet) + int256(netDelta));

        if (grossAfter == 0) {
            // Диапазон полностью выведен: чистим, чтобы не копить мусор и не
            // искажать будущие начисления.
            delete info.feeGrowthOutside0X128;
            delete info.feeGrowthOutside1X128;
            delete info.initialized;
            delete info.liquidityNet;
            _flipTick(tickToUpdate);
        }
    }

    function _flipTick(int24 tickToFlip) private {
        int24 compressed = tickToFlip / tickSpacing;
        if (tickToFlip < 0 && tickToFlip % tickSpacing != 0) compressed--;
        int16 wordPos = int16(compressed >> 8);
        uint256 bitPos = uint256(uint8(uint24(compressed % 256)));
        tickBitmap[wordPos] ^= (1 << bitPos);
    }

    /// @notice Пересечение тика: комиссия "снаружи" переворачивается.
    /// "Снаружи" означает "по ту сторону от текущей цены", а после
    /// пересечения сторона меняется. Без этого переворота комиссии при
    /// движении цены вниз и обратно начислялись бы дважды: поставщик получал
    /// бы больше, чем собрал пул, и последний вывод упирался бы в нехватку
    /// баланса. Инвариант: outside + inside = global.
    ///
    /// Глобальные значения передаются аргументами, а не читаются из хранилища:
    /// за один обмен цена может пересечь несколько тиков, и накопленная внутри
    /// обмена комиссия ещё не записана в feeGrowthGlobal0X128/1X128. Если
    /// брать её из хранилища, все пересечения внутри одного обмена увидят одно
    /// и то же устаревшее значение, "снаружи" окажется заниженным, а
    /// начисленная позициям комиссия — завышенной. Пул тогда обещает больше,
    /// чем собрал, и последний вывод не проходит по балансу.
    /// Одно из двух значений — накопленное в текущем обмене, второе —
    /// записанное: комиссия всегда начисляется в токене входа.
    function _crossTick(int24 tickToCross, uint256 global0X128, uint256 global1X128) private {
        TickInfo storage info = ticks[tickToCross];
        info.feeGrowthOutside0X128 = global0X128 - info.feeGrowthOutside0X128;
        info.feeGrowthOutside1X128 = global1X128 - info.feeGrowthOutside1X128;
    }

    /// @notice Комиссия, накопленная внутри диапазона: глобальная минус
    /// «снаружи нижней» минус «снаружи верхней».
    function _feeGrowthInside(int24 tickLower, int24 tickUpper, int24 tickCurrent)
        private
        view
        returns (uint256 inside0, uint256 inside1)
    {
        TickInfo storage lower = ticks[tickLower];
        TickInfo storage upper = ticks[tickUpper];

        uint256 below0;
        uint256 below1;
        if (tickCurrent >= tickLower) {
            below0 = lower.feeGrowthOutside0X128;
            below1 = lower.feeGrowthOutside1X128;
        } else {
            below0 = feeGrowthGlobal0X128 - lower.feeGrowthOutside0X128;
            below1 = feeGrowthGlobal1X128 - lower.feeGrowthOutside1X128;
        }

        uint256 above0;
        uint256 above1;
        if (tickCurrent < tickUpper) {
            above0 = upper.feeGrowthOutside0X128;
            above1 = upper.feeGrowthOutside1X128;
        } else {
            above0 = feeGrowthGlobal0X128 - upper.feeGrowthOutside0X128;
            above1 = feeGrowthGlobal1X128 - upper.feeGrowthOutside1X128;
        }

        inside0 = feeGrowthGlobal0X128 - below0 - above0;
        inside1 = feeGrowthGlobal1X128 - below1 - above1;
    }
}
