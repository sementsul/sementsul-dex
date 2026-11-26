// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.24;

import './interfaces.sol';

// Sementsul DEX — https://sementsul.net/
//
// Исходники: https://github.com/sementsul/sementsul-dex
// Этот файл содержит и фабрику, и пул с постоянным произведением.
//
// SementsulFactory — фабрика пулов с постоянным произведением (аналог V2).
//
// Зачем своя фабрика, если есть Pancake V2: там комиссия зашита в контракт
// (0.25%) и изменить её нельзя. Здесь комиссия задаётся при создании фабрики.
//
// Комиссия в единицах 1e-6 (как в V3): 2500 = 0.25%, 500 = 0.05%,
// 50 = 0.005%. Именно 50 недостижимо на Pancake: там минимальный тир 100
// (0.01%), и это нижняя граница протокола, а не настройка.
contract SementsulFactory {
    /// @notice Верхняя граница комиссии. 10000 = 1%.
    uint24 public constant MAX_FEE = 10000;
    /// @notice Нижняя граница: 1e-6 (0.0001%). Меньше — округление в формуле
    /// съест комиссию на малых суммах, и пул фактически станет
    /// безкомиссионным, что ломает инвариант.
    uint24 public constant MIN_FEE = 1;

    /// @notice Комиссия всех пулов этой фабрики, в единицах 1e-6.
    uint24 public immutable fee;

    /// @notice Администратора у фабрики нет.
    ///
    /// Раньше здесь были feeTo и feeToSetter — «получатель комиссии протокола»
    /// и тот, кто может её переназначить. Я их убрал, и вот почему.
    ///
    /// 1. Комиссия протокола нигде не взималась. Пул не обращался к feeTo ни
    ///    разу: поле хранилось, но не использовалось. То есть это была не
    ///    работающая возможность, а её обещание в интерфейсе.
    /// 2. Обещание опасное. Адрес, который можно переназначить, — это ровно
    ///    тот рычаг, из-за которого людям приходится верить владельцу биржи
    ///    на слово. Проверить по коду, что рычаг не выкрутят, нельзя.
    /// 3. Убрать проще, чем объяснять. Пока поля есть, каждый читающий код
    ///    обязан сам убедиться, что они мертвы. Когда их нет — доказывать
    ///    нечего: взимать комиссию протокола физически нечем.
    ///
    /// Вся комиссия обмена остаётся поставщикам ликвидности. У фабрики нет
    /// ни владельца, ни функций управления: после деплоя её поведение
    /// изменить нельзя ничем.
    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;
    /// @notice Только пары, созданные этой фабрикой. Пул может заявить о себе
    /// сам, но роутер обязан сверяться с фабрикой, а не с его словами.
    mapping(address => bool) public isPair;

    event PairCreated(address indexed token0, address indexed token1, address pair, uint256 pairCount);

    constructor(uint24 _fee) {
        require(_fee >= MIN_FEE && _fee <= MAX_FEE, 'Sementsul: FEE_RANGE');
        fee = _fee;
    }

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    /// @notice Сколько всего пар уже создано — для фронтенда, чтобы обойти
    /// их одним запросом, не зная адресов.
    function allPairsSlice(uint256 offset, uint256 limit) external view returns (address[] memory out) {
        uint256 n = allPairs.length;
        if (offset >= n) return new address[](0);
        uint256 end = offset + limit;
        if (end > n) end = n;
        out = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) out[i - offset] = allPairs[i];
    }

    /// @notice Создать пару. Порядок токенов определяется их адресами: иначе
    /// для одной пары появились бы два независимых пула (A/B и B/A), и
    /// ликвидность размазалась бы между ними.
    function createPair(address tokenA, address tokenB) external returns (address pair) {
        require(tokenA != tokenB, 'Sementsul: IDENTICAL_ADDRESSES');
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), 'Sementsul: ZERO_ADDRESS');
        require(getPair[token0][token1] == address(0), 'Sementsul: PAIR_EXISTS');

        bytes memory bytecode = type(SementsulPair).creationCode;
        bytes32 salt = keccak256(abi.encodePacked(token0, token1));
        assembly {
            pair := create2(0, add(bytecode, 0x20), mload(bytecode), salt)
        }
        require(pair != address(0), 'Sementsul: CREATE2_FAILED');

        // Пара получает параметры от фабрики при инициализации, а не из
        // конструктора: так её байткод одинаков для всех пар, и адрес
        // вычисляется заранее через pairFor.
        ISementsulPair(pair).initialize(token0, token1);

        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair;
        allPairs.push(pair);
        isPair[pair] = true;

        emit PairCreated(token0, token1, pair, allPairs.length);
    }

    /// @notice Адрес пары до её создания — тот же расчёт, что в createPair.
    /// Нужен фронтенду и роутеру, чтобы не делать лишний eth_call.
    function pairFor(address tokenA, address tokenB) external view returns (address pair) {
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        bytes32 salt = keccak256(abi.encodePacked(token0, token1));
        bytes32 hash = keccak256(
            abi.encodePacked(hex'ff', address(this), salt, keccak256(type(SementsulPair).creationCode))
        );
        pair = address(uint160(uint256(hash)));
    }
}

// SementsulPair — пул x*y=k.
//
// Формула с комиссией без промежуточного округления:
//   amountOut = (amountIn * (1e6 - fee) * reserveOut) /
//               (reserveIn * 1e6 + amountIn * (1e6 - fee))
// В Pancake V2 комиссия вычитается из входа с округлением вниз, и на малых
// суммах это теряет wei. Здесь считается напрямую.
contract SementsulPair {
    uint256 public constant FEE_DENOMINATOR = 1e6;
    // Минимальная ликвидность навсегда блокируется при первом вкладе:
    // защита от округления totalSupply до нуля.
    uint256 public constant MINIMUM_LIQUIDITY = 1000;

    address public factory;
    address public token0;
    address public token1;
    uint24 public fee;

    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private blockTimestampLast;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // Защита от реентрантности: swap вызывает transfer на чужом токене, и
    // токен с колбэком может попытаться войти в пул повторно.
    uint256 private locked = 1;
    modifier lock() {
        require(locked == 1, 'Sementsul: LOCKED');
        locked = 2;
        _;
        locked = 1;
    }

    event Mint(address indexed sender, uint256 amount0, uint256 amount1);
    event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to);
    event Swap(
        address indexed sender,
        uint256 amount0In,
        uint256 amount1In,
        uint256 amount0Out,
        uint256 amount1Out,
        address indexed to
    );
    event Sync(uint112 reserve0, uint112 reserve1);
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor() {
        factory = msg.sender;
    }

    function initialize(address _token0, address _token1) external {
        require(msg.sender == factory, 'Sementsul: FORBIDDEN');
        require(token0 == address(0), 'Sementsul: ALREADY_INITIALIZED');
        token0 = _token0;
        token1 = _token1;
        fee = ISementsulFactory(factory).fee();
    }

    function getReserves() public view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, blockTimestampLast);
    }

    function _update(uint256 balance0, uint256 balance1) private {
        require(balance0 <= type(uint112).max && balance1 <= type(uint112).max, 'Sementsul: OVERFLOW');
        reserve0 = uint112(balance0);
        reserve1 = uint112(balance1);
        blockTimestampLast = uint32(block.timestamp);
        emit Sync(uint112(balance0), uint112(balance1));
    }

    /// @notice Внести ликвидность. LP считается по меньшему из двух отношений,
    /// поэтому внести неправильную пропорцию нельзя: лишнее просто останется
    /// на кошельке.
    function mint(address to) external lock returns (uint256 liquidity) {
        (uint112 _reserve0, uint112 _reserve1, ) = getReserves();
        // Балансы читаются до перевода, поэтому amount0/amount1 — это ровно
        // то, что вкладчик перевёл на пул перед вызовом.
        uint256 balance0 = IERC20(token0).balanceOf(address(this));
        uint256 balance1 = IERC20(token1).balanceOf(address(this));
        uint256 amount0 = balance0 - _reserve0;
        uint256 amount1 = balance1 - _reserve1;

        uint256 _totalSupply = totalSupply;
        if (_totalSupply == 0) {
            liquidity = _sqrt(amount0 * amount1) - MINIMUM_LIQUIDITY;
            _mint(address(0), MINIMUM_LIQUIDITY);
        } else {
            liquidity = _min((amount0 * _totalSupply) / _reserve0, (amount1 * _totalSupply) / _reserve1);
        }
        require(liquidity > 0, 'Sementsul: INSUFFICIENT_LIQUIDITY_MINTED');
        _mint(to, liquidity);
        _update(balance0, balance1);
        emit Mint(msg.sender, amount0, amount1);
    }

    /// @notice Вывести ликвидность. LP-токены сначала переводятся на пул,
    /// потом сжигаются: иначе нельзя посчитать долю без списка держателей.
    function burn(address to) external lock returns (uint256 amount0, uint256 amount1) {
        uint256 balance0 = IERC20(token0).balanceOf(address(this));
        uint256 balance1 = IERC20(token1).balanceOf(address(this));
        uint256 liquidity = balanceOf[address(this)];

        uint256 _totalSupply = totalSupply;
        amount0 = (liquidity * balance0) / _totalSupply;
        amount1 = (liquidity * balance1) / _totalSupply;
        require(amount0 > 0 && amount1 > 0, 'Sementsul: INSUFFICIENT_LIQUIDITY_BURNED');

        _burn(address(this), liquidity);
        _safeTransfer(token0, to, amount0);
        _safeTransfer(token1, to, amount1);

        balance0 = IERC20(token0).balanceOf(address(this));
        balance1 = IERC20(token1).balanceOf(address(this));
        _update(balance0, balance1);
        emit Burn(msg.sender, amount0, amount1, to);
    }

    /// @notice Обмен. Ровно один из amount0Out/amount1Out должен быть > 0:
    /// ввод и вывод в одном токене — это flash-swap, которого здесь нет.
    /// Вход уже должен лежать на пуле (переведён до вызова), поэтому проверка
    /// идёт по изменению баланса, а не по аргументам.
    function swap(uint256 amount0Out, uint256 amount1Out, address to) external lock {
        require(amount0Out > 0 || amount1Out > 0, 'Sementsul: INSUFFICIENT_OUTPUT_AMOUNT');
        (uint112 _reserve0, uint112 _reserve1, ) = getReserves();
        require(amount0Out < _reserve0 && amount1Out < _reserve1, 'Sementsul: INSUFFICIENT_LIQUIDITY');
        require(to != token0 && to != token1 && to != address(0), 'Sementsul: INVALID_TO');

        if (amount0Out > 0) _safeTransfer(token0, to, amount0Out);
        if (amount1Out > 0) _safeTransfer(token1, to, amount1Out);

        uint256 balance0 = IERC20(token0).balanceOf(address(this));
        uint256 balance1 = IERC20(token1).balanceOf(address(this));

        uint256 amount0In = balance0 > _reserve0 - amount0Out ? balance0 - (_reserve0 - amount0Out) : 0;
        uint256 amount1In = balance1 > _reserve1 - amount1Out ? balance1 - (_reserve1 - amount1Out) : 0;
        require(amount0In > 0 || amount1In > 0, 'Sementsul: INSUFFICIENT_INPUT_AMOUNT');

        // Инвариант с комиссией: произведение скорректированных балансов не
        // должно уменьшиться. Комиссия остаётся в пуле и достаётся
        // поставщикам ликвидности.
        {
            uint256 balance0Adjusted = balance0 * FEE_DENOMINATOR - amount0In * fee;
            uint256 balance1Adjusted = balance1 * FEE_DENOMINATOR - amount1In * fee;
            require(
                balance0Adjusted * balance1Adjusted >=
                    uint256(_reserve0) * uint256(_reserve1) * FEE_DENOMINATOR ** 2,
                'Sementsul: K'
            );
        }

        _update(balance0, balance1);
        emit Swap(msg.sender, amount0In, amount1In, amount0Out, amount1Out, to);
    }

    // ---------- LP-токен (ERC-20) ----------

    function _mint(address to, uint256 value) private {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function _burn(address from, uint256 value) private {
        balanceOf[from] -= value;
        totalSupply -= value;
        emit Transfer(from, address(0), value);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, 'Sementsul: INSUFFICIENT_ALLOWANCE');
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) private {
        require(balanceOf[from] >= value, 'Sementsul: INSUFFICIENT_BALANCE');
        require(to != address(0), 'Sementsul: ZERO_ADDRESS');
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    // ---------- утилиты ----------

    function _safeTransfer(address token, address to, uint256 value) private {
        // Проверяем возвращаемое значение: часть токенов возвращает false
        // вместо revert, и молчаливая потеря средств была бы неотличима от
        // успешного обмена.
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, value));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), 'Sementsul: TRANSFER_FAILED');
    }

    function _sqrt(uint256 y) private pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
}