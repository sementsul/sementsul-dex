// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.24;

// Математика концентрированной ликвидности (аналог V3).
//
// Цена хранится как sqrtPriceX96: квадратный корень из отношения цен, умноженный
// на 2^96. Так сделано в Uniswap V3, и это не произвол: произведение
// amount * sqrtPrice укладывается в 256 бит там, где amount * price уже
// переполняет, а деление на цену заменяется умножением на обратный корень.
//
// Тики — это log(price) с основанием 1.0001. Шаг 1.0001 выбран так, чтобы
// изменение цены на 1 тик было чуть больше шага цены минимальной единицы
// токена с 18 decimals, и чтобы сумма комиссий за проход всего диапазона
// оставалась в разумных пределах.

library FullMath {
    /// @notice mulDiv с полной 512-битной промежуточной точностью.
    /// Обычное a*b/c переполняется, когда a*b больше 2^256, а именно это и
    /// происходит при расчёте ликвидности по цене.
    function mulDiv(uint256 a, uint256 b, uint256 denominator) internal pure returns (uint256 result) {
        unchecked {
            uint256 prod0;
            uint256 prod1;
            assembly {
                let mm := mulmod(a, b, not(0))
                prod0 := mul(a, b)
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }

            if (prod1 == 0) {
                require(denominator > 0, 'Sementsul: DIV_ZERO');
                assembly {
                    result := div(prod0, denominator)
                }
                return result;
            }

            require(denominator > prod1, 'Sementsul: MULDIV_OVERFLOW');

            uint256 remainder;
            assembly {
                remainder := mulmod(a, b, denominator)
                prod1 := sub(prod1, gt(remainder, prod0))
                prod0 := sub(prod0, remainder)
            }

            // Убираем общие множители двойки, чтобы не потерять точность
            // на сдвиге.
            uint256 twos = denominator & (~denominator + 1);
            assembly {
                denominator := div(denominator, twos)
                prod0 := div(prod0, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }

            prod0 |= prod1 * twos;

            // Обратный элемент по модулю 2^256 методом Ньютона: 6 итераций
            // дают точность 2^192, чего хватает для 256-битного деления.
            uint256 inv = (3 * denominator) ^ 2;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;

            result = prod0 * inv;
            return result;
        }
    }

    function mulDivRoundingUp(uint256 a, uint256 b, uint256 denominator) internal pure returns (uint256 result) {
        result = mulDiv(a, b, denominator);
        unchecked {
            if (mulmod(a, b, denominator) > 0) {
                require(result < type(uint256).max, 'Sementsul: MULDIV_UP_OVERFLOW');
                result++;
            }
        }
    }
}

library TickMath {
    /// @notice Минимальный и максимальный тик. При шаге 1.0001 это диапазон
    /// цен примерно от 2^-128 до 2^128, что покрывает любую реальную пару.
    int24 internal constant MIN_TICK = -887272;
    int24 internal constant MAX_TICK = -MIN_TICK;

    /// @notice Границы sqrtPriceX96, соответствующие MIN_TICK и MAX_TICK.
    /// За них цена выйти не может: при выходе округление теряет точность.
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    /// @notice sqrt(1.0001^tick) * 2^96.
    /// Вычисляется произведением предрассчитанных констант: каждая отвечает
    /// одному установленному биту тика, поэтому циклов нет и результат
    /// детерминирован.
    function getSqrtRatioAtTick(int24 tick) internal pure returns (uint160 sqrtPriceX96) {
        uint256 absTick = tick < 0 ? uint256(uint24(-tick)) : uint256(uint24(tick));
        require(absTick <= uint256(int256(MAX_TICK)), 'Sementsul: TICK_OUT_OF_BOUNDS');

        uint256 ratio = absTick & 0x1 != 0
            ? 0xfffcb933bd6fad37aa2d162d1a594001
            : 0x100000000000000000000000000000000;
        if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
        if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
        if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
        if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
        if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
        if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
        if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
        if (absTick & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
        if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
        if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
        if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
        if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
        if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
        if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
        if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
        if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
        if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
        if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
        if (absTick & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;

        // Для положительных тиков отношение перевёрнуто: 1/ratio.
        if (tick > 0) ratio = type(uint256).max / ratio;

        sqrtPriceX96 = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
    }

    /// @notice Наибольший тик, у которого sqrtRatio не больше заданного:
    /// обратная функция к getSqrtRatioAtTick.
    /// Через log2: сначала находим позицию старшего бита, затем уточняем
    /// оставшиеся 14 бит по одному.
    function getTickAtSqrtRatio(uint160 sqrtPriceX96) internal pure returns (int24 tick) {
        require(
            sqrtPriceX96 >= MIN_SQRT_RATIO && sqrtPriceX96 < MAX_SQRT_RATIO,
            'Sementsul: SQRT_RATIO_OUT_OF_BOUNDS'
        );

        uint256 ratio = uint256(sqrtPriceX96) << 32;

        uint256 r = ratio;
        uint256 msb = 0;

        assembly {
            let f := shl(7, gt(r, 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF))
            msb := or(msb, f)
            r := shr(f, r)
        }
        assembly {
            let f := shl(6, gt(r, 0xFFFFFFFFFFFFFFFF))
            msb := or(msb, f)
            r := shr(f, r)
        }
        assembly {
            let f := shl(5, gt(r, 0xFFFFFFFF))
            msb := or(msb, f)
            r := shr(f, r)
        }
        assembly {
            let f := shl(4, gt(r, 0xFFFF))
            msb := or(msb, f)
            r := shr(f, r)
        }
        assembly {
            let f := shl(3, gt(r, 0xFF))
            msb := or(msb, f)
            r := shr(f, r)
        }
        assembly {
            let f := shl(2, gt(r, 0xF))
            msb := or(msb, f)
            r := shr(f, r)
        }
        assembly {
            let f := shl(1, gt(r, 0x3))
            msb := or(msb, f)
            r := shr(f, r)
        }
        assembly {
            let f := gt(r, 0x1)
            msb := or(msb, f)
        }

        if (msb >= 128) r = ratio >> (msb - 127);
        else r = ratio << (127 - msb);

        int256 log_2 = (int256(msb) - 128) << 64;

        assembly {
            r := shr(127, mul(r, r))
            let f := shr(128, r)
            log_2 := or(log_2, shl(63, f))
            r := shr(f, r)
        }
        assembly {
            r := shr(127, mul(r, r))
            let f := shr(128, r)
            log_2 := or(log_2, shl(62, f))
            r := shr(f, r)
        }
        assembly {
            r := shr(127, mul(r, r))
            let f := shr(128, r)
            log_2 := or(log_2, shl(61, f))
            r := shr(f, r)
        }
        assembly {
            r := shr(127, mul(r, r))
            let f := shr(128, r)
            log_2 := or(log_2, shl(60, f))
            r := shr(f, r)
        }
        assembly {
            r := shr(127, mul(r, r))
            let f := shr(128, r)
            log_2 := or(log_2, shl(59, f))
            r := shr(f, r)
        }
        assembly {
            r := shr(127, mul(r, r))
            let f := shr(128, r)
            log_2 := or(log_2, shl(58, f))
            r := shr(f, r)
        }
        assembly {
            r := shr(127, mul(r, r))
            let f := shr(128, r)
            log_2 := or(log_2, shl(57, f))
            r := shr(f, r)
        }
        assembly {
            r := shr(127, mul(r, r))
            let f := shr(128, r)
            log_2 := or(log_2, shl(56, f))
            r := shr(f, r)
        }
        assembly {
            r := shr(127, mul(r, r))
            let f := shr(128, r)
            log_2 := or(log_2, shl(55, f))
            r := shr(f, r)
        }
        assembly {
            r := shr(127, mul(r, r))
            let f := shr(128, r)
            log_2 := or(log_2, shl(54, f))
            r := shr(f, r)
        }
        assembly {
            r := shr(127, mul(r, r))
            let f := shr(128, r)
            log_2 := or(log_2, shl(53, f))
            r := shr(f, r)
        }
        assembly {
            r := shr(127, mul(r, r))
            let f := shr(128, r)
            log_2 := or(log_2, shl(52, f))
            r := shr(f, r)
        }
        assembly {
            r := shr(127, mul(r, r))
            let f := shr(128, r)
            log_2 := or(log_2, shl(51, f))
            r := shr(f, r)
        }
        assembly {
            r := shr(127, mul(r, r))
            let f := shr(128, r)
            log_2 := or(log_2, shl(50, f))
        }

        // log_2 посчитан в формате с фиксированной точкой 2^64.
        // Переводим в тики: tick = log_2 * 2^64 / log2(1.0001)
        int256 log_sqrt10001 = log_2 * 255738958999603826347141;

        int24 tickLow = int24((log_sqrt10001 - 3402992956809132418596140100660247210) >> 128);
        int24 tickHi = int24((log_sqrt10001 + 291339464771989622907027621153398088495) >> 128);

        // Границы гарантируют, что настоящий тик лежит между tickLow и tickHi,
        // и одна проверка отношения снимает неоднозначность.
        tick = tickLow == tickHi
            ? tickLow
            : getSqrtRatioAtTick(tickHi) <= sqrtPriceX96
                ? tickHi
                : tickLow;
    }
}

library SqrtPriceMath {
    /// @notice Сколько token0 нужно, чтобы сдвинуть цену от current к target
    /// (цена растёт, то есть покупаем token0).
    function getAmount0Delta(uint160 sqrtRatioAX96, uint160 sqrtRatioBX96, uint128 liquidity, bool roundUp)
        internal
        pure
        returns (uint256 amount0)
    {
        if (sqrtRatioAX96 > sqrtRatioBX96) {
            (sqrtRatioAX96, sqrtRatioBX96) = (sqrtRatioBX96, sqrtRatioAX96);
        }
        uint256 numerator1 = uint256(liquidity) << 96;
        uint256 numerator2 = sqrtRatioBX96 - sqrtRatioAX96;

        return
            roundUp
                ? FullMath.mulDivRoundingUp(
                    FullMath.mulDivRoundingUp(numerator1, numerator2, sqrtRatioBX96),
                    1,
                    sqrtRatioAX96
                )
                : FullMath.mulDiv(numerator1, numerator2, sqrtRatioBX96) / sqrtRatioAX96;
    }

    /// @notice Сколько token1 нужно для сдвига цены — обратная операция.
    function getAmount1Delta(uint160 sqrtRatioAX96, uint160 sqrtRatioBX96, uint128 liquidity, bool roundUp)
        internal
        pure
        returns (uint256 amount1)
    {
        if (sqrtRatioAX96 > sqrtRatioBX96) {
            (sqrtRatioAX96, sqrtRatioBX96) = (sqrtRatioBX96, sqrtRatioAX96);
        }
        return
            roundUp
                ? FullMath.mulDivRoundingUp(liquidity, sqrtRatioBX96 - sqrtRatioAX96, 0x1000000000000000000000000)
                : FullMath.mulDiv(liquidity, sqrtRatioBX96 - sqrtRatioAX96, 0x1000000000000000000000000);
    }

    /// @notice Новая цена после ввода amount token0.
    /// Прибавляем к обратной цене: ликвидность константна, поэтому
    /// 1/sqrt(P) растёт линейно по amount.
    function getNextSqrtPriceFromAmount0RoundingUp(
        uint160 sqrtPX96,
        uint128 liquidity,
        uint256 amount,
        bool add
    ) internal pure returns (uint160) {
        if (amount == 0) return sqrtPX96;
        uint256 numerator1 = uint256(liquidity) << 96;

        if (add) {
            uint256 product;
            if ((product = amount * sqrtPX96) / amount == sqrtPX96) {
                uint256 denominator = numerator1 + product;
                if (denominator >= numerator1) {
                    return uint160(FullMath.mulDivRoundingUp(numerator1, sqrtPX96, denominator));
                }
            }
            return uint160(FullMath.mulDivRoundingUp(numerator1, 1, numerator1 / sqrtPX96 + amount));
        } else {
            uint256 product;
            require((product = amount * sqrtPX96) / amount == sqrtPX96 && numerator1 > product, 'Sementsul: SUB_UNDERFLOW');
            uint256 denominator = numerator1 - product;
            return uint160(FullMath.mulDivRoundingUp(numerator1, sqrtPX96, denominator));
        }
    }

    /// @notice Новая цена после ввода amount token1. Здесь цена растёт
    /// линейно: P = P0 + amount / L.
    function getNextSqrtPriceFromAmount1RoundingDown(
        uint160 sqrtPX96,
        uint128 liquidity,
        uint256 amount,
        bool add
    ) internal pure returns (uint160) {
        if (add) {
            uint256 quotient = amount <= type(uint160).max
                ? (amount << 96) / liquidity
                : FullMath.mulDiv(amount, 0x1000000000000000000000000, liquidity);
            return uint160(uint256(sqrtPX96) + quotient);
        } else {
            uint256 quotient = amount <= type(uint160).max
                ? FullMath.mulDivRoundingUp(amount, 0x1000000000000000000000000, liquidity)
                : (amount << 96) / liquidity;
            require(sqrtPX96 > quotient, 'Sementsul: SUB_UNDERFLOW');
            return uint160(sqrtPX96 - quotient);
        }
    }

    function getNextSqrtPriceFromInput(
        uint160 sqrtPX96,
        uint128 liquidity,
        uint256 amountIn,
        bool zeroForOne
    ) internal pure returns (uint160 sqrtQX96) {
        require(sqrtPX96 > 0, 'Sementsul: PRICE_ZERO');
        require(liquidity > 0, 'Sementsul: LIQUIDITY_ZERO');
        return
            zeroForOne
                ? getNextSqrtPriceFromAmount0RoundingUp(sqrtPX96, liquidity, amountIn, true)
                : getNextSqrtPriceFromAmount1RoundingDown(sqrtPX96, liquidity, amountIn, true);
    }

    function getNextSqrtPriceFromOutput(
        uint160 sqrtPX96,
        uint128 liquidity,
        uint256 amountOut,
        bool zeroForOne
    ) internal pure returns (uint160 sqrtQX96) {
        require(sqrtPX96 > 0, 'Sementsul: PRICE_ZERO');
        require(liquidity > 0, 'Sementsul: LIQUIDITY_ZERO');
        return
            zeroForOne
                ? getNextSqrtPriceFromAmount1RoundingDown(sqrtPX96, liquidity, amountOut, false)
                : getNextSqrtPriceFromAmount0RoundingUp(sqrtPX96, liquidity, amountOut, false);
    }
}

library SwapMath {
    /// @notice Один шаг обмена внутри диапазона между двумя тиками.
    /// Возвращает новую цену, сколько вошло, сколько вышло и комиссию.
    /// Комиссия берётся с входа, поэтому при точном входе она уменьшает
    /// сумму, реально участвующую в сдвиге цены.
    function computeSwapStep(
        uint160 sqrtRatioCurrentX96,
        uint160 sqrtRatioTargetX96,
        uint128 liquidity,
        int256 amountRemaining,
        uint24 feePips
    ) internal pure returns (uint160 sqrtRatioNextX96, uint256 amountIn, uint256 amountOut, uint256 feeAmount) {
        bool zeroForOne = sqrtRatioCurrentX96 >= sqrtRatioTargetX96;
        bool exactIn = amountRemaining >= 0;

        if (exactIn) {
            uint256 amountRemainingLessFee =
                FullMath.mulDiv(uint256(amountRemaining), 1e6 - feePips, 1e6);
            amountIn = zeroForOne
                ? SqrtPriceMath.getAmount0Delta(sqrtRatioTargetX96, sqrtRatioCurrentX96, liquidity, true)
                : SqrtPriceMath.getAmount1Delta(sqrtRatioCurrentX96, sqrtRatioTargetX96, liquidity, true);

            if (amountRemainingLessFee >= amountIn) {
                sqrtRatioNextX96 = sqrtRatioTargetX96;
            } else {
                sqrtRatioNextX96 = SqrtPriceMath.getNextSqrtPriceFromInput(
                    sqrtRatioCurrentX96,
                    liquidity,
                    amountRemainingLessFee,
                    zeroForOne
                );
            }
        } else {
            amountOut = zeroForOne
                ? SqrtPriceMath.getAmount1Delta(sqrtRatioTargetX96, sqrtRatioCurrentX96, liquidity, false)
                : SqrtPriceMath.getAmount0Delta(sqrtRatioCurrentX96, sqrtRatioTargetX96, liquidity, false);

            if (uint256(-amountRemaining) >= amountOut) {
                sqrtRatioNextX96 = sqrtRatioTargetX96;
            } else {
                sqrtRatioNextX96 = SqrtPriceMath.getNextSqrtPriceFromOutput(
                    sqrtRatioCurrentX96,
                    liquidity,
                    uint256(-amountRemaining),
                    zeroForOne
                );
            }
        }

        bool max = sqrtRatioTargetX96 == sqrtRatioNextX96;

        // Пересчёт величин от фактического сдвига цены.
        //
        // Вход нужен заново, когда цена не упёрлась в границу (там он уже
        // посчитан на весь диапазон) или когда задан точный выход (тогда
        // вход вообще не был известен).
        //
        // Выход пересчитывается всегда: при точном входе он до этого момента
        // не вычислялся вообще, а при точном выходе без достижения границы
        // даёт ровно запрошенную величину с округлением вниз, что и
        // проверяется ниже. Если выход не пересчитать, обмен либо отдаст
        // ноль, забрав токены, либо откатится на проверке OUT_TOO_HIGH.
        if (zeroForOne) {
            if (!max || !exactIn) {
                amountIn = SqrtPriceMath.getAmount0Delta(sqrtRatioNextX96, sqrtRatioCurrentX96, liquidity, true);
            }
            amountOut = SqrtPriceMath.getAmount1Delta(sqrtRatioNextX96, sqrtRatioCurrentX96, liquidity, false);
        } else {
            if (!max || !exactIn) {
                amountIn = SqrtPriceMath.getAmount1Delta(sqrtRatioCurrentX96, sqrtRatioNextX96, liquidity, true);
            }
            amountOut = SqrtPriceMath.getAmount0Delta(sqrtRatioCurrentX96, sqrtRatioNextX96, liquidity, false);
        }

        if (exactIn) {
            feeAmount = FullMath.mulDivRoundingUp(amountIn, feePips, 1e6 - feePips);
        } else {
            require(amountOut <= uint256(-amountRemaining), 'Sementsul: OUT_TOO_HIGH');
            feeAmount = FullMath.mulDivRoundingUp(amountOut, feePips, 1e6 - feePips);
        }
    }
}

library TickBitmap {
    /// @notice Сжатие тика в индекс бита. Для отрицательных тиков округление
    /// идёт вниз, а не к нулю: иначе два соседних диапазона попали бы в один
    /// бит, и включение одного выключило бы другой.
    function compress(int24 tick, int24 tickSpacing) internal pure returns (int24 compressed) {
        compressed = tick / tickSpacing;
        if (tick < 0 && tick % tickSpacing != 0) compressed--;
    }

    function flipTick(mapping(int16 => uint256) storage self, int24 tick, int24 tickSpacing) internal {
        require(tick % tickSpacing == 0, 'Sementsul: TICK_NOT_SPACED');
        int24 compressed = compress(tick, tickSpacing);
        int16 wordPos = int16(compressed >> 8);
        uint256 bitPos = uint256(uint8(uint24(compressed % 256)));
        self[wordPos] ^= (1 << bitPos);
    }

    /// @notice Ближайший инициализированный тик в текущем 256-битном слове.
    /// Если в слове такого нет, возвращается граница слова: обмен пойдёт
    /// дальше без изменения ликвидности, и это дешевле, чем искать по всему
    /// диапазону.
    function nextInitializedTickWithinOneWord(
        mapping(int16 => uint256) storage self,
        int24 tick,
        int24 tickSpacing,
        bool lte
    ) internal view returns (int24 next, bool initialized) {
        int24 compressed = compress(tick, tickSpacing);

        if (lte) {
            int16 wordPos = int16(compressed >> 8);
            uint256 bitPos = uint256(uint8(uint24(compressed % 256)));
            // Маска включает сам бит: тик на текущей позиции тоже кандидат.
            uint256 mask = (1 << bitPos) - 1 + (1 << bitPos);
            uint256 masked = self[wordPos] & mask;

            initialized = masked != 0;
            next = initialized
                ? ((int24(wordPos) << 8) + int24(uint24(_mostSignificantBit(masked)))) * tickSpacing
                : (int24(wordPos) << 8) * tickSpacing;
        } else {
            int16 wordPos = int16((compressed + 1) >> 8);
            uint256 bitPos = uint256(uint8(uint24((compressed + 1) % 256)));
            // Здесь наоборот: текущий бит исключён, ищем строго правее.
            uint256 mask = ~((1 << bitPos) - 1);
            uint256 masked = self[wordPos] & mask;

            initialized = masked != 0;
            next = initialized
                ? ((int24(wordPos) << 8) + int24(uint24(_leastSignificantBit(masked)))) * tickSpacing
                : ((int24(wordPos) << 8) + 255) * tickSpacing;
        }
    }

    /// @notice Позиция старшего установленного бита. Это не поиск значения,
    /// а именно позиция, поэтому 255 = "установлен только старший бит".
    function _mostSignificantBit(uint256 x) private pure returns (uint8 r) {
        require(x > 0, 'Sementsul: MSB_ZERO');
        if (x >= 0x100000000000000000000000000000000) {
            x >>= 128;
            r += 128;
        }
        if (x >= 0x10000000000000000) {
            x >>= 64;
            r += 64;
        }
        if (x >= 0x100000000) {
            x >>= 32;
            r += 32;
        }
        if (x >= 0x10000) {
            x >>= 16;
            r += 16;
        }
        if (x >= 0x100) {
            x >>= 8;
            r += 8;
        }
        if (x >= 0x10) {
            x >>= 4;
            r += 4;
        }
        if (x >= 0x4) {
            x >>= 2;
            r += 2;
        }
        if (x >= 0x2) r += 1;
    }

    function _leastSignificantBit(uint256 x) private pure returns (uint8 r) {
        require(x > 0, 'Sementsul: LSB_ZERO');
        r = 255;
        if (x & type(uint128).max > 0) {
            r -= 128;
        } else {
            x >>= 128;
        }
        if (x & type(uint64).max > 0) {
            r -= 64;
        } else {
            x >>= 64;
        }
        if (x & type(uint32).max > 0) {
            r -= 32;
        } else {
            x >>= 32;
        }
        if (x & type(uint16).max > 0) {
            r -= 16;
        } else {
            x >>= 16;
        }
        if (x & type(uint8).max > 0) {
            r -= 8;
        } else {
            x >>= 8;
        }
        if (x & 0xf > 0) {
            r -= 4;
        } else {
            x >>= 4;
        }
        if (x & 0x3 > 0) {
            r -= 2;
        } else {
            x >>= 2;
        }
        if (x & 0x1 > 0) r -= 1;
    }
}

library LiquidityMath {
    function addDelta(uint128 x, int128 y) internal pure returns (uint128 z) {
        if (y < 0) {
            require((z = x - uint128(-y)) < x, 'Sementsul: LS');
        } else {
            require((z = x + uint128(y)) >= x, 'Sementsul: LA');
        }
    }
}

library SafeCast {
    function toUint160(uint256 y) internal pure returns (uint160 z) {
        require((z = uint160(y)) == y, 'Sementsul: CAST_160');
    }

    function toInt128(int256 y) internal pure returns (int128 z) {
        require((z = int128(y)) == y, 'Sementsul: CAST_I128');
    }

    function toInt256(uint256 y) internal pure returns (int256 z) {
        require(y < 2 ** 255, 'Sementsul: CAST_I256');
        z = int256(y);
    }
}
