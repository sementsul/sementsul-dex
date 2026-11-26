// Адреса контрактов: свои, если задеплоены, иначе Pancake.
//
// Смысл файла — одна точка правды. Пока deployments.js содержит нулевые
// адреса, биржа работает на чужих пулах: так фронтенд остаётся живым даже до
// деплоя. Как только контракты задеплоены, все экраны автоматически
// переключаются на свои пары, без правок в компонентах.
//
// Комиссия в наших контрактах задаётся в единицах 1e-6 (FEE_DENOMINATOR = 1e6),
// а не в базисных пунктах: 0.005% не выражается целым числом bps, а именно
// такая низкая ставка и нужна, чтобы арбитражникам было выгодно.

import deployments from '../contracts/deployments.js'

// Pancake: запасной вариант, пока своих контрактов нет.
export const PANCAKE_V2_FACTORY = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73'
export const PANCAKE_V2_ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E'
export const PANCAKE_V3_FACTORY = '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865'
export const PANCAKE_V3_ROUTER = '0x1b81D678ffb9C0263b24A97847620C99d213eB14'
export const PANCAKE_V3_QUOTER = '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997'

const ZERO = '0x0000000000000000000000000000000000000000'

// Есть ли собственный деплой. Проверяем именно адреса, а не наличие файла:
// пустой файл-заготовка не должен считаться деплоем.
export const HAS_OWN_DEX = Boolean(
  deployments?.factory &&
    deployments.factory !== ZERO &&
    deployments?.router &&
    deployments.router !== ZERO
)

export const V2_FACTORY = HAS_OWN_DEX ? deployments.factory : PANCAKE_V2_FACTORY
export const V2_ROUTER = HAS_OWN_DEX ? deployments.router : PANCAKE_V2_ROUTER

// V3 может быть задеплоен отдельно от V2: фабрики независимы.
export const HAS_OWN_V3 = Boolean(
  deployments?.v3Factory && deployments.v3Factory !== ZERO
)
export const V3_FACTORY = HAS_OWN_V3 ? deployments.v3Factory : PANCAKE_V3_FACTORY

// Роутер для V3 — ОТДЕЛЬНЫЙ контракт, а не тот же, что у V2.
//
// Здесь была настоящая ошибка: V3_ROUTER указывал на deployments.router, то
// есть на роутер V2, у которого нет ни одной V3-функции. Фронтенд собирал
// calldata exactInputSingle и отправлял её контракту, который такого метода
// не знает — транзакция падала бы на селекторе.
//
// Теперь есть SementsulV3Router. Если он не задеплоен, честно откатываемся
// на Pancake-роутер: он умеет те же exactInputSingle/exactInput, но против
// своей фабрики, поэтому наши пулы через него недоступны. Лучше явный
// запасной вариант, чем тихо сломанный вызов.
export const HAS_OWN_V3_ROUTER = Boolean(
  deployments?.v3Router && deployments.v3Router !== ZERO
)
export const V3_ROUTER = HAS_OWN_V3_ROUTER ? deployments.v3Router : PANCAKE_V3_ROUTER
// Своего квотера пока нет: он нужен для точных V3-котировок. Пока V3-пул
// свой, но котировка идёт через оценку по slot0, поэтому V3-маршруты
// показываются только как приблизительные.
export const V3_QUOTER = PANCAKE_V3_QUOTER

// Комиссия V2 в единицах 1e-6. 2500 = 0.25% (как у Pancake V2), но у нас
// значение берётся из деплоя, а не зашито: его можно снизить до 50 (0.005%).
export const V2_FEE = BigInt(deployments?.fee ?? 2500)
export const V2_FEE_DENOMINATOR = 1_000_000n

// Тиры V3. У Pancake четыре фиксированных. У своей фабрики набор задаётся
// при создании, поэтому список берётся из деплоя: если он не записан,
// подставляем стандартную четвёрку, с которой фабрика и разворачивается.
//
// Раньше здесь был ОДИН тир — прямое следствие того, что фабрика держала одну
// комиссию. Теперь тиров четыре, и интерфейс обязан знать их все, иначе пулы
// на остальных тирах он просто не найдёт.
export const V3_FEE_TIERS = HAS_OWN_V3
  ? (deployments.v3FeeTiers ?? [50, 500, 2500, 10000])
  : [100, 500, 2500, 10000]

// Подписи тиров для выпадающего списка: ставка в 1e-6 -> человекочитаемый вид.
// 50 = 0.005%, и это не опечатка: именно такая точность нужна, чтобы ставка
// была ниже минимальной у Pancake (там 0.01%).
export const V3_TIER_INFO = [
  { fee: 50, label: '0.005%', hint: 'самая низкая — для пар со стейблкоинами' },
  { fee: 500, label: '0.05%', hint: 'обычная для ликвидных пар' },
  { fee: 2500, label: '0.25%', hint: 'для пар с заметным разбросом цены' },
  { fee: 10000, label: '1%', hint: 'для экзотических токенов' },
]

// Только те тиры, что реально включены на нашей фабрике.
export const OWN_V3_TIERS = V3_TIER_INFO.filter((t) => V3_FEE_TIERS.includes(t.fee))

export const DEPLOYMENT_INFO = deployments
