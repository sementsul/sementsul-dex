// Адреса и список токенов. Всё захардкожено: on-chain сборка не может
// читать конфиг с сервера, иначе она снова начала бы зависеть от домена.

export const CHAIN_ID = 56
export const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
export const USDT = '0x55d398326f99059fF775485246999027B3197955'
export const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'

// Свои контракты.
export const V2_FACTORY = '0x6f950C2212754f54Cf4e99EBA6c3F699725B89b6'
export const V2_ROUTER = '0x2069336bD5E70c4F359Ff4142a8B072D074cbbe6'
export const V3_FACTORY = '0xc0b597bee57bba0aae2ce9e73e83217331a24dd9'
export const V3_ROUTER = '0xf98b7f4effb34dae1f785010ecf71ff796e7fdd1'

// Pancake: нужен, потому что своих пулов почти нет. Интерфейс ищет пул
// в обеих фабриках и берёт тот, где цена лучше.
export const PANCAKE_V2_FACTORY = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73'
export const PANCAKE_V2_ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E'
export const PANCAKE_V3_FACTORY = '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865'
export const PANCAKE_V3_ROUTER = '0x1b81D678ffb9C0263b24A97847620C99d213eB14'
export const PANCAKE_V3_QUOTER = '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997'

// Свои тиры V3: четыре, как у Uniswap. В единицах 1e-6.
export const V3_FEE_TIERS = [50, 500, 2500, 10000]
export const PANCAKE_FEE_TIERS = [100, 500, 2500, 10000]

// Токены BSC. Список намеренно короткий и проверенный: каждый символ
// сверен с цепью при сборке, случайный адрес сюда не попадёт.
export const TOKENS = [
  { symbol: 'BNB', name: 'BNB', decimals: 18, address: NATIVE, native: true },
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

export const bySymbol = {}
for (const t of TOKENS) bySymbol[t.symbol] = t

export function tokenByAddress(addr) {
  const a = addr.toLowerCase()
  return TOKENS.find((t) => t.address.toLowerCase() === a) ?? null
}

// Пул, который мы наполняли. Нужен как подсказка: если он есть, показываем
// его отдельной строкой, потому что это «наш» пул.
export const OWN_POOL = '0x37c7702B589c69D1e4f4ad32E19f372ED6780278'