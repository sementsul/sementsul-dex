// Условия использования: содержимое как данные.
//
// Тексты лежат отдельно от компонента, потому что это длинный юридический
// документ, а не разметка. Хранить их в JSX значило бы смешать два разных
// типа изменений: правку формулировки и правку вёрстки.
//
// Документ на двух языках. Английская версия — не «перевод для удобства», а
// рабочая: если возникнет спор, регулятор или партнёр будет читать именно её.
// Поэтому формулировки в обеих версиях совпадают по смыслу, а не дословно, и
// каждая написана как самостоятельный текст.

export const TERMS_VERSION = '2026-11-26'

/// Краткая сводка для карточки в интерфейсе: три-четыре пункта, которые
/// пользователь действительно должен понять до подписи транзакции.
export const TERMS_SUMMARY = {
  ru: [
    'Интерфейс не хранит ваши средства и не имеет к ним доступа.',
    'Комиссию протокола нет и включить её нельзя: вся комиссия остаётся поставщикам ликвидности.',
    'Транзакции необратимы, а риск потерь в пулах целиком ваш.',
    'Сервис не предназначен для пользователей ЕЭЗ и подсанкционных юрисдикций.',
  ],
  en: [
    'The interface does not hold your funds and has no access to them.',
    'There is no protocol fee and no way to enable one: all fees stay with liquidity providers.',
    'Transactions are irreversible, and the risk of loss in pools is entirely yours.',
    'The service is not intended for EEA users or sanctioned jurisdictions.',
  ],
}

/// Разделы документа. Каждый — { id, title, paragraphs }.
///
/// Порядок не случайный: сначала что это вообще такое, потом чего мы не
/// делаем, потом что пользователь берёт на себя, и только в конце — ЕЭЗ и
/// санкции, потому что к этому моменту читатель уже понимает устройство.
export const TERMS = {
  ru: [
    {
      id: 'what',
      title: '1. Что это такое',
      paragraphs: [
        'Sementsul DEX — это веб-интерфейс (далее «Интерфейс») к смарт-контрактам, развёрнутым в сети BNB Smart Chain. Интерфейс позволяет формировать транзакции для обмена токенов и управления ликвидностью в пулах.',
        'Интерфейс не является биржей, брокером, кастодианом, платёжным сервисом или иным финансовым посредником. Он не принимает, не хранит и не переводит ваши средства. Все операции совершаются напрямую между вашим кошельком и смарт-контрактами в блокчейне.',
        'Мы не являемся стороной сделок, совершаемых через Интерфейс, не гарантируем их исполнение и не имеем возможности их отменить.',
      ],
    },
    {
      id: 'nocustody',
      title: '2. Средства остаются у вас',
      paragraphs: [
        'Ключи от вашего кошелька никогда не покидают ваше устройство. Интерфейс не запрашивает и не может запросить закрытый ключ или seed-фразу. Подпись транзакции происходит в вашем кошельке.',
        'У смарт-контрактов нет владельца, который мог бы распоряжаться средствами пользователей: в них отсутствуют функции вывода чужих средств, паузы и изменения логики после развёртывания. Исходный код опубликован и доступен для проверки.',
        'Ликвидность в пулах принадлежит тем, кто её внёс. Никто, включая разработчиков, не может забрать её из пула или запретить вывод.',
      ],
    },
    {
      id: 'nofee',
      title: '3. Комиссии',
      paragraphs: [
        'Интерфейс не взимает плату за использование. В смарт-контрактах нет комиссии протокола и нет механизма, позволяющего её включить в будущем: вся комиссия за обмен остаётся в пуле и распределяется между поставщиками ликвидности пропорционально их доле.',
        'Единственные обязательные расходы — комиссия сети (газ) и комиссия пула, размер которой задаётся фабрикой при создании пула и не может быть изменена создателем пула.',
      ],
    },
    {
      id: 'protection',
      title: '4. Защита от MEV и JIT',
      paragraphs: [
        'В контракты встроен алгоритмический механизм защиты от JIT-атак (just-in-time liquidity): начисленная поставщику комиссия не выдаётся мгновенно, а становится доступной только через заданное число блоков, своё для каждого тира комиссии. Досрочное снятие ликвидности сжигает соразмерную долю ещё не разблокированной комиссии. Это делает схему «войти перед чужим обменом и выйти сразу после» экономически невыгодной.',
        'Для снижения риска сэндвич-атак транзакции отправляются через приватный канал, минуя публичную очередь мемпула. Это уменьшает вероятность атаки, но не устраняет её полностью.',
        'Эти механизмы не являются гарантией защиты от убытков. Мы не обещаем, что MEV или JIT невозможны, и не компенсируем потери, возникшие в результате таких атак.',
      ],
    },
    {
      id: 'risks',
      title: '5. Риски',
      paragraphs: [
        'Операции с криптоактивами связаны с риском полной или частичной потери средств. Вы принимаете эти риски самостоятельно.',
        'Поставщик ликвидности несёт риск непостоянных потерь: стоимость его доли может оказаться ниже стоимости простого держания тех же токенов. В пулах V3 позиция может полностью перейти в один токен, если цена выйдет за пределы выбранного диапазона.',
        'Существует риск ошибки в смарт-контракте, несмотря на проведённое тестирование. Существует риск того, что токен, добавленный в пул, окажется мошенническим или будет иметь встроенные ограничения на перевод. Существует риск перегрузки сети и зависания транзакций.',
        'Интерфейс не модерирует пулы и не проверяет токены, созданные третьими лицами. Любой может создать пул с любым токеном.',
        'Мы не обещаем доходность, не даём инвестиционных рекомендаций и не управляем вашими активами.',
      ],
    },
    {
      id: 'eea',
      title: '6. Европейская экономическая зона (ЕЭЗ)',
      paragraphs: [
        'Интерфейс не предназначен для пользователей, находящихся в Европейской экономической зоне, и не адресован им. Мы не осуществляем маркетинг и не предлагаем услуги на территории ЕЭЗ.',
        'Интерфейс не является поставщиком криптоуслуг (CASP) в смысле Регламента ЕС о рынках криптоактивов (MiCA) и не предоставляет услуг, подлежащих лицензированию: он не хранит средства пользователей, не взимает комиссий, не исполняет поручения и не действует в качестве посредника. Все операции пользователь совершает самостоятельно, напрямую со смарт-контрактами.',
        'Если вы находитесь в ЕЭЗ, вам не следует использовать Интерфейс. Использование Интерфейса в таком случае является вашим собственным решением, не инициированным нами, и вы принимаете на себя ответственность за соблюдение применимого к вам законодательства.',
        'Некоторые криптоактивы, доступные для обмена через Интерфейс, могут не соответствовать требованиям MiCA, предъявляемым к эмитентам токенов, обеспеченных активами (ART), и токенов электронных денег (EMT). Интерфейс не является эмитентом этих активов, не продвигает их и не заявляет об их соответствии каким-либо требованиям. Ответственность за соответствие MiCA лежит на эмитенте соответствующего токена.',
      ],
    },
    {
      id: 'sanctions',
      title: '7. Санкции и ограниченные территории',
      paragraphs: [
        'Интерфейс недоступен для использования лицами, находящимися под санкциями, и из юрисдикций, в отношении которых действуют всеобъемлющие санкции США, Европейского союза или иных применимых режимов, включая Иран, Корейскую Народно-Демократическую Республику, Сирию и Кубу, а также из отдельных регионов Украины.',
        'Интерфейс проверяет адрес подключённого кошелька по опубликованному списку Управления по контролю за иностранными активами США (OFAC) и блокирует проведение операций для адресов, включённых в этот список.',
        'Мы не гарантируем, что проверка является исчерпывающей. Отсутствие адреса в списке не означает, что он не связан с запрещённой деятельностью. Проверка выполняется по формальному признаку присутствия в санкционном перечне и не включает анализ истории транзакций.',
        'Ограничение применяется на уровне Интерфейса. Смарт-контракты остаются общедоступными в блокчейне, и любой может взаимодействовать с ними напрямую, минуя Интерфейс.',
      ],
    },
    {
      id: 'nowarranty',
      title: '8. Отказ от гарантий и ограничение ответственности',
      paragraphs: [
        'Интерфейс предоставляется «как есть» и «как доступно», без каких-либо гарантий, явных или подразумеваемых, включая гарантии пригодности для конкретной цели, отсутствия ошибок или бесперебойной работы.',
        'В максимальной степени, допускаемой применимым правом, мы не несём ответственности за любые прямые, косвенные, случайные или последующие убытки, возникшие в результате использования или невозможности использования Интерфейса, включая упущенную выгоду и потерю криптоактивов.',
        'Это ограничение не применяется в случаях, когда ответственность не может быть ограничена в силу императивных норм применимого права.',
      ],
    },
    {
      id: 'changes',
      title: '9. Изменения условий',
      paragraphs: [
        'Мы можем изменить эти условия. Актуальная версия всегда доступна на этой странице, номер версии указан в её начале. Продолжение использования Интерфейса после изменения условий означает согласие с новой редакцией.',
        'Исходный код проекта открыт. Если вы не согласны с этими условиями, единственным последствием является прекращение использования Интерфейса; смарт-контракты при этом остаются доступными независимо от нашего решения.',
      ],
    },
  ],
  en: [
    {
      id: 'what',
      title: '1. What this is',
      paragraphs: [
        'Sementsul DEX is a web interface (the "Interface") to smart contracts deployed on the BNB Smart Chain network. The Interface lets you build transactions for swapping tokens and managing liquidity in pools.',
        'The Interface is not an exchange, broker, custodian, payment service or any other financial intermediary. It does not receive, hold or transfer your funds. Every operation happens directly between your wallet and the smart contracts on the blockchain.',
        'We are not a party to the transactions made through the Interface, do not guarantee their execution, and have no ability to reverse them.',
      ],
    },
    {
      id: 'nocustody',
      title: '2. Your funds stay with you',
      paragraphs: [
        'Your wallet keys never leave your device. The Interface does not request and cannot request a private key or seed phrase. Transactions are signed in your wallet.',
        'The smart contracts have no owner able to dispose of user funds: they contain no function to withdraw other people\'s funds, no pause and no way to change logic after deployment. The source code is published and available for review.',
        'Liquidity in pools belongs to those who contributed it. Nobody, including the developers, can take it out of a pool or prevent its withdrawal.',
      ],
    },
    {
      id: 'nofee',
      title: '3. Fees',
      paragraphs: [
        'The Interface charges nothing for its use. The smart contracts contain no protocol fee and no mechanism to enable one in the future: the entire swap fee stays in the pool and is distributed among liquidity providers in proportion to their share.',
        'The only unavoidable costs are the network fee (gas) and the pool fee, which is fixed by the factory when the pool is created and cannot be changed by the pool creator.',
      ],
    },
    {
      id: 'protection',
      title: '4. MEV and JIT protection',
      paragraphs: [
        'The contracts contain an algorithmic defence against JIT (just-in-time liquidity) attacks: a fee accrued to a provider is not released instantly but becomes available only after a set number of blocks, specific to each fee tier. Removing liquidity early burns a proportional share of the not-yet-released fee. This makes the "enter before someone else\'s swap and leave right after" scheme economically unprofitable.',
        'To reduce the risk of sandwich attacks, transactions are sent through a private channel that bypasses the public mempool queue. This lowers the likelihood of an attack but does not eliminate it.',
        'These mechanisms are not a guarantee against loss. We do not promise that MEV or JIT are impossible, and we do not compensate losses resulting from such attacks.',
      ],
    },
    {
      id: 'risks',
      title: '5. Risks',
      paragraphs: [
        'Dealing with crypto-assets carries the risk of total or partial loss of funds. You accept these risks yourself.',
        'A liquidity provider bears impermanent loss risk: the value of their share may end up below the value of simply holding the same tokens. In V3 pools a position can end up entirely in one token if the price leaves the chosen range.',
        'There is a risk of a bug in the smart contracts despite the testing performed. There is a risk that a token added to a pool turns out to be fraudulent or to have built-in transfer restrictions. There is a risk of network congestion and transactions getting stuck.',
        'The Interface does not moderate pools and does not verify tokens created by third parties. Anyone can create a pool with any token.',
        'We do not promise yield, do not provide investment advice, and do not manage your assets.',
      ],
    },
    {
      id: 'eea',
      title: '6. European Economic Area (EEA)',
      paragraphs: [
        'The Interface is not intended for, and is not addressed to, users located in the European Economic Area. We do not market or offer services in the EEA.',
        'The Interface is not a crypto-asset service provider (CASP) within the meaning of the EU Markets in Crypto-Assets Regulation (MiCA) and does not provide services subject to authorisation: it does not hold user funds, charge fees, execute orders or act as an intermediary. Users carry out every operation themselves, directly with the smart contracts.',
        'If you are located in the EEA, you should not use the Interface. Any such use is your own decision, not initiated by us, and you are responsible for complying with the laws applicable to you.',
        'Some crypto-assets available for swapping through the Interface may not meet MiCA requirements applicable to issuers of asset-referenced tokens (ART) and e-money tokens (EMT). The Interface is not the issuer of those assets, does not promote them and makes no claim as to their compliance with any requirements. Responsibility for MiCA compliance rests with the issuer of the relevant token.',
      ],
    },
    {
      id: 'sanctions',
      title: '7. Sanctions and restricted territories',
      paragraphs: [
        'The Interface is not available to sanctioned persons or for use from jurisdictions subject to comprehensive sanctions of the United States, the European Union or other applicable regimes, including Iran, the Democratic People\'s Republic of Korea, Syria and Cuba, or from certain regions of Ukraine.',
        'The Interface checks the connected wallet address against the published list of the US Office of Foreign Assets Control (OFAC) and blocks operations for addresses included in that list.',
        'We do not warrant that this check is exhaustive. The absence of an address from the list does not mean it is unconnected to prohibited activity. The check relies on formal presence in the sanctions list and does not include transaction history analysis.',
        'The restriction applies at the level of the Interface. The smart contracts remain publicly accessible on the blockchain, and anyone may interact with them directly, bypassing the Interface.',
      ],
    },
    {
      id: 'nowarranty',
      title: '8. Disclaimer of warranties and limitation of liability',
      paragraphs: [
        'The Interface is provided "as is" and "as available", without any warranties, express or implied, including warranties of fitness for a particular purpose, freedom from errors or uninterrupted operation.',
        'To the maximum extent permitted by applicable law, we are not liable for any direct, indirect, incidental or consequential loss arising from the use of, or inability to use, the Interface, including lost profit and loss of crypto-assets.',
        'This limitation does not apply where liability cannot be limited under mandatory provisions of applicable law.',
      ],
    },
    {
      id: 'changes',
      title: '9. Changes to these terms',
      paragraphs: [
        'We may change these terms. The current version is always available on this page, with the version number shown at the top. Continued use of the Interface after a change constitutes acceptance of the new version.',
        'The project source code is open. If you disagree with these terms, the only consequence is that you stop using the Interface; the smart contracts remain accessible regardless of our decision.',
      ],
    },
  ],
}