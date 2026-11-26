// Чистая логика выбора, что именно выводить.
//
// Вынесено из scripts/withdraw.mjs отдельным модулем, чтобы это можно было
// проверить тестом без сети и без отправки транзакций: ошибка здесь стоит
// денег, а не только сломанного вывода.

/// Какие токены отправлять.
///
/// Правила:
///   only — только этот символ;
///   all  — все найденные;
///   иначе — ничего.
///
/// Раньше в withdraw.mjs стояло `allTokens ? found : found`: обе ветки
/// возвращали одно и то же, поэтому вызов без --all молча отправлял ВСЕ
/// токены. На практике `--token WBNB` увёл заодно 900 млн SEM. Умолчание
/// должно быть «ничего не отправлять»: деньги не уходят без явного выбора.
export function selectTargets(found, { only = null, all = false } = {}) {
  if (only) {
    return found.filter((t) => t.sym.toLowerCase() === String(only).toLowerCase())
  }
  return all ? found : []
}

/// Достаёт адрес токена из строки или объекта { address, decimals }.
///
/// В withdraw.mjs функция balanceOf ждала объект, а вызывалась с адресом —
/// token.address давал undefined, readContract падал, ошибка глушилась в catch
/// и превращалась в 0n. Снаружи это выглядело как пустой кошелёк: скрипт
/// показывал 0 USDT там, где лежало 134. Поэтому принимаем обе формы и
/// проверяем формат явно.
export function resolveTokenAddress(token) {
  const address = typeof token === 'string' ? token : token?.address
  if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? '')) {
    throw new Error(`ожидался адрес токена, получено ${JSON.stringify(token)}`)
  }
  return address
}