// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// SementsulToken — SEM, токен без администратора.
//
// Доверие к токену определяется не обещаниями, а тем, чего в контракте НЕТ.
// Здесь намеренно отсутствуют:
//
//   - owner и любые роли — нет адреса, который может что-то сделать;
//   - mint — предложение зафиксировано в конструкторе навсегда;
//   - pause, blacklist, maxTx — перевод нельзя остановить или запретить;
//   - налог — transfer переводит ровно amount, ни на wei меньше;
//   - прокси и upgrade — код неизменяем, адрес не подменить;
//   - внешние вызовы в transfer — некому перехватить управление и отменить
//     перевод, поэтому honeypot технически невозможен.
//
// Каждая из этих возможностей — потенциальный рычаг против держателей. У этого
// контракта рычагов нет: даже если завтра владелец захочет заблокировать чей-то
// перевод или допечатать токены, функции для этого не существует.
//
// Единственное, что может владелец, — распорядиться своими токенами. Ровно то
// же может любой другой держатель.
contract SementsulToken {
    // ---------- метаданные ----------
    //
    // constant, а не переменные: значения зашиты в байткод и не могут быть
    // изменены ни при каких условиях. Это дешевле и, главное, не оставляет
    // вопроса «а вдруг их поменяют».

    string public constant name = 'Sementsul';
    string public constant symbol = 'SEM';
    uint8 public constant decimals = 18;

    /// @notice Текущее предложение токена.
    ///
    /// Не immutable, потому что burn его уменьшает. Но это не делает его
    /// управляемым: функция способна только уменьшать предложение и только за
    /// счёт баланса вызывающего. Увеличить его нечем — mint отсутствует.
    uint256 public totalSupply;

    // ---------- состояние ERC-20 ----------

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // ---------- EIP-2612 (permit) ----------
    //
    // Позволяет одобрить расход одной подписью, без отдельной транзакции
    // approve. Это удобство, а не дополнительная власть: permit лишь
    // устанавливает разрешение, которое владелец и так может выдать вручную.

    mapping(address => uint256) public nonces;

    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 private constant PERMIT_TYPEHASH =
        keccak256('Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)');

    // ---------- события ----------

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    /// @param recipient Кому достаётся весь выпуск.
    /// @param initialSupply Сколько выпустить. Ноль запрещён: токен без
    /// предложения бессмысленен и почти всегда означает ошибку ввода.
    constructor(address recipient, uint256 initialSupply) {
        require(recipient != address(0), 'SEM: RECIPIENT_ZERO');
        require(initialSupply > 0, 'SEM: SUPPLY_ZERO');

        totalSupply = initialSupply;
        balanceOf[recipient] = initialSupply;

        // Событие выпуска с from = 0 — так индексаторы и кошельки видят
        // происхождение предложения, а не только текущие балансы.
        emit Transfer(address(0), recipient, initialSupply);

        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
                keccak256(bytes(name)),
                keccak256('1'),
                block.chainid,
                address(this)
            )
        );
    }

    // ---------- переводы ----------

    /// @notice Перевести токены. Ровно amount, без комиссий и удержаний.
    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    /// @notice Одобрить расход.
    ///
    /// Семантика строго стандартная: значение просто записывается, без
    /// требования обнулять предыдущее.
    ///
    /// Здесь был соблазн запретить смену ненулевого разрешения на другое —
    /// так закрывается известная гонка approve/transferFrom. Но такой запрет
    /// отклоняется от ERC-20, а любое отклонение бьёт по совместимости:
    /// агрегаторы, боты и кошельки вызывают approve напрямую и не ожидают
    /// отказа. Токен, на котором ломается привычный инструмент, теряет
    /// доверие быстрее, чем приобретает от защиты от редкой гонки.
    ///
    /// Поэтому защита перенесена туда, где ей место: кошелёк и фронтенд
    /// показывают, кому и сколько одобряется. Сам контракт ведёт себя ровно
    /// как любой ERC-20.
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    /// @notice Перевести от имени owner в пределах разрешения.
    ///
    /// Безлимитное разрешение не уменьшается: это стандартное поведение
    /// (так же поступает OpenZeppelin), оно экономит газ и не создаёт
    /// неожиданности, когда разрешение внезапно кончилось.
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, 'SEM: ALLOWANCE');
            unchecked {
                allowance[from][msg.sender] = allowed - amount;
            }
        }
        _transfer(from, to, amount);
        return true;
    }

    /// @notice Сжечь свои токены. Уменьшает totalSupply — единственное
    /// изменение предложения в контракте, и только в меньшую сторону.
    ///
    /// Сжигать можно лишь собственный баланс: функции сжечь чужие нет, поэтому
    /// это не рычаг, а добровольное действие держателя.
    function burn(uint256 amount) external returns (bool) {
        uint256 balance = balanceOf[msg.sender];
        require(balance >= amount, 'SEM: BALANCE');
        unchecked {
            balanceOf[msg.sender] = balance - amount;
        }
        totalSupply -= amount;
        emit Transfer(msg.sender, address(0), amount);
        return true;
    }

    // ---------- permit ----------

    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(block.timestamp <= deadline, 'SEM: EXPIRED');

        // s обязан быть в нижней половине порядка кривой: иначе из одной
        // подписи можно сделать вторую (malleability) и использовать permit
        // дважды.
        require(
            uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0,
            'SEM: INVALID_S'
        );
        require(v == 27 || v == 28, 'SEM: INVALID_V');

        bytes32 structHash = keccak256(
            abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner]++, deadline)
        );
        bytes32 digest = keccak256(abi.encodePacked('\x19\x01', DOMAIN_SEPARATOR, structHash));

        address recovered = ecrecover(digest, v, r, s);
        require(recovered != address(0) && recovered == owner, 'SEM: INVALID_SIGNATURE');

        allowance[owner][spender] = value;
        emit Approval(owner, spender, value);
    }

    // ---------- внутреннее ----------

    function _transfer(address from, address to, uint256 amount) private {
        require(to != address(0), 'SEM: TO_ZERO');

        uint256 balance = balanceOf[from];
        require(balance >= amount, 'SEM: BALANCE');
        unchecked {
            balanceOf[from] = balance - amount;
        }
        balanceOf[to] += amount;

        emit Transfer(from, to, amount);
    }
}