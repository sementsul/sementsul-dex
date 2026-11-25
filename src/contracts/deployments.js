// Адреса задеплоенных контрактов Sementsul.
//
// Файл создан автоматически скриптом scripts/deploy.mjs 2026-11-25T21:39:02.045Z.
// Не редактировать вручную: при повторном деплое он будет перезаписан.

export default {
  "chainId": 56,
  "deployed": true,
  "deployedAt": "2026-11-25T21:39:02.045Z",
  "deployer": "0x1c1E586d5ca9D96A169D47bA98dAB85D11b4DA12",
  "fee": 2500,
  "v3FeeTiers": [
    50,
    500,
    2500,
    10000
  ],
  "v3TickSpacings": {
    "50": 1,
    "500": 10,
    "2500": 50,
    "10000": 200
  },
  "admin": "0x1c1E586d5ca9D96A169D47bA98dAB85D11b4DA12",
  "factory": "0x6f950c2212754f54cf4e99eba6c3f699725b89b6",
  "v3Factory": "0xd8fbf8047df940a3640f7b853974b7cfa52dc585",
  "router": "0x2069336bd5e70c4f359ff4142a8b072d074cbbe6",
  "v3Router": "0xc2163ed29ecf3eadb6cc253271cc04b98e0ca5f7",
  "wbnb": "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",

  // Тестовый SEM: выпущен отдельно от биржи, чтобы было чем наполнить пул.
  // У токена нет владельца, нет mint и нет pause — предложение зафиксировано
  // в конструкторе навсегда.
  "token": "0xc729a8fdf0591eaa897f786d4234989a2c39ad0a",
  "tokenSymbol": "SEM",
  "tokenName": "Sementsul",
  "tokenDecimals": 18,
  "tokenSupply": "1000000000000000000000000000",
  "tokenRecipient": "0x1c1E586d5ca9D96A169D47bA98dAB85D11b4DA12",

  // Первая пара на своей бирже: SEM/WBNB в пуле V2. Создана вручную через
  // addLiquidity. По ней интерфейс показывает историю сделок вместо чужого
  // пула Pancake WBNB/USDT, который стоял здесь по умолчанию.
  "tradesPair": "0x64Dbdff7478fb32A61d8BbA84a29983412FFeb18",
  "tradesPairLabel": "SEM / WBNB",
  "tradesPairProtocol": "v2"
}
