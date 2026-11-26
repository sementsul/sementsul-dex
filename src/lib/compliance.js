// Комплаенс на фронтенде: геоблокировка по стране и проверка адреса кошелька
// по санкционному списку.
//
// Что здесь происходит и чего здесь НЕТ — читать до правок.
//
// Есть:
//   1. Проверка страны/региона по IP на границе Cloudflare (functions/api/geo.js).
//   2. Проверка адреса кошелька по официальному списку OFAC SDN.
//   3. Блокировка кнопок записи (обмен, добавление/снятие ликвидности) при
//      срабатывании любого из правил.
//
// Нет и не будет без отдельного решения:
//   · графового анализа транзакций (TRM Labs, Chainalysis). Это платные
//     сервисы, и самостоятельная их имитация даёт ложное чувство защищённости:
//     адрес, связанный с миксером через одну транзакцию, в списке OFAC не
//     появится никогда.
//   · проверки истории кошелька. Список — это «кого уже поймали», а не
//     «кто рискован».
//
// Поэтому в интерфейсе пишем «адрес в списке санкций», а не «кошелёк
// высокорисковый»: второе было бы неправдой.
//
// Обход: этот модуль работает в браузере, значит его можно обойти (отключить
// JS, подменить fetch). Это барьер, а не граница безопасности. Настоящая
// граница — контракты, которые не спрашивают разрешения у фронтенда: любой
// может вызвать пул напрямую через Etherscan. Юридически значимый контроль
// для некастодиального протокола возможен только на уровне интерфейса, что и
// делают Uniswap Labs и PancakeSwap. Подробнее — docs/COMPLIANCE.md.

/// Юрисдикции под полной блокировкой: comprehensive sanctions OFAC (США) и
/// аналогичные режимы ЕС.
///
/// Список стран, а не «всех, кого кто-то считает плохим»: только те, где
/// санкции США/ЕС носят всеобъемлющий характер, то есть запрещены операции
/// почти со всей территорией.
export const BLOCKED_COUNTRIES = {
  // OFAC comprehensive: полностью под санкциями США.
  IR: 'Иран',
  KP: 'КНДР',
  SY: 'Сирия',
  CU: 'Куба',

  // Крым, Донецкая и Луганская области, Запорожская и Херсонская.
  // Проблема: Cloudflare отдаёт для них country = 'UA' (та же Украина),
  // поэтому страну отличить нельзя — нужен регион. Разбор ниже.
  // Сами коды в списке стран не участвуют: см. BLOCKED_UA_REGIONS.

  // Крым как отдельный регион иногда приходит с кодом 'UA-43' или
  // country='UA', region='Crimea'. Обрабатывается в isBlockedRegion.
}

/// Регионы Украины под санкциями ЕС/США (Крым, Донбасс, Запорожье, Херсон).
///
/// Cloudflare для этих территорий обычно отдаёт country='UA' и region с
/// названием. Сопоставляем по подстрокам в названии региона, потому что
/// коды регионов Cloudflare для Украины нестабильны и в документации не
/// зафиксированы.
///
/// Это эвристика, и она может ошибаться в обе стороны:
///   · ложное срабатывание — житель подконтрольной Украине части Запорожской
///     области увидит блокировку;
///   · пропуск — если Cloudflare не заполнит region, проверка не сработает.
///
/// Поэтому решение по региону показывается отдельным сообщением с
/// возможностью обратиться, а не молчаливым отказом.
export const BLOCKED_UA_REGIONS = [
  'crimea',
  'krym',
  'sevastopol',
  'donetsk',
  'donetska',
  'luhansk',
  'luhanska',
  'zaporizh',
  'kherson',
]

/// Код страны под блокировкой? Возвращает название для сообщения или null.
export function blockedCountryName(country) {
  if (typeof country !== 'string') return null
  return BLOCKED_COUNTRIES[country.toUpperCase()] ?? null
}

/// Находится ли запрос в подсанкционном регионе Украины.
export function isBlockedRegion({ country, region, regionCode } = {}) {
  if (typeof country !== 'string' || country.toUpperCase() !== 'UA') return false

  // Крым иногда приходит как отдельная страна в тестовых/устаревших базах.
  const haystack = [region, regionCode]
    .filter((v) => typeof v === 'string')
    .join(' ')
    .toLowerCase()

  if (!haystack.trim()) return false
  return BLOCKED_UA_REGIONS.some((needle) => haystack.includes(needle))
}

/// Итоговое решение по геолокации.
///
/// Возвращает { blocked, kind, title, message }, где kind — 'country' или
/// 'region', чтобы интерфейс мог показать разный текст. Если данных нет
/// (эндпоинт недоступен, локальная разработка), возвращает blocked: false:
/// блокировать весь сайт из-за сбоя нашего же API нельзя.
export function evaluateGeo(geo) {
  if (!geo || typeof geo !== 'object') {
    return { blocked: false, kind: null, title: null, message: null }
  }

  const name = blockedCountryName(geo.country)
  if (name) {
    return {
      blocked: true,
      kind: 'country',
      title: 'Доступ ограничен',
      message:
        `Сервис недоступен из этой юрисдикции (${name}). ` +
        'Это ограничение связано с санкционными требованиями США и ЕС и не зависит от вашего кошелька.',
    }
  }

  if (isBlockedRegion(geo)) {
    return {
      blocked: true,
      kind: 'region',
      title: 'Доступ ограничен',
      message:
        'Сервис недоступен из этого региона. Ограничение связано с санкционными ' +
        'требованиями США и ЕС. Если вы считаете, что это ошибка определения ' +
        'местоположения, напишите в репозиторий проекта.',
    }
  }

  return { blocked: false, kind: null, title: null, message: null }
}

// ---------- санкционный список ----------

/// Кэш списка в памяти. Список — статический файл в public/sanctions/,
/// поэтому одного запроса за сессию достаточно.
let sanctionsPromise = null

/// Загружает список. Возвращает { set: Set<address>, meta } или null при сбое.
///
/// Сбой загрузки НЕ блокирует сайт: если файл не отдался, проверка адреса
/// просто не выполняется. Иначе одна сетевая ошибка ложила бы весь интерфейс.
/// Это осознанный выбор в пользу доступности: гео-проверка остаётся, а она
/// на сервере.
export function loadSanctions() {
  if (sanctionsPromise) return sanctionsPromise

  sanctionsPromise = (async () => {
    try {
      const res = await fetch('/sanctions/ofac-addresses.json', { cache: 'no-cache' })
      if (!res.ok) return null
      const data = await res.json()
      const addresses = data?.addresses ?? {}
      const set = new Set(Object.keys(addresses).map((a) => a.toLowerCase()))
      return { set, meta: data, addresses }
    } catch {
      return null
    }
  })()

  return sanctionsPromise
}

/// Проверяет адрес по загруженному списку.
///
/// Возвращает { listed, entry } — entry содержит имена и программы санкций,
/// чтобы показать пользователю причину, а не голое «заблокировано».
///
/// Если список не загрузился, возвращает { listed: false, unavailable: true }:
/// интерфейс должен знать, что проверка не выполнялась, и не делать вид, что
/// адрес проверен.
export async function checkAddress(address) {
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return { listed: false, unavailable: false, entry: null }
  }

  const data = await loadSanctions()
  if (!data) {
    return { listed: false, unavailable: true, entry: null }
  }

  const key = address.toLowerCase()
  if (!data.set.has(key)) {
    return { listed: false, unavailable: false, entry: null }
  }

  const entry = data.addresses[key] ?? {}
  return {
    listed: true,
    unavailable: false,
    entry: {
      names: entry.names ?? [],
      programs: entry.programs ?? [],
    },
  }
}

/// Человекочитаемая причина блокировки адреса.
export function describeAddressBlock(entry) {
  const names = entry?.names?.filter(Boolean) ?? []
  const programs = entry?.programs?.filter(Boolean) ?? []

  const who = names.length ? names.join(', ') : 'запись в списке OFAC'
  const why = programs.length ? ` (программа: ${programs.join(', ')})` : ''
  return `Адрес внесён в санкционный список OFAC: ${who}${why}. Операции с этого адреса заблокированы.`
}