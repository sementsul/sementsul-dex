// Сетевые константы BNB Smart Chain.
// Всё, что здесь указано, проверено eth_call'ами на живой сети (block 135.5M, ноябрь 2026).

import deployments from '../contracts/deployments.js'

export const CHAIN_ID = 56

// Pancake MEV Guard (bloXroute private RPC).
// Назначение — приватная отправка транзакций без фронтраннинга.
// Белый список методов: eth_call, eth_getCode, eth_getBalance, eth_getBlockByNumber,
// eth_getTransactionReceipt, eth_estimateGas, eth_gasPrice, eth_sendRawTransaction.
// Заблокированы: eth_getLogs, eth_feeHistory, eth_getStorageAt, eth_getTransactionByHash.
// Батч eth_call: до 100 за запрос.
export const RPC_PRIVATE = 'https://bscrpc.pancakeswap.finance'

// Публичный фолбэк. Батч eth_call: ~30 (дальше -32005).
// getLogs отклющён в доках BNB Chain.
export const RPC_FALLBACK = 'https://bsc-dataseed.bnbchain.org'

export const RPC_LIST = [RPC_PRIVATE, RPC_FALLBACK, 'https://bsc-dataseed1.defibit.io']

// Нативный BNB. Не токен: в пулах его представляет WBNB, а в транзакциях — value.
// Используем эту константу как адрес-заглушку, чтобы не тащить дубли логики.
export const NATIVE = 'bnb'

// Токены
export const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
export const USDT = '0x55d398326f99059fF775485246999027B3197955'

// Токен SEM больше не показывается на бирже: он существовал как тестовый,
// чтобы было чем наполнить первый пул, и снят с сайта вместе с парой SEM/WBNB.
// Адрес контракта остаётся в deployments.js для истории — сам токен никуда
// не делся и на цепи по-прежнему жив, просто биржа его не предлагает.

// Адреса контрактов берутся из contracts.js: он выбирает свои фабрики, если
// они задеплоены, и Pancake как запасной вариант, пока своих нет. Здесь
// остаётся только реэкспорт, чтобы импорты в компонентах не менялись.
export {
  V2_FACTORY,
  V2_ROUTER,
  V3_FACTORY,
  V3_ROUTER,
  V3_QUOTER,
  V3_FEE_TIERS,
  V3_TIER_INFO,
  OWN_V3_TIERS,
  V2_FEE,
  V2_FEE_DENOMINATOR,
  HAS_OWN_DEX,
  HAS_OWN_V3,
  DEPLOYMENT_INFO,
  PANCAKE_V2_FACTORY,
  PANCAKE_V3_FACTORY,
} from './contracts.js'

// Пул для экрана истории сделок — только свой.
//
// Раньше здесь стояла сначала своя пара SEM/WBNB, потом чужой пул Pancake
// WBNB/USDT. Оба варианта плохи: по первому не было ни одной сделки, а второй
// показывал сделки не на нашей бирже да ещё и с перевёрнутой ценой в подписи
// «BNB». Читатель видел «540 BNB» и не мог понять, откуда это.
//
// Теперь блок показывает только наш пул USDT/WBNB. Если своего пула нет или по
// нему нет сделок, блок не рендерится вовсе: пустая история — не повод занимать
// место на экране и уж точно не повод показывать чужую.
export const TRADES_POOL = deployments?.wbnbUsdtV3Pool ?? null

// Порядок токенов в нашем пуле: token0 = USDT, token1 = WBNB (адреса
// упорядочены по возрастанию, так вышло само). Цена в базе поэтому хранится
// как WBNB за USDT, а показываем мы обратное — USDT за WBNB.
export const TRADES_PAIR_LABEL = 'USDT / WBNB'

// Старая константа оставлена для совместимости: 9975/10000 — это 0.25%
// Pancake V2. Своя биржа считает комиссию в единицах 1e-6, см. V2_FEE.
export const FEES = {
  V2: 9975n,
  V2_DENOM: 10000n,
}

export const BSC = {
  id: 56,
  name: 'BNB Smart Chain',
  nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  rpcUrls: { default: { http: [RPC_PRIVATE, RPC_FALLBACK] } },
  blockExplorers: { default: { name: 'BscScan', url: 'https://bscscan.com' } },
}

// Известные токены для селектора. Всё остальное — вставка адреса вручную.
//
// Каждый адрес проверен на живой сети (scripts/check-tokens.mjs): есть код,
// читаются symbol/name/decimals, и символ на цепи совпадает с ожидаемым.
// Проверка не косметическая — адрес, набранный по памяти, легко указывает на
// подделку, а пользователь видит только символ.
//
// decimals у некоторых токенов НЕ 18: DOGE — 8, FLOKI и BABYDOGE — 9. Если
// считать всё восемнадцатизначным, суммы разойдутся в миллиарды раз.
const POPULAR = [
  { symbol: 'USDT', name: 'Tether USD', decimals: 18, address: '0x55d398326f99059fF775485246999027B3197955' },
  { symbol: 'USDC', name: 'USD Coin', decimals: 18, address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d' },
  { symbol: 'BUSD', name: 'BUSD Token', decimals: 18, address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56' },
  { symbol: 'CAKE', name: 'PancakeSwap Token', decimals: 18, address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82' },
  { symbol: 'BTCB', name: 'BTCB Token', decimals: 18, address: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c' },
  { symbol: 'ETH', name: 'Ethereum Token', decimals: 18, address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8' },
  { symbol: 'XRP', name: 'XRP Token', decimals: 18, address: '0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE' },
  { symbol: 'ADA', name: 'Cardano Token', decimals: 18, address: '0x3EE2200Efb3400fAbB9AacF31297cBdD1d435D47' },
  { symbol: 'DOGE', name: 'Dogecoin', decimals: 8, address: '0xbA2aE424d960c26247Dd6c32edC70B295c744C43' },
  { symbol: 'DOT', name: 'Polkadot Token', decimals: 18, address: '0x7083609fCE4d1d8Dc0C979AAb8c869Ea2C873402' },
  { symbol: 'LINK', name: 'ChainLink Token', decimals: 18, address: '0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD' },
  { symbol: 'BCH', name: 'Bitcoin Cash Token', decimals: 18, address: '0x8fF795a6F4D97E7887C79beA79aba5cc76444aDf' },
  { symbol: 'LTC', name: 'Litecoin Token', decimals: 18, address: '0x4338665CBB7B2485A8855A139b75D5e34AB0DB94' },
  { symbol: 'SHIB', name: 'SHIBA INU', decimals: 18, address: '0x2859e4544C4bB03966803b044A93563Bd2D0DD4D' },
  { symbol: 'XVS', name: 'Venus', decimals: 18, address: '0xcF6BB5389c92Bdda8a3747Ddb454cB7a64626C63' },
  { symbol: 'TWT', name: 'Trust Wallet', decimals: 18, address: '0x4B0F1812e5Df2A09796481Ff14017e6005508003' },
  { symbol: 'FLOKI', name: 'FLOKI', decimals: 9, address: '0xfb5B838b6cfEEdC2873aB27866079AC55363D37E' },
  { symbol: 'BABYDOGE', name: 'Baby Doge Coin', decimals: 9, address: '0xc748673057861a797275CD8A068AbB95A902e8de' },
  { symbol: 'UNI', name: 'Uniswap', decimals: 18, address: '0xBf5140A22578168FD562DCcF235E5D43A02ce9B1' },
  { symbol: 'ATOM', name: 'Cosmos Token', decimals: 18, address: '0x0Eb3a705fc54725037CC9e008bDede697f62F335' },
  { symbol: 'FIL', name: 'Filecoin', decimals: 18, address: '0x0D8Ce2A99Bb6e3B7Db580eD848240e4a0F9aE153' },
  { symbol: 'EOS', name: 'EOS Token', decimals: 18, address: '0x56b6fB708fC5732DEC1Afc8D8556423A2EDcCbD6' },
  { symbol: 'TRX', name: 'TRON', decimals: 18, address: '0x85EAC5Ac2F758618dFa09bDBe0cf174e7d574D5B' },
]

const LOGO = (symbol) => `https://tokens.pancakeswap.finance/images/symbol/${symbol.toLowerCase()}.png`

export const KNOWN_TOKENS = [
  {
    address: NATIVE,
    symbol: 'BNB',
    name: 'BNB',
    decimals: 18,
    native: true,
    logo: LOGO('bnb'),
  },
  {
    address: WBNB,
    symbol: 'WBNB',
    name: 'Wrapped BNB',
    decimals: 18,
    logo: LOGO('bnb'),
  },
  // Популярные токены BNB Chain: с ними пользователь может создать пул в один
  // клик, не разыскивая адрес. Все прошли проверку на цепи.
  ...POPULAR.map((t) => ({ ...t, logo: LOGO(t.symbol), popular: true })),
]

// Известные пулы: только для отображения «где торгуется», маршрутизация их находит сама.
export const KNOWN_POOLS = [
  // Чужой пул Pancake WBNB/USDT в V2. Нужен только для маршрутизации: пока в
  // своём пуле мало ликвидности, крупный обмен выгоднее провести здесь.
  { id: 'wbnb-usdt-v2', protocol: 'v2', address: '0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae', token0: USDT, token1: WBNB, fee: 25 },
  // Свой пул WBNB/USDT в V3 (0.05%). Ставим выше чужих пулов той же пары:
  // когда в нём появится ликвидность, маршрут должен идти через него, а не
  // через Pancake. Пока он пуст, маршрутизация его сама пропустит.
  ...(deployments?.wbnbUsdtV3Pool
    ? [
        {
          id: 'wbnb-usdt-v3-own-500',
          protocol: 'v3',
          address: deployments.wbnbUsdtV3Pool,
          token0: USDT,
          token1: WBNB,
          fee: 5,
          own: true,
        },
      ]
    : []),
  { id: 'wbnb-usdt-v3-100', protocol: 'v3', address: '0x172fcd41e0913e95784454622d1c3724f546f849', fee: 1, token0: WBNB, token1: USDT },
  { id: 'wbnb-usdt-v3-500', protocol: 'v3', address: '0x36696169c63e42cd08ce11f5deebbcebae652050', fee: 5, token0: WBNB, token1: USDT },
  { id: 'wbnb-usdt-v3-2500', protocol: 'v3', address: '0x1401ff943d08a7e098328c1d3a9d388923b115d2', fee: 25, token0: WBNB, token1: USDT },
]