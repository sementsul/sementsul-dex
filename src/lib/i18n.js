// Слой локализации: русский и английский.
//
// Принцип: один словарь — одна плоская карта ключей. Никакой вложенности и
// никаких функций-склонений: интерфейс небольшой, а вложенные словари
// усложняют проверку полноты и ломаются при опечатке в ключе.
//
// Язык по умолчанию берётся из браузера. Явный выбор пользователя хранится в
// localStorage и перекрывает браузерный до конца сессии (и дольше).
//
// Чего здесь НЕТ: перевода статей базы знаний. Они лежат отдельными файлами
// (knowledge.js / knowledge.en.js), потому что это длинные тексты, а не
// подписи к кнопкам, и проверить их структуру проще отдельным тестом.

export const LANGS = ['ru', 'en']

/// Язык по умолчанию для первого визита.
///
/// Смотрим navigator.languages целиком, а не только navigator.language:
/// в браузере с интерфейсом en-US и вторым языком ru обычно оба приходят в
/// списке, и разумнее взять первый поддерживаемый, чем навязывать английский.
export function detectLang() {
  try {
    const candidates = []
    if (typeof navigator !== 'undefined') {
      if (Array.isArray(navigator.languages)) candidates.push(...navigator.languages)
      if (navigator.language) candidates.push(navigator.language)
    }
    for (const c of candidates) {
      if (typeof c !== 'string') continue
      const base = c.toLowerCase().split('-')[0]
      if (LANGS.includes(base)) return base
    }
  } catch {
    // Приватный режим или урезанный navigator — не повод падать.
  }
  // Русскоязычный проект: если браузер молчит про язык, показываем русский.
  return 'ru'
}

const STORAGE_KEY = 'sml-dex:lang'

export function loadLang() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (LANGS.includes(saved)) return saved
  } catch {
    // localStorage может быть недоступен (приватный режим, запрет cookies).
  }
  return detectLang()
}

export function saveLang(lang) {
  if (!LANGS.includes(lang)) return
  try {
    localStorage.setItem(STORAGE_KEY, lang)
  } catch {
    // Не сохранилось — язык всё равно применится до перезагрузки.
  }
}

/// Сообщает документу, на каком он языке: атрибут lang влияет на переносы,
/// озвучку и на то, предложит ли браузер перевод страницы.
export function applyDocumentLang(lang) {
  try {
    if (typeof document !== 'undefined') document.documentElement.lang = lang
  } catch {
    // Ничего страшного: атрибут косметический.
  }
}

// ---------------------------------------------------------------------------
// Словари
// ---------------------------------------------------------------------------

export const RU = {
  // --- шапка и навигация ---
  'nav.swap': 'Обмен',
  'nav.pools': 'Пулы',
  'nav.kb': 'База знаний',
  'nav.terms': 'Условия',

  'wallet.connect': 'Подключить кошелёк',
  'wallet.install': 'Установить MetaMask',
  'wallet.disconnectHint': 'Нажмите, чтобы отключить',
  'wallet.wrongChain': 'НЕ ТА СЕТЬ',
  'wallet.blocked': 'ЗАБЛОКИРОВАН',
  'lang.label': 'Язык',
  'lang.ru': 'Русский',
  'lang.en': 'English',

  // --- подвал ---
  'footer.routeNote':
    'Расчёт маршрута и цены выполняется в браузере. Транзакции подписывает ваш кошелёк.',
  'footer.chain': 'Chain ID {id} · BNB Smart Chain',

  // --- комплаенс-плашки ---
  'compliance.blockedTitle': 'Операции заблокированы.',
  'compliance.sanctionsUnavailable':
    'Список санкций не загрузился, проверка адреса не выполнялась. Операции доступны; проверка по юрисдикции работает как обычно.',
  'compliance.actionsBlocked': 'Операции заблокированы',

  // --- экран блокировки ---
  'blocked.title': 'Доступ ограничен',
  'blocked.countryNote':
    'Ограничение действует по стране подключения и не зависит от вашего кошелька или активов. Список юрисдикций: {list}.',
  'blocked.regionNote':
    'Регион определён по IP-адресу. Если это ошибка, сообщите об этом в репозиторий проекта — определение по региону работает по названию области и может ошибаться.',
  'blocked.repo': 'Репозиторий проекта',
  'blocked.legal':
    'Sementsul DEX — некастодиальный интерфейс к смарт-контрактам в BNB Chain. Контракты остаются общедоступными и не контролируются этим сайтом; ограничение относится к использованию интерфейса.',
  'blocked.msgCountry':
    'Сервис недоступен из этой юрисдикции ({name}). Это ограничение связано с санкционными требованиями США и ЕС и не зависит от вашего кошелька.',
  'blocked.msgRegion':
    'Сервис недоступен из этого региона. Ограничение связано с санкционными требованиями США и ЕС. Если вы считаете, что это ошибка определения местоположения, напишите в репозиторий проекта.',
  'blocked.addressListed':
    'Адрес внесён в санкционный список OFAC: {who}{why}. Операции с этого адреса заблокированы.',
  'blocked.ofacEntry': 'запись в списке OFAC',
  'blocked.ofacProgram': ' (программа: {programs})',

  // --- условия использования ---
  'terms.title': 'Условия использования',
  'terms.sub': 'Версия {version}. Используя интерфейс, вы принимаете эти условия.',
  'terms.back': '← Назад',
  'terms.contactTitle': 'Связь.',
  'terms.contactPre': 'Вопросы по этим условиям можно задать в',
  'terms.contactLink': 'репозитории проекта',
  'terms.contactPost': '.',
  'terms.finePrint':
    'Этот документ описывает техническую и юридическую позицию, но не является юридической консультацией. Перед тем как полагаться на него в споре, покажите его юристу.',

  // --- обмен ---
  'swap.title': 'Обмен',
  'swap.youPay': 'Отдаёте',
  'swap.youReceive': 'Получаете',
  'swap.balance': 'Баланс: {amount} {symbol}',
  'swap.max': 'МАКС',
  'swap.minReceive': 'Мин. получите: {amount} {symbol}',
  'swap.switchTokens': 'Поменять местами',
  'swap.route': 'Маршрут',
  'swap.rate': 'Курс',
  'swap.priceImpact': 'Влияние на цену',
  'swap.poolFee': 'Комиссия пула',
  'swap.slippage': 'Проскальзывание',
  'swap.impactWarning':
    'Влияние на цену {pct}. В пуле мало ликвидности — вы получите заметно меньше, чем по текущему курсу.',
  'swap.done': 'Готово.',
  'swap.openExplorer': 'Открыть в BscScan',
  'swap.txInNetwork': 'Транзакция в сети.',
  'swap.insufficientOnBalance': 'Недостаточно {symbol} на балансе',

  // --- кнопка обмена ---
  'btn.enterAmount': 'Введите сумму',
  'btn.quoting': 'Считаем маршрут…',
  'btn.noRoute': 'Маршрут не найден',
  'btn.insufficient': 'Недостаточно {symbol}',
  'btn.approve': 'Разрешить {symbol}',
  'btn.confirming': 'Подтверждаем…',
  'btn.waitingWallet': 'Ожидание в кошельке…',
  'btn.swap': 'Обменять',
  'btn.switchChain': 'Переключиться на BNB Chain',

  // --- ошибки обмена ---
  'err.noRoutePool': 'Маршрут не найден: нет пула с достаточной ликвидностью',
  'err.quote': 'Ошибка котирования',
  'err.universalRouter': 'Этот маршрут требует Universal Router — пока не поддерживается',
  'err.reverted': 'Транзакция отменена сетью (revert)',
  'err.userRejected': 'Вы отклонили транзакцию в кошельке',
  'err.noGas': 'Недостаточно BNB для оплаты газа',
  'err.transferFrom': 'Не удалось списать токен: проверьте разрешение (approve)',
  'err.priceMoved': 'Цена ушла: увеличьте проскальзывание или обновите котировку',
  'err.expired': 'Истекло время транзакции, попробуйте снова',
  'err.walletConnect': 'Не удалось подключить кошелёк',

  // --- выбор токена ---
  'token.choose': 'Выберите токен',
  'token.close': 'Закрыть',
  'token.searchPlaceholder': 'Название или адрес 0x…',
  'token.import': 'Импортировать токен',
  'token.importing': 'Загружаем токен…',
  'token.imported': 'импортирован',
  'token.verified': 'Проверенный токен',
  'token.notFound': 'Ничего не найдено',
  'token.notInList': 'Такого токена нет в списке',
  'token.loadFailed': 'Не удалось загрузить токен',
  'token.readFailed': 'Не удалось прочитать токен: {error}',
  'token.networkError': 'ошибка сети',
  'token.notErc20': 'По этому адресу нет ERC-20 токена',
  'token.noSymbol': 'Контракт не отдаёт symbol() — это не обычный ERC-20',

  // --- копирование адреса ---
  'copy.copied': 'скопировано',
  'copy.failed': 'не удалось',
  'copy.inBuffer': 'адрес в буфере',
  'copy.copyAddress': 'скопировать {address}',
  'copy.copyAddressAria': 'скопировать адрес {address}',

  // --- пулы ---
  'pools.title': 'Пулы',
  'pools.sub': 'Создать пул может кто угодно. Комиссия остаётся поставщикам ликвидности.',
  'pools.create': 'Создать пул',
  'pools.searchPlaceholder': 'Поиск по символу, названию или адресу',
  'pools.showEmpty': 'Показывать пустые',
  'pools.refresh': 'Обновить',
  'pools.loadFailed': 'Не удалось загрузить пулы: {error}',
  'pools.notDeployed':
    'Свои контракты ещё не развёрнуты — список показывает пулы PancakeSwap. После деплоя здесь появятся ваши.',
  'pools.loading': 'Загружаем пулы…',
  'pools.nothingFound': 'Ничего не нашлось.',
  'pools.noneYet': 'Пулов пока нет.',
  'pools.createFirst': 'Создать первый пул',
  'pools.colPool': 'Пул',
  'pools.colTvl': 'TVL',
  'pools.colReserves': 'Резервы',
  'pools.colFee': 'Комиссия',
  'pools.emptyBadge': 'пусто',
  'pools.tvlNoteTitle': 'Что такое TVL.',
  'pools.tvlNote':
    'Это общая стоимость токенов, заблокированных в пуле, — сумма обоих резервов в долларах. Чем выше TVL, тем меньше проскальзывание при обмене и тем больше комиссий получают поставщики ликвидности. Прочерк в колонке TVL означает, что у нас нет надёжного пути к цене в USDT, а не то, что пул пустой.',

  // --- ликвидность ---
  'liq.backToPools': '← Назад к пулам',
  'liq.add': 'Добавить',
  'liq.remove': 'Вывести',
  'liq.connectToSee': 'Подключите кошелёк, чтобы увидеть свою позицию.',
  'liq.firstSetsPrice': 'Первый поставщик задаёт цену',
  'liq.byProportion': 'Считается по пропорции пула',
  'liq.poolEmptyWarning':
    'Пул пуст. Соотношение сумм, которое вы введёте, станет начальной ценой для всех. Если цена окажется неверной, арбитражники заберут разницу.',
  'liq.insufficient': 'Недостаточно средств на балансе.',
  'liq.addButton': 'Добавить ликвидность',
  'liq.adding': 'Добавляем…',
  'liq.removeButton': 'Вывести ликвидность',
  'liq.removing': 'Выводим…',
  'liq.noLp': 'Нет LP-токенов',
  'liq.yourLp': 'Ваши LP-токены',
  'liq.howMuch': 'Сколько вывести',
  'liq.all': 'Всё',
  'liq.receive': 'Получите {symbol}',
  'liq.connectFirst': 'Сначала подключите кошелёк',

  // --- статусы транзакций ---
  'tx.confirmApprove': 'Подтвердите одобрение токенов…',
  'tx.confirmAdd': 'Подтвердите добавление ликвидности…',
  'tx.confirmRemove': 'Подтвердите вывод ликвидности…',
  'tx.confirmPrice': 'Подтвердите установку цены…',
  'tx.confirmMint': 'Подтвердите создание позиции…',
  'tx.confirmBurn': 'Подтвердите снятие ликвидности…',
  'tx.waiting': 'Ждём подтверждения…',
  'tx.liquidityAdded': 'Ликвидность добавлена.',
  'tx.liquidityRemoved': 'Ликвидность выведена.',
  'tx.priceSet': 'Цена установлена.',
  'tx.positionCreated': 'Позиция создана.',
  'tx.collecting': 'Забираем токены и комиссии…',
  'tx.fundsWithdrawn': 'Средства выведены.',

  // --- V3: цена и позиции ---
  'v3.initialPrice': 'Начальная цена: сколько {token1} за 1 {token0}',
  'v3.priceOnce':
    'Цену можно задать только один раз, и отменить это нельзя. Ставьте ту, что близка к рыночной: если она будет ниже, кто-то сразу купит токен дешевле, чем он стоит.',
  'v3.setPrice': 'Установить цену',
  'v3.setting': 'Устанавливаем…',
  'v3.priceUnsetWarning':
    'В этом пуле ещё не задана начальная цена. Без неё неизвестно, сколько токенов соответствует диапазону, поэтому добавлять ликвидность нельзя.',
  'v3.range': 'Диапазон цены',
  'v3.rangeHint':
    'Узкий диапазон приносит больше комиссий на тот же капитал, но если цена выйдет за границы, позиция перестанет зарабатывать и останется в одном токене.',
  'v3.ticks': 'Тики',
  'v3.tickLower': 'нижний: {tick}',
  'v3.tickUpper': 'верхний: {tick}',
  'v3.amountHint': 'Ориентировочная сумма в первом токене',
  'v3.createPosition': 'Создать позицию',
  'v3.positionRange': 'Диапазон позиции',
  'v3.tickLowerPlaceholder': 'нижний тик',
  'v3.tickUpperPlaceholder': 'верхний тик',
  'v3.tickSpacingNote':
    'Диапазон указан в тиках — это те числа, что вы видели при создании позиции. Шаг тика для этого пула: {spacing}.',
  'v3.checkPosition': 'Проверить позицию',
  'v3.noPositionInRange': 'По этому диапазону позиций нет.',
  'v3.noPositionFound': 'По этому диапазону позиций не найдено.',
  'v3.liquidity': 'Ликвидность',
  'v3.fees': 'Комиссии {symbol}',
  'v3.pending': 'Отлеживается {symbol}',
  'v3.vestNotice':
    'Часть комиссии ещё отлеживается до блока {block} — это защита от JIT-ботов. Она станет доступной после этого блока, но только если вы не снимете ликвидность раньше: досрочное снятие сжигает соразмерную долю отлеживающегося.',
  'v3.collectAll': 'Забрать всё',
  'v3.max': 'макс: {amount}',

  // --- создание пула ---
  'create.title': 'Создать пул',
  'create.sub':
    'Новый пул начинает с нуля: ни ликвидности, ни цены. Первый поставщик задаёт цену, остальные к ней присоединяются.',
  'create.firstToken': 'Первый токен',
  'create.secondToken': 'Второй токен',
  'create.chooseToken': 'Выбрать токен',
  'create.poolType': 'Тип пула',
  'create.v2': 'V2 · обычный',
  'create.v2sub': 'вся цена в одном диапазоне',
  'create.v3': 'V3 · концентрированный',
  'create.v3sub': 'ликвидность в выбранном диапазоне',
  'create.v3notDeployed': 'Концентратор ликвидности ещё не развёрнут',
  'create.fee': 'Комиссия пула',
  'create.feeNote':
    'Для одной пары можно создать по пулу на каждый тир — это разные пулы с разными адресами, и ликвидность в них не смешивается. Чем ниже комиссия, тем дешевле торговать и тем меньше зарабатывает поставщик ликвидности.',
  'create.identical': 'Это один и тот же токен — пул с самим собой невозможен.',
  'create.existsPrefix': 'Пара уже существует:',
  'create.existsSuffix':
    'Создавать вторую не нужно — добавьте ликвидность в существующую.',
  'create.v3PriceNotice':
    'После создания V3-пула нужно задать начальную цену. Сделать это можно на странице пула — до этого обмен и ликвидность в нём недоступны.',
  'create.submit': 'Создать пул',
  'create.creating': 'Создаём…',
  'create.connectFirst': 'Сначала подключите кошелёк',
  'create.confirmTx': 'Подтвердите транзакцию в кошельке…',
  'create.created': 'Пул создан.',
  'create.finePrint':
    'Создание пула — это одна транзакция и небольшой расход газа. Комиссию за обмен устанавливает фабрика, а не создатель пула: подкрутить её в свою пользу нельзя.',

  // --- база знаний ---
  'kb.title': 'База знаний',
  'kb.sub': 'Как работает биржа, откуда берётся доход и что может пойти не так.',
  'kb.searchPlaceholder': 'Поиск по статьям',
  'kb.nothingFound': 'По запросу «{query}» ничего не нашлось.',
  'kb.resetSearch': 'Сбросить поиск',
  'kb.backToAll': '← Все статьи',

  // --- последние сделки ---
  'trades.title': 'Последние сделки',
  'trades.loading': 'Загружаем историю…',
  'trades.buy': 'Покупка',
  'trades.sell': 'Продажа',
  'trades.justNow': 'только что',
  'trades.minAgo': '{n} мин назад',
  'trades.hourAgo': '{n} ч назад',
  'trades.dayAgo': '{n} дн назад',

  // --- длительность ---
  'dur.sec': '{n} сек',
  'dur.min': '{n} мин',
  'dur.hour': '{n} ч',

  // --- подсказки тиров комиссии ---
  'tier.hint50': 'самая низкая — для пар со стейблкоинами',
  'tier.hint500': 'обычная для ликвидных пар',
  'tier.hint2500': 'для пар с заметным разбросом цены',
  'tier.hint10000': 'для экзотических токенов',
}

export const EN = {
  // --- header and navigation ---
  'nav.swap': 'Swap',
  'nav.pools': 'Pools',
  'nav.kb': 'Knowledge',
  'nav.terms': 'Terms',

  'wallet.connect': 'Connect wallet',
  'wallet.install': 'Install MetaMask',
  'wallet.disconnectHint': 'Click to disconnect',
  'wallet.wrongChain': 'WRONG NETWORK',
  'wallet.blocked': 'BLOCKED',
  'lang.label': 'Language',
  'lang.ru': 'Русский',
  'lang.en': 'English',

  // --- footer ---
  'footer.routeNote':
    'Routing and pricing run in your browser. Your wallet signs the transactions.',
  'footer.chain': 'Chain ID {id} · BNB Smart Chain',

  // --- compliance banners ---
  'compliance.blockedTitle': 'Transactions are blocked.',
  'compliance.sanctionsUnavailable':
    'The sanctions list failed to load, so the address check did not run. Transactions remain available; the jurisdiction check works as usual.',
  'compliance.actionsBlocked': 'Transactions are blocked',

  // --- blocked screen ---
  'blocked.title': 'Access restricted',
  'blocked.countryNote':
    'This restriction applies based on the country you connect from and does not depend on your wallet or assets. Restricted jurisdictions: {list}.',
  'blocked.regionNote':
    'The region was determined from your IP address. If this is a mistake, please report it in the project repository — region detection works from the province name and can be wrong.',
  'blocked.repo': 'Project repository',
  'blocked.legal':
    'Sementsul DEX is a non-custodial interface to smart contracts on BNB Chain. The contracts remain publicly accessible and are not controlled by this site; the restriction applies to use of the interface.',
  'blocked.msgCountry':
    'The service is unavailable from this jurisdiction ({name}). This restriction follows US and EU sanctions requirements and does not depend on your wallet.',
  'blocked.msgRegion':
    'The service is unavailable from this region. The restriction follows US and EU sanctions requirements. If you believe your location was determined incorrectly, please write to the project repository.',
  'blocked.addressListed':
    'This address is on the OFAC sanctions list: {who}{why}. Transactions from this address are blocked.',
  'blocked.ofacEntry': 'an entry on the OFAC list',
  'blocked.ofacProgram': ' (program: {programs})',

  // --- terms of use ---
  'terms.title': 'Terms of Use',
  'terms.sub': 'Version {version}. By using this interface you accept these terms.',
  'terms.back': '← Back',
  'terms.contactTitle': 'Contact.',
  'terms.contactPre': 'Questions about these terms can be raised in the',
  'terms.contactLink': 'project repository',
  'terms.contactPost': '.',
  'terms.finePrint':
    'This document describes a technical and legal position; it is not legal advice. Have a qualified lawyer review it before relying on it in a dispute.',

  // --- swap ---
  'swap.title': 'Swap',
  'swap.youPay': 'You pay',
  'swap.youReceive': 'You receive',
  'swap.balance': 'Balance: {amount} {symbol}',
  'swap.max': 'MAX',
  'swap.minReceive': 'Min. received: {amount} {symbol}',
  'swap.switchTokens': 'Switch tokens',
  'swap.route': 'Route',
  'swap.rate': 'Rate',
  'swap.priceImpact': 'Price impact',
  'swap.poolFee': 'Pool fee',
  'swap.slippage': 'Slippage',
  'swap.impactWarning':
    'Price impact {pct}. The pool has little liquidity — you will receive noticeably less than at the current rate.',
  'swap.done': 'Done.',
  'swap.openExplorer': 'Open in BscScan',
  'swap.txInNetwork': 'Transaction is on the network.',
  'swap.insufficientOnBalance': 'Not enough {symbol} in your balance',

  // --- swap button ---
  'btn.enterAmount': 'Enter an amount',
  'btn.quoting': 'Finding route…',
  'btn.noRoute': 'No route found',
  'btn.insufficient': 'Not enough {symbol}',
  'btn.approve': 'Approve {symbol}',
  'btn.confirming': 'Confirming…',
  'btn.waitingWallet': 'Waiting for your wallet…',
  'btn.swap': 'Swap',
  'btn.switchChain': 'Switch to BNB Chain',

  // --- swap errors ---
  'err.noRoutePool': 'No route found: no pool with enough liquidity',
  'err.quote': 'Pricing error',
  'err.universalRouter': 'This route needs a Universal Router — not supported yet',
  'err.reverted': 'Transaction reverted by the network',
  'err.userRejected': 'You rejected the transaction in your wallet',
  'err.noGas': 'Not enough BNB to pay for gas',
  'err.transferFrom': 'Could not transfer the token: check the approve allowance',
  'err.priceMoved': 'Price moved: raise slippage or refresh the quote',
  'err.expired': 'Transaction expired, please try again',
  'err.walletConnect': 'Could not connect the wallet',

  // --- token picker ---
  'token.choose': 'Select a token',
  'token.close': 'Close',
  'token.searchPlaceholder': 'Name or 0x… address',
  'token.import': 'Import token',
  'token.importing': 'Loading token…',
  'token.imported': 'imported',
  'token.verified': 'Verified token',
  'token.notFound': 'Nothing found',
  'token.notInList': 'That token is not in the list',
  'token.loadFailed': 'Could not load the token',
  'token.readFailed': 'Could not read the token: {error}',
  'token.networkError': 'network error',
  'token.notErc20': 'There is no ERC-20 token at this address',
  'token.noSymbol': 'The contract does not expose symbol() — not a regular ERC-20',

  // --- copy address ---
  'copy.copied': 'copied',
  'copy.failed': 'failed',
  'copy.inBuffer': 'address is on the clipboard',
  'copy.copyAddress': 'copy {address}',
  'copy.copyAddressAria': 'copy address {address}',

  // --- pools ---
  'pools.title': 'Pools',
  'pools.sub': 'Anyone can create a pool. Fees stay with liquidity providers.',
  'pools.create': 'Create pool',
  'pools.searchPlaceholder': 'Search by symbol, name or address',
  'pools.showEmpty': 'Show empty pools',
  'pools.refresh': 'Refresh',
  'pools.loadFailed': 'Could not load pools: {error}',
  'pools.notDeployed':
    'Our own contracts are not deployed yet — the list shows PancakeSwap pools. Yours will appear here after deployment.',
  'pools.loading': 'Loading pools…',
  'pools.nothingFound': 'Nothing found.',
  'pools.noneYet': 'No pools yet.',
  'pools.createFirst': 'Create the first pool',
  'pools.colPool': 'Pool',
  'pools.colTvl': 'TVL',
  'pools.colReserves': 'Reserves',
  'pools.colFee': 'Fee',
  'pools.emptyBadge': 'empty',
  'pools.tvlNoteTitle': 'What TVL is.',
  'pools.tvlNote':
    'It is the total value of the tokens locked in the pool — both reserves summed in dollars. The higher the TVL, the lower the slippage on a swap and the more fees liquidity providers earn. A dash in the TVL column means we have no reliable path to a USDT price, not that the pool is empty.',

  // --- liquidity ---
  'liq.backToPools': '← Back to pools',
  'liq.add': 'Add',
  'liq.remove': 'Remove',
  'liq.connectToSee': 'Connect your wallet to see your position.',
  'liq.firstSetsPrice': 'The first provider sets the price',
  'liq.byProportion': 'Calculated from the pool ratio',
  'liq.poolEmptyWarning':
    'The pool is empty. The ratio you enter becomes the starting price for everyone. If that price is wrong, arbitrageurs will take the difference.',
  'liq.insufficient': 'Not enough funds in your balance.',
  'liq.addButton': 'Add liquidity',
  'liq.adding': 'Adding…',
  'liq.removeButton': 'Remove liquidity',
  'liq.removing': 'Removing…',
  'liq.noLp': 'No LP tokens',
  'liq.yourLp': 'Your LP tokens',
  'liq.howMuch': 'How much to remove',
  'liq.all': 'All',
  'liq.receive': 'Receive {symbol}',
  'liq.connectFirst': 'Connect your wallet first',

  // --- transaction statuses ---
  'tx.confirmApprove': 'Confirm the token approval…',
  'tx.confirmAdd': 'Confirm adding liquidity…',
  'tx.confirmRemove': 'Confirm removing liquidity…',
  'tx.confirmPrice': 'Confirm setting the price…',
  'tx.confirmMint': 'Confirm creating the position…',
  'tx.confirmBurn': 'Confirm removing liquidity…',
  'tx.waiting': 'Waiting for confirmation…',
  'tx.liquidityAdded': 'Liquidity added.',
  'tx.liquidityRemoved': 'Liquidity removed.',
  'tx.priceSet': 'Price set.',
  'tx.positionCreated': 'Position created.',
  'tx.collecting': 'Collecting tokens and fees…',
  'tx.fundsWithdrawn': 'Funds withdrawn.',

  // --- V3: price and positions ---
  'v3.initialPrice': 'Initial price: how much {token1} per 1 {token0}',
  'v3.priceOnce':
    'The price can be set only once and cannot be undone. Set one close to the market rate: if it is lower, someone will immediately buy the token cheaper than it is worth.',
  'v3.setPrice': 'Set price',
  'v3.setting': 'Setting…',
  'v3.priceUnsetWarning':
    'This pool has no initial price yet. Without it there is no way to know how many tokens a range corresponds to, so liquidity cannot be added.',
  'v3.range': 'Price range',
  'v3.rangeHint':
    'A narrow range earns more fees on the same capital, but if the price leaves the boundaries the position stops earning and ends up in a single token.',
  'v3.ticks': 'Ticks',
  'v3.tickLower': 'lower: {tick}',
  'v3.tickUpper': 'upper: {tick}',
  'v3.amountHint': 'Approximate amount in the first token',
  'v3.createPosition': 'Create position',
  'v3.positionRange': 'Position range',
  'v3.tickLowerPlaceholder': 'lower tick',
  'v3.tickUpperPlaceholder': 'upper tick',
  'v3.tickSpacingNote':
    'The range is given in ticks — the numbers you saw when creating the position. The tick spacing for this pool is {spacing}.',
  'v3.checkPosition': 'Check position',
  'v3.noPositionInRange': 'There are no positions in this range.',
  'v3.noPositionFound': 'No positions found in this range.',
  'v3.liquidity': 'Liquidity',
  'v3.fees': '{symbol} fees',
  'v3.pending': 'Vesting {symbol}',
  'v3.vestNotice':
    'Part of the fee is still vesting until block {block} — this is protection against JIT bots. It becomes available after that block, but only if you do not remove liquidity earlier: removing early burns a proportional share of the vesting amount.',
  'v3.collectAll': 'Collect all',
  'v3.max': 'max: {amount}',

  // --- create pool ---
  'create.title': 'Create pool',
  'create.sub':
    'A new pool starts from zero: no liquidity, no price. The first provider sets the price; everyone else joins it.',
  'create.firstToken': 'First token',
  'create.secondToken': 'Second token',
  'create.chooseToken': 'Select a token',
  'create.poolType': 'Pool type',
  'create.v2': 'V2 · standard',
  'create.v2sub': 'the whole price curve in one range',
  'create.v3': 'V3 · concentrated',
  'create.v3sub': 'liquidity within a chosen range',
  'create.v3notDeployed': 'The liquidity concentrator is not deployed yet',
  'create.fee': 'Pool fee',
  'create.feeNote':
    'For one pair you can create a pool per tier — these are different pools with different addresses, and their liquidity does not mix. The lower the fee, the cheaper it is to trade and the less the liquidity provider earns.',
  'create.identical': 'That is the same token — a pool with itself is impossible.',
  'create.existsPrefix': 'The pair already exists:',
  'create.existsSuffix': 'There is no need to create another — add liquidity to the existing one.',
  'create.v3PriceNotice':
    'After creating a V3 pool you need to set the initial price. You can do that on the pool page — until then swapping and liquidity are unavailable in it.',
  'create.submit': 'Create pool',
  'create.creating': 'Creating…',
  'create.connectFirst': 'Connect your wallet first',
  'create.confirmTx': 'Confirm the transaction in your wallet…',
  'create.created': 'Pool created.',
  'create.finePrint':
    'Creating a pool is a single transaction and a small gas cost. The swap fee is set by the factory, not by the pool creator: it cannot be adjusted in their favour.',

  // --- knowledge base ---
  'kb.title': 'Knowledge base',
  'kb.sub': 'How the exchange works, where income comes from, and what can go wrong.',
  'kb.searchPlaceholder': 'Search articles',
  'kb.nothingFound': 'Nothing found for “{query}”.',
  'kb.resetSearch': 'Reset search',
  'kb.backToAll': '← All articles',

  // --- recent trades ---
  'trades.title': 'Recent trades',
  'trades.loading': 'Loading history…',
  'trades.buy': 'Buy',
  'trades.sell': 'Sell',
  'trades.justNow': 'just now',
  'trades.minAgo': '{n} min ago',
  'trades.hourAgo': '{n} h ago',
  'trades.dayAgo': '{n} d ago',

  // --- duration ---
  'dur.sec': '{n} s',
  'dur.min': '{n} min',
  'dur.hour': '{n} h',

  // --- fee tier hints ---
  'tier.hint50': 'the lowest — for pairs of stablecoins',
  'tier.hint500': 'the usual one for liquid pairs',
  'tier.hint2500': 'for pairs with a noticeable price spread',
  'tier.hint10000': 'for exotic tokens',
}

export const DICTS = { ru: RU, en: EN }

/// Подстановка значений в шаблон: t('swap.balance', { amount: '1.5', symbol: 'BNB' }).
///
/// Плейсхолдеры в фигурных скобках, а не printf-подобные %s: так строка
/// остаётся читаемой в словаре, и порядок аргументов не важен.
export function interpolate(template, params) {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (whole, key) => {
    const v = params[key]
    return v === undefined || v === null ? whole : String(v)
  })
}

/// Достаёт строку из словаря. Если ключа нет — возвращает сам ключ, чтобы
/// пропущенный перевод был виден в интерфейсе и в тесте, а не превращался в
/// пустое место.
export function translate(lang, key, params) {
  const dict = DICTS[lang] ?? RU
  const raw = dict[key] ?? RU[key]
  if (typeof raw !== 'string') return key
  return interpolate(raw, params)
}