// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.24;

import './interfaces.sol';
import './SementsulV2.sol';

// Sementsul DEX — https://sementsul.net/
//
// Исходники: https://github.com/sementsul/sementsul-dex
//
// SementsulRouter — точка входа для пользователя.
//
// Роутер не хранит средства и не имеет владельца: всё, что он делает, —
// перекладывает токены между кошельком и пулом в правильном порядке и
// проверяет, что на выходе получено не меньше обещанного.
//
// Отличие от PancakeRouter принципиальное по смыслу: он работает только с
// парами своей фабрики. Адрес пары не берётся из аргументов и не запрашивается
// у самого пула — он вычисляется через factory.pairFor, поэтому подсунуть
// чужой контракт, притворяющийся пулом, невозможно.
contract SementsulRouter {
    address public immutable factory;
    address public immutable WETH;
    // Комиссия протокола не взимается: у пула уже есть своя, и вторая
    // сделала бы обмен дороже Pancake, ради чего всё и затевалось.
    uint256 public constant FEE_DENOMINATOR = 1e6;

    modifier ensure(uint256 deadline) {
        require(deadline >= block.timestamp, 'Sementsul: EXPIRED');
        _;
    }

    constructor(address _factory, address _WETH) {
        require(_factory != address(0) && _WETH != address(0), 'Sementsul: ZERO_ADDRESS');
        factory = _factory;
        WETH = _WETH;
    }

    receive() external payable {
        // Принимаем BNB только от WBNB при снятии обёртки.
        require(msg.sender == WETH, 'Sementsul: NOT_WETH');
    }

    // ---------- ликвидность ----------

    /// @notice Добавить ликвидность с автоматическим приведением пропорции.
    /// Если пара новая, используется amountADesired/amountBDesired как есть.
    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        (amountA, amountB) = _addLiquidity(
            tokenA, tokenB, amountADesired, amountBDesired, amountAMin, amountBMin
        );
        address pair = ISementsulFactory(factory).pairFor(tokenA, tokenB);
        _safeTransferFrom(tokenA, msg.sender, pair, amountA);
        _safeTransferFrom(tokenB, msg.sender, pair, amountB);
        liquidity = ISementsulPair(pair).mint(to);
    }

    /// @notice Добавить ликвидность BNB + токен.
    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable ensure(deadline) returns (uint256 amountToken, uint256 amountETH, uint256 liquidity) {
        (amountToken, amountETH) = _addLiquidity(
            token, WETH, amountTokenDesired, msg.value, amountTokenMin, amountETHMin
        );
        address pair = ISementsulFactory(factory).pairFor(token, WETH);
        _safeTransferFrom(token, msg.sender, pair, amountToken);
        IWBNB(WETH).deposit{value: amountETH}();
        require(IWBNB(WETH).transfer(pair, amountETH), 'Sementsul: WETH_TRANSFER');
        liquidity = ISementsulPair(pair).mint(to);

        // Неиспользованный BNB возвращаем: пропорция могла оказаться иной.
        if (msg.value > amountETH) _safeTransferETH(msg.sender, msg.value - amountETH);
    }

    /// @notice Забрать ликвидность. LP-токены переводятся на пару, затем
    /// сжигаются — иначе пул не знает, какую долю вы выводите.
    function removeLiquidity(
        address tokenA,
        address tokenB,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) public ensure(deadline) returns (uint256 amountA, uint256 amountB) {
        address pair = ISementsulFactory(factory).pairFor(tokenA, tokenB);
        ISementsulPair(pair).transferFrom(msg.sender, pair, liquidity);
        (uint256 amount0, uint256 amount1) = ISementsulPair(pair).burn(to);
        (address token0, ) = _sortTokens(tokenA, tokenB);
        (amountA, amountB) = tokenA == token0 ? (amount0, amount1) : (amount1, amount0);
        require(amountA >= amountAMin, 'Sementsul: INSUFFICIENT_A_AMOUNT');
        require(amountB >= amountBMin, 'Sementsul: INSUFFICIENT_B_AMOUNT');
    }

    function removeLiquidityETH(
        address token,
        uint256 liquidity,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256 amountToken, uint256 amountETH) {
        (amountToken, amountETH) = removeLiquidity(
            token, WETH, liquidity, amountTokenMin, amountETHMin, address(this), deadline
        );
        _safeTransfer(token, to, amountToken);
        IWBNB(WETH).withdraw(amountETH);
        _safeTransferETH(to, amountETH);
    }

    // ---------- обмен ----------

    /// @notice Обмен точного входа: пользователь называет сумму, которую
    /// отдаёт, и минимум на выходе. Проскальзывание защищено amountOutMin.
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256[] memory amounts) {
        amounts = getAmountsOut(amountIn, path);
        require(amounts[amounts.length - 1] >= amountOutMin, 'Sementsul: INSUFFICIENT_OUTPUT_AMOUNT');
        _safeTransferFrom(path[0], msg.sender, ISementsulFactory(factory).pairFor(path[0], path[1]), amounts[0]);
        _swap(amounts, path, to);
    }

    /// @notice Обмен с оплатой в BNB.
    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable ensure(deadline) returns (uint256[] memory amounts) {
        require(path[0] == WETH, 'Sementsul: INVALID_PATH');
        amounts = getAmountsOut(msg.value, path);
        require(amounts[amounts.length - 1] >= amountOutMin, 'Sementsul: INSUFFICIENT_OUTPUT_AMOUNT');
        IWBNB(WETH).deposit{value: amounts[0]}();
        require(IWBNB(WETH).transfer(ISementsulFactory(factory).pairFor(path[0], path[1]), amounts[0]), 'Sementsul: WETH_TRANSFER');
        _swap(amounts, path, to);
    }

    /// @notice Обмен токенов на BNB.
    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256[] memory amounts) {
        require(path[path.length - 1] == WETH, 'Sementsul: INVALID_PATH');
        amounts = getAmountsOut(amountIn, path);
        require(amounts[amounts.length - 1] >= amountOutMin, 'Sementsul: INSUFFICIENT_OUTPUT_AMOUNT');
        _safeTransferFrom(path[0], msg.sender, ISementsulFactory(factory).pairFor(path[0], path[1]), amounts[0]);
        _swap(amounts, path, address(this));
        IWBNB(WETH).withdraw(amounts[amounts.length - 1]);
        _safeTransferETH(to, amounts[amounts.length - 1]);
    }

    // ---------- расчёт ----------

    /// @notice Выход для точного входа по всему маршруту.
    /// Формула совпадает с той, что применяет пул: если они разойдутся,
    /// обмен упадёт на проверке K, поэтому здесь нет «примерной» оценки.
    function getAmountsOut(uint256 amountIn, address[] memory path)
        public
        view
        returns (uint256[] memory amounts)
    {
        require(path.length >= 2, 'Sementsul: INVALID_PATH');
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        for (uint256 i; i < path.length - 1; i++) {
            (uint256 reserveIn, uint256 reserveOut) = _getReserves(path[i], path[i + 1]);
            amounts[i + 1] = _getAmountOut(amounts[i], reserveIn, reserveOut, _feeOf(path[i], path[i + 1]));
        }
    }

    /// @notice Вход, необходимый для точного выхода.
    function getAmountsIn(uint256 amountOut, address[] memory path)
        public
        view
        returns (uint256[] memory amounts)
    {
        require(path.length >= 2, 'Sementsul: INVALID_PATH');
        amounts = new uint256[](path.length);
        amounts[amounts.length - 1] = amountOut;
        for (uint256 i = path.length - 1; i > 0; i--) {
            (uint256 reserveIn, uint256 reserveOut) = _getReserves(path[i - 1], path[i]);
            amounts[i - 1] = _getAmountIn(amounts[i], reserveIn, reserveOut, _feeOf(path[i - 1], path[i]));
        }
    }

    function _getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut, uint24 fee)
        internal
        pure
        returns (uint256)
    {
        require(amountIn > 0, 'Sementsul: INSUFFICIENT_INPUT_AMOUNT');
        require(reserveIn > 0 && reserveOut > 0, 'Sementsul: INSUFFICIENT_LIQUIDITY');
        uint256 feeFactor = FEE_DENOMINATOR - fee;
        uint256 amountInWithFee = amountIn * feeFactor;
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = reserveIn * FEE_DENOMINATOR + amountInWithFee;
        return numerator / denominator;
    }

    function _getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut, uint24 fee)
        internal
        pure
        returns (uint256)
    {
        require(amountOut > 0, 'Sementsul: INSUFFICIENT_OUTPUT_AMOUNT');
        require(reserveIn > 0 && reserveOut > 0, 'Sementsul: INSUFFICIENT_LIQUIDITY');
        require(amountOut < reserveOut, 'Sementsul: INSUFFICIENT_LIQUIDITY');
        uint256 feeFactor = FEE_DENOMINATOR - fee;
        uint256 numerator = reserveIn * amountOut * FEE_DENOMINATOR;
        uint256 denominator = (reserveOut - amountOut) * feeFactor;
        return numerator / denominator + 1;
    }

    function _getReserves(address tokenA, address tokenB)
        internal
        view
        returns (uint256 reserveA, uint256 reserveB)
    {
        address pair = ISementsulFactory(factory).pairFor(tokenA, tokenB);
        require(pair.code.length > 0, 'Sementsul: PAIR_NOT_FOUND');
        (uint256 reserve0, uint256 reserve1, ) = ISementsulPair(pair).getReserves();
        (address token0, ) = _sortTokens(tokenA, tokenB);
        (reserveA, reserveB) = tokenA == token0 ? (reserve0, reserve1) : (reserve1, reserve0);
    }

    function _feeOf(address tokenA, address tokenB) internal view returns (uint24) {
        address pair = ISementsulFactory(factory).pairFor(tokenA, tokenB);
        return ISementsulPair(pair).fee();
    }

    function _addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin
    ) internal returns (uint256 amountA, uint256 amountB) {
        address pair = ISementsulFactory(factory).pairFor(tokenA, tokenB);
        if (pair.code.length == 0) {
            // Пары ещё нет — создаём. Так первый поставщик не обязан
            // отдельно вызывать фабрику.
            pair = ISementsulFactory(factory).createPair(tokenA, tokenB);
            return (amountADesired, amountBDesired);
        }
        (uint256 reserveA, uint256 reserveB) = _getReserves(tokenA, tokenB);
        if (reserveA == 0 && reserveB == 0) {
            return (amountADesired, amountBDesired);
        }
        uint256 amountBOptimal = _quote(amountADesired, reserveA, reserveB);
        if (amountBOptimal <= amountBDesired) {
            require(amountBOptimal >= amountBMin, 'Sementsul: INSUFFICIENT_B_AMOUNT');
            return (amountADesired, amountBOptimal);
        }
        uint256 amountAOptimal = _quote(amountBDesired, reserveB, reserveA);
        require(amountAOptimal <= amountADesired, 'Sementsul: EXCESSIVE_A_AMOUNT');
        require(amountAOptimal >= amountAMin, 'Sementsul: INSUFFICIENT_A_AMOUNT');
        return (amountAOptimal, amountBDesired);
    }

    function _quote(uint256 amountA, uint256 reserveA, uint256 reserveB) internal pure returns (uint256) {
        require(amountA > 0, 'Sementsul: INSUFFICIENT_AMOUNT');
        require(reserveA > 0 && reserveB > 0, 'Sementsul: INSUFFICIENT_LIQUIDITY');
        return (amountA * reserveB) / reserveA;
    }

    /// @notice Проводит обмен по маршруту. Вход уже переведён на первую пару,
    /// поэтому здесь только последовательные swap: каждая следующая пара
    /// получает выход предыдущей.
    function _swap(uint256[] memory amounts, address[] memory path, address _to) internal {
        for (uint256 i; i < path.length - 1; i++) {
            (address input, address output) = (path[i], path[i + 1]);
            (address token0, ) = _sortTokens(input, output);
            uint256 amountOut = amounts[i + 1];
            (uint256 amount0Out, uint256 amount1Out) =
                input == token0 ? (uint256(0), amountOut) : (amountOut, uint256(0));
            address to = i < path.length - 2
                ? ISementsulFactory(factory).pairFor(output, path[i + 2])
                : _to;
            ISementsulPair(ISementsulFactory(factory).pairFor(input, output)).swap(amount0Out, amount1Out, to);
        }
    }

    function _sortTokens(address tokenA, address tokenB) internal pure returns (address, address) {
        require(tokenA != tokenB, 'Sementsul: IDENTICAL_ADDRESSES');
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), 'Sementsul: ZERO_ADDRESS');
        return (token0, token1);
    }

    function _safeTransfer(address token, address to, uint256 value) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, value));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), 'Sementsul: TRANSFER_FAILED');
    }

    function _safeTransferFrom(address token, address from, address to, uint256 value) internal {
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(0x23b872dd, from, to, value));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), 'Sementsul: TRANSFER_FROM_FAILED');
    }

    function _safeTransferETH(address to, uint256 value) internal {
        (bool ok, ) = to.call{value: value}('');
        require(ok, 'Sementsul: ETH_TRANSFER_FAILED');
    }
}

