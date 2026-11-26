// Геолокация по IP на границе Cloudflare.
//
// Зачем на сервере, а не в браузере: IP-адрес клиента знает только граница.
// Если спросить сторонний гео-сервис из браузера, он увидит IP пользователя,
// но это лишняя утечка адреса третьей стороне. Здесь данные уже есть в
// request.cf — Cloudflare кладёт их в каждый запрос, и наружу ничего не уходит.
//
// Ответ намеренно минимальный: страна и регион, без города и координат.
// Город и широта не нужны для решения о блокировке, а их утечка в браузер
// бессмысленна.
//
// ВАЖНО: это эндпоинт, а не middleware. Он только сообщает, откуда пришёл
// запрос; решение о блокировке принимает фронтенд (src/lib/compliance.js).
// Так проще: пользователь видит внятное объяснение, а не голый 451, и
// страницу можно открыть с другого адреса, чтобы понять причину.
//
// Усиление до полной блокировки на границе (return 451 в _middleware.js)
// описано в docs/COMPLIANCE.md — включать, когда понадобится.

export async function onRequestGet({ request }) {
  // request.cf есть в Cloudflare Workers и Pages Functions. В локальном
  // `wrangler pages dev` он тоже заполняется, но в обычном браузере — нет,
  // поэтому поля могут быть undefined.
  const cf = request.cf ?? {}

  const payload = {
    country: typeof cf.country === 'string' ? cf.country.toUpperCase() : null,
    // regionCode — числовой код региона (для UA это области), region — имя.
    // Для Крыма и Донбасса страна одна и та же (UA), поэтому различать
    // приходится по региону. Cloudflare заполняет эти поля не для всех IP.
    regionCode: cf.regionCode ?? null,
    region: cf.region ?? null,
    // Cloudflare не отдаёт IP в request.cf — он приходит в заголовке.
    // Сохраняем только факт наличия, сам IP наружу не отдаём.
    hasIp: Boolean(request.headers.get('CF-Connecting-IP')),
  }

  return new Response(JSON.stringify(payload), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Ответ зависит от того, откуда пришёл запрос, поэтому кэшировать его
      // на общем CDN нельзя: иначе один кэш раздаст страну всем подряд.
      'cache-control': 'no-store, private',
      vary: 'CF-Connecting-IP',
    },
  })
}