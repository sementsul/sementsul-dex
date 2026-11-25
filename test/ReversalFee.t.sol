// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {SementsulV3Factory, SementsulV3Pool} from "../contracts/SementsulV3.sol";
import {TickMath} from "../contracts/SementsulV3Math.sol";

contract HopToken {
    string public name = "T";
    string public symbol = "T";
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

/// Хук «штраф за разворот в блоке», ставка пропорциональна сдвигу цены.
///
/// Это ПРОТОТИП, не часть контракта пула. Задача — измерить цену вопроса:
/// сколько стоит учёт состояния в блоке и не ломает ли он нормальные маршруты.
contract ReversalFeeModel {
    struct BlockState {
        uint256 blockNumber;
        uint160 priceStart; // цена на входе в блок
        int8 lastDirection; // 1 = zeroForOne, -1 = обратный, 0 = не было
        bool traded;
    }

    mapping(bytes32 => BlockState) public state;

    /// k = 1: ставка штрафа численно равна сдвигу цены в тех же долях.
    /// Сдвиг 1% -> ставка 1%. Прибыль бота растёт как сдвиг в квадрате, и
    /// штраф тоже — именно поэтому фиксированный процент не работает.
    uint256 public constant K = 1;

    event PenaltyApplied(bytes32 poolKey, uint256 shiftBps, uint256 penaltyBps);

    /// Считает штраф для свопа. Возвращает ставку в 1e-6.
    ///
    /// Принимает ТОЛЬКО цену до свопа: точку отсчёта и текущую цену пул знает
    /// сам. В первой версии я передавал «до» и «после» двумя аргументами и в
    /// тестах подавал одно и то же значение дважды — сдвиг всегда выходил
    /// нулевым, и штраф тоже. Это была ошибка теста, а не модели.
    function penaltyFor(bytes32 poolKey, uint160 priceBeforeSwap, bool zeroForOne)
        public
        returns (uint256 penaltyBps)
    {
        BlockState storage s = state[poolKey];

        if (s.blockNumber != block.number) {
            // Первый своп в блоке: запоминаем точку отсчёта — цену ДО него.
            s.blockNumber = block.number;
            s.priceStart = priceBeforeSwap;
            s.lastDirection = zeroForOne ? int8(1) : int8(-1);
            s.traded = true;
            return 0;
        }

        if (!s.traded) return 0;

        bool isReversal = (zeroForOne && s.lastDirection == -1) || (!zeroForOne && s.lastDirection == 1);
        s.lastDirection = zeroForOne ? int8(1) : int8(-1);

        if (!isReversal) return 0;

        // Сдвиг от начала блока до ТЕКУЩЕЙ цены (то есть до этого свопа).
        uint256 shiftBps = _absDiffBps(s.priceStart, priceBeforeSwap);
        penaltyBps = shiftBps * K;

        // Потолок: не больше 10%, иначе это запрет торговли, а не защита.
        if (penaltyBps > 100_000) penaltyBps = 100_000;

        emit PenaltyApplied(poolKey, shiftBps, penaltyBps);
    }

    function _absDiffBps(uint160 a, uint160 b) internal pure returns (uint256) {
        if (a == b) return 0;
        uint256 big = a > b ? a : b;
        uint256 small = a > b ? b : a;
        return ((big - small) * 1_000_000) / big;
    }
}

contract ReversalFeeTest is Test {
    SementsulV3Factory factory;
    SementsulV3Pool pool;
    HopToken t0;
    HopToken t1;
    ReversalFeeModel model;

    uint24 constant FEE = 500;
    int24 constant SPACING = 10;
    int24 constant LOWER = -6000;
    int24 constant UPPER = 6000;
    uint160 constant P = 79228162514264337593543950336;

    address lp = address(0xAA);
    address bot = address(0xB0);
    address user = address(0xC0);

    bytes32 poolKey;

    function setUp() public {
        uint24[] memory fees = new uint24[](1);
        fees[0] = FEE;
        int24[] memory spacings = new int24[](1);
        spacings[0] = SPACING;
        factory = new SementsulV3Factory(fees, spacings, address(this));

        HopToken a = new HopToken();
        HopToken b = new HopToken();
        (t0, t1) = address(a) < address(b) ? (a, b) : (b, a);

        pool = SementsulV3Pool(factory.createPool(address(t0), address(t1), FEE));
        pool.initializePrice(P);

        t0.mint(lp, 1e27);
        t1.mint(lp, 1e27);
        vm.startPrank(lp);
        t0.approve(address(pool), type(uint256).max);
        t1.approve(address(pool), type(uint256).max);
        pool.mint(lp, LOWER, UPPER, 1e23);
        vm.stopPrank();

        model = new ReversalFeeModel();
        poolKey = keccak256(abi.encode(address(pool)));

        address[2] memory who = [bot, user];
        for (uint256 i = 0; i < 2; i++) {
            t0.mint(who[i], 1e24);
            t1.mint(who[i], 1e24);
            vm.startPrank(who[i]);
            t0.approve(address(pool), type(uint256).max);
            t1.approve(address(pool), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _swap(address who, bool zeroForOne, uint256 amountIn) internal returns (int256, int256) {
        uint160 limit = TickMath.getSqrtRatioAtTick(zeroForOne ? int24(-6000) : int24(6000));
        vm.prank(who);
        return pool.swap(who, zeroForOne, int256(amountIn), limit, "");
    }

    function _price() internal view returns (uint160 p) {
        (p,,,,) = pool.slot0();
    }

    /// 1. Сэндвич: первое плечо бесплатно, обратное — со штрафом.
    function test_sandwichSecondLegPenalized() public {
        uint160 p0 = _price();
        uint256 p1 = model.penaltyFor(poolKey, p0, true);
        emit log_named_uint("bot leg 1 penalty, 1e-6", p1);
        assertEq(p1, 0, "first swap in block must be free");

        _swap(bot, true, 1e22);
        uint160 pAfterBot = _price();

        // Жертва идёт в ТУ ЖЕ сторону — не разворот, штрафа нет.
        uint256 pv = model.penaltyFor(poolKey, pAfterBot, true);
        emit log_named_uint("victim penalty, 1e-6", pv);
        assertEq(pv, 0, "same direction is not a reversal");
        _swap(user, true, 1e21);

        // Бот выходит в обратную сторону — вот тут штраф.
        uint160 pBeforeBot2 = _price();
        uint256 p2 = model.penaltyFor(poolKey, pBeforeBot2, false);
        emit log_named_uint("bot leg 2 penalty, 1e-6", p2);
        assertGt(p2, 0, "reversal must be penalized");
    }

    /// 2. Штраф растёт вместе со сдвигом цены.
    function test_penaltyScalesWithShift() public {
        // Малый сдвиг в одном блоке.
        vm.roll(100);
        uint160 pStartSmall = _price();
        model.penaltyFor(poolKey, pStartSmall, true);
        _swap(bot, true, 1e21);
        uint160 pSmall = _price();
        uint256 small = model.penaltyFor(poolKey, pSmall, false);

        // Большой сдвиг в следующем блоке.
        vm.roll(200);
        uint160 pStart = _price();
        model.penaltyFor(poolKey, pStart, true);
        _swap(bot, true, 1e23);
        uint160 pBig = _price();
        uint256 big = model.penaltyFor(poolKey, pBig, false);

        emit log_named_uint("small shift penalty, 1e-6", small);
        emit log_named_uint("big shift penalty, 1e-6", big);
        assertGt(small, 0, "small shift must also produce a penalty");
        assertGt(big, small, "penalty must grow with the shift");
    }

    /// 3. Односторонний арбитраж НЕ наказывается.
    function test_oneWayArbNotPenalized() public {
        vm.roll(300);
        uint160 p0 = _price();
        model.penaltyFor(poolKey, p0, true);
        _swap(bot, true, 1e21);

        uint160 p1 = _price();
        uint256 p2 = model.penaltyFor(poolKey, p1, true);
        emit log_named_uint("one-way second arb penalty, 1e-6", p2);
        assertEq(p2, 0, "same-direction arb must not be penalized");
    }

    /// 4. ГЛАВНЫЙ РИСК: треугольный арбитраж через один пул дважды.
    function test_triangularArbIsPunished() public {
        vm.roll(400);
        uint160 p0 = _price();

        model.penaltyFor(poolKey, p0, true);
        _swap(bot, true, 1e21);

        uint160 p1 = _price();
        uint256 p2 = model.penaltyFor(poolKey, p1, false);

        emit log_named_uint("triangular arb penalty, 1e-6", p2);
        emit log_named_string(
            "verdict",
            p2 > 0 ? "triangular arb IS penalized - this is the real cost" : "not penalized"
        );

        assertGt(p2, 0, "triangular arb through same pool looks like a reversal");
    }

    /// 5. Сколько газа стоит учёт состояния в блоке.
    ///
    /// Порог не «красивое число», а сравнение с пользой: своп в нашем пуле
    /// стоит порядка 100-150k газа. Если накладные больше половины стоимости
    /// свопа, защита дороже проблемы.
    function test_gasCostOfBlockState() public {
        vm.roll(500);
        uint160 p0 = _price();

        uint256 g0 = gasleft();
        model.penaltyFor(poolKey, p0, true);
        uint256 firstSwap = g0 - gasleft();

        vm.roll(501);
        uint160 p1 = _price();
        uint256 g1 = gasleft();
        model.penaltyFor(poolKey, p1, true);
        uint256 newBlock = g1 - gasleft();

        uint160 p2 = _price();
        uint256 g2 = gasleft();
        model.penaltyFor(poolKey, p2, false);
        uint256 sameBlockCheck = g2 - gasleft();

        emit log_named_uint("gas: first swap in block (cold SSTORE)", firstSwap);
        emit log_named_uint("gas: first swap in NEW block", newBlock);
        emit log_named_uint("gas: reversal check (warm)", sameBlockCheck);

        assertLt(firstSwap, 100_000, "overhead must stay below a swap's own cost");
    }

    /// 6. ДЫРА ВСЕЙ ИДЕИ: бот просто разносит плечи по разным блокам.
    ///
    /// На BSC блок = 0.448 с. Бот с гарантированным включением в следующий
    /// блок ждёт 0.45 с вместо риска быть пойманным. Сэндвич, растянутый на
    /// два блока, для хука выглядит как два независимых односторонних свопа —
    /// штрафа нет вообще. Проверяем это прямо.
    function test_botEscapesBySplittingAcrossBlocks() public {
        // Блок 600: бот входит. Направление вниз.
        vm.roll(600);
        uint160 p0 = _price();
        uint256 leg1 = model.penaltyFor(poolKey, p0, true);
        _swap(bot, true, 1e22);

        // Жертва в ТОМ ЖЕ блоке — она и есть цель.
        uint160 pv = _price();
        model.penaltyFor(poolKey, pv, true);
        _swap(user, true, 1e21);

        // Блок 601: бот выходит. Новый блок — состояние сброшено.
        vm.roll(601);
        uint160 p1 = _price();
        uint256 leg2 = model.penaltyFor(poolKey, p1, false);

        emit log_named_uint("leg 1 penalty (same block, opening)", leg1);
        emit log_named_uint("leg 2 penalty (NEXT block, closing)", leg2);
        emit log_named_string("bot cost of waiting one block", "0.448 s");

        assertEq(leg2, 0, "splitting the sandwich across blocks evades the penalty");

        // Это не гипотеза о будущем: на BSC 0.448 с на блок, и включение
        // в следующий блок для бота дешевле, чем потеря всей прибыли.
        emit log_named_string(
            "conclusion",
            "penalty only bites if BOTH legs land in ONE block"
        );

        // Дополнительно: даже в одном блоке бот может обойти правило,
        // если у него ДВА адреса — по одному на плечо. Проверяем.
        vm.roll(700);
        address botB = address(0xB2);
        t0.mint(botB, 1e24);
        t1.mint(botB, 1e24);
        vm.startPrank(botB);
        t0.approve(address(pool), type(uint256).max);
        t1.approve(address(pool), type(uint256).max);
        vm.stopPrank();

        bytes32 keyB = keccak256(abi.encode(address(pool), "walletB"));
        uint160 q0 = _price();
        model.penaltyFor(poolKey, q0, true);
        _swap(bot, true, 1e21);
        uint160 q1 = _price();
        // Второе плечо — с ДРУГИМ ключом состояния, будто другой адрес.
        uint256 pTwoWallets = model.penaltyFor(keyB, q1, false);
        emit log_named_uint("two-wallet reversal penalty, 1e-6", pTwoWallets);
        assertEq(pTwoWallets, 0, "per-initiator state is bypassed by a second wallet");
    }
}