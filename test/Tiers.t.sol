// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {SementsulV3Factory, SementsulV3Pool} from "../contracts/SementsulV3.sol";

contract TierToken {
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

/// Четыре тира комиссии на одной фабрике.
///
/// Проверяем главное, что даёт эта переделка:
///   1. на одну пару можно создать четыре РАЗНЫХ пула (раньше — только один);
///   2. каждый пул знает свою комиссию и свой шаг тика;
///   3. адреса пулов не совпадают (соль включает комиссию);
///   4. getPool(t0, t1, fee) и событие PoolCreated совпадают с эталоном
///      Uniswap — иначе индексаторы пулы не увидят;
///   5. задержка JIT растёт вместе со ставкой.
contract TiersTest is Test {
    uint24[] fees;
    int24[] spacings;

    uint24 constant F_005 = 50; // 0.005%
    uint24 constant F_0050 = 500; // 0.05%
    uint24 constant F_025 = 2500; // 0.25%
    uint24 constant F_1 = 10000; // 1%

    // topic0 события Uniswap V3 PoolCreated.
    bytes32 constant UNISWAP_POOL_CREATED_TOPIC =
        0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118;

    function _factory() internal returns (SementsulV3Factory) {
        fees = new uint24[](4);
        fees[0] = F_005;
        fees[1] = F_0050;
        fees[2] = F_025;
        fees[3] = F_1;

        spacings = new int24[](4);
        spacings[0] = 1;
        spacings[1] = 10;
        spacings[2] = 50;
        spacings[3] = 200;

        return new SementsulV3Factory(fees, spacings, address(this));
    }

    function test_fourTiers_registered() public {
        SementsulV3Factory f = _factory();
        assertEq(f.feeTiersLength(), 4, "must have 4 tiers");

        for (uint256 i = 0; i < 4; i++) {
            assertEq(f.feeTiers(i), fees[i], "tier order");
            assertEq(f.tickSpacingFor(fees[i]), spacings[i], "spacing per tier");
        }
    }

    /// Ключевое: одна пара — четыре независимых пула.
    function test_fourTiers_fourDistinctPoolsForOnePair() public {
        SementsulV3Factory f = _factory();

        TierToken a = new TierToken();
        TierToken b = new TierToken();

        address[4] memory pools;
        for (uint256 i = 0; i < 4; i++) {
            pools[i] = f.createPool(address(a), address(b), fees[i]);
        }

        // Все четыре адреса различны.
        for (uint256 i = 0; i < 4; i++) {
            for (uint256 j = i + 1; j < 4; j++) {
                assertTrue(pools[i] != pools[j], "pool addresses must differ");
            }
        }

        // Каждый пул знает свою комиссию.
        for (uint256 i = 0; i < 4; i++) {
            assertEq(SementsulV3Pool(pools[i]).fee(), fees[i], "pool fee");
            assertEq(SementsulV3Pool(pools[i]).tickSpacing(), spacings[i], "pool spacing");
        }

        assertEq(f.allPoolsLength(), 4, "four pools indexed");
    }

    /// getPool — та функция, которую зовут индексаторы. Проверяем оба порядка.
    function test_getPool_matchesCreatedPool() public {
        SementsulV3Factory f = _factory();

        TierToken a = new TierToken();
        TierToken b = new TierToken();

        for (uint256 i = 0; i < 4; i++) {
            address created = f.createPool(address(a), address(b), fees[i]);

            assertEq(f.getPool(address(a), address(b), fees[i]), created, "getPool direct");
            assertEq(f.getPool(address(b), address(a), fees[i]), created, "getPool reversed");
            // poolFor должен предсказывать тот же адрес (CREATE2).
            assertEq(f.poolFor(address(a), address(b), fees[i]), created, "poolFor must match");
        }
    }

    /// Дубликат и неизвестный тир отвергаются.
    function test_tiers_rejectDuplicatesAndUnknown() public {
        SementsulV3Factory f = _factory();
        TierToken a = new TierToken();
        TierToken b = new TierToken();

        f.createPool(address(a), address(b), F_0050);

        vm.expectRevert("Sementsul: POOL_EXISTS");
        f.createPool(address(a), address(b), F_0050);

        vm.expectRevert("Sementsul: FEE_NOT_ENABLED");
        f.createPool(address(a), address(b), 7777);
    }

    /// Событие PoolCreated должно иметь ровно тот topic0, что у Uniswap —
    /// иначе пул для индексаторов не существует.
    function test_poolCreated_matchesUniswapTopic0() public {
        bytes32 ours = keccak256("PoolCreated(address,address,uint24,int24,address)");
        assertEq(ours, UNISWAP_POOL_CREATED_TOPIC, "topic0 must match Uniswap V3");
    }

    /// Событие несёт комиссию и шаг тика: без них индексатор не поймёт,
    /// какой это пул.
    function test_poolCreated_carriesFeeAndSpacing() public {
        SementsulV3Factory f = _factory();
        TierToken a = new TierToken();
        TierToken b = new TierToken();

        (address t0, address t1) = address(a) < address(b) ? (address(a), address(b)) : (address(b), address(a));

        vm.recordLogs();
        f.createPool(address(a), address(b), F_025);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] != UNISWAP_POOL_CREATED_TOPIC) continue;
            found = true;
            assertEq(logs[i].topics[1], bytes32(uint256(uint160(t0))), "token0 indexed");
            assertEq(logs[i].topics[2], bytes32(uint256(uint160(t1))), "token1 indexed");
            assertEq(uint256(logs[i].topics[3]), uint256(F_025), "fee indexed");
            // Данные: tickSpacing и адрес пула.
            (int24 spacing, address pool) = abi.decode(logs[i].data, (int24, address));
            assertEq(spacing, 50, "tickSpacing in data");
            assertEq(pool, f.getPool(t0, t1, F_025), "pool in data");
        }
        assertTrue(found, "PoolCreated must be emitted with Uniswap topic0");
    }

    /// Задержка JIT растёт вместе со ставкой — иначе на низких тирах защита
    /// вырождается, а на высоких бьёт по честному поставщику.
    function test_jitDelay_scalesWithFee() public {
        SementsulV3Factory f = _factory();

        uint64 d005 = f.jitDelayBlocks(F_005);
        uint64 d0050 = f.jitDelayBlocks(F_0050);
        uint64 d025 = f.jitDelayBlocks(F_025);
        uint64 d1 = f.jitDelayBlocks(F_1);

        emit log_named_uint("0.005% -> blocks", d005);
        emit log_named_uint("0.05%  -> blocks", d0050);
        emit log_named_uint("0.25%  -> blocks", d025);
        emit log_named_uint("1%     -> blocks", d1);

        assertGe(d005, 150, "floor: at least 150 blocks");
        assertLt(d005, d0050, "0.05% must wait longer than 0.005%");
        assertLt(d0050, d025, "0.25% must wait longer than 0.05%");
        assertLt(d025, d1, "1% must wait longer than 0.25%");
        assertLe(d1, 200_000, "cap: at most a day of blocks");
    }

    /// Ни один тир не должен рождаться с выключенной защитой.
    function test_jitDelay_neverZeroByDefault() public {
        SementsulV3Factory f = _factory();
        for (uint256 i = 0; i < 4; i++) {
            assertGt(f.jitDelayBlocks(fees[i]), 0, "protection must be on by default");
        }
    }

    /// Конструктор отвергает пустой список, дубли и рассинхрон длин.
    function test_constructor_validation() public {
        uint24[] memory empty = new uint24[](0);
        int24[] memory emptySp = new int24[](0);
        vm.expectRevert("Sementsul: TIER_COUNT");
        new SementsulV3Factory(empty, emptySp, address(this));

        uint24[] memory dup = new uint24[](2);
        dup[0] = F_0050;
        dup[1] = F_0050;
        int24[] memory two = new int24[](2);
        two[0] = 10;
        two[1] = 20;
        vm.expectRevert("Sementsul: DUP_FEE");
        new SementsulV3Factory(dup, two, address(this));

        uint24[] memory one = new uint24[](1);
        one[0] = F_0050;
        int24[] memory twoSp = new int24[](2);
        twoSp[0] = 10;
        twoSp[1] = 20;
        vm.expectRevert("Sementsul: TIER_LENGTH");
        new SementsulV3Factory(one, twoSp, address(this));
    }

    /// Пять тиров — больше предела: ликвидность дробится, каждый пул слишком
    /// тонкий. Это осознанное ограничение, а не забытая проверка.
    function test_constructor_rejectsMoreThanFourTiers() public {
        uint24[] memory many = new uint24[](5);
        int24[] memory manySp = new int24[](5);
        for (uint256 i = 0; i < 5; i++) {
            many[i] = uint24(100 * (i + 1));
            manySp[i] = int24(int256(10 * (i + 1)));
        }
        vm.expectRevert("Sementsul: TIER_COUNT");
        new SementsulV3Factory(many, manySp, address(this));
    }

    /// Пулы одного тира на разных парах независимы и не мешают друг другу.
    function test_differentPairs_sameTier() public {
        SementsulV3Factory f = _factory();

        TierToken a = new TierToken();
        TierToken b = new TierToken();
        TierToken c = new TierToken();

        address ab = f.createPool(address(a), address(b), F_0050);
        address ac = f.createPool(address(a), address(c), F_0050);

        assertTrue(ab != ac, "different pairs -> different pools");
        assertEq(f.allPoolsLength(), 2, "both indexed");
        assertTrue(f.isPool(ab) && f.isPool(ac), "both recognised as ours");
    }
}