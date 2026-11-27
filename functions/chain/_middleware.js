// Р‘Р»РѕРєРёСЂРѕРІРєР° РїРѕ СЃС‚СЂР°РЅРµ РЅР° РіСЂР°РЅРёС†Рµ Cloudflare РґР»СЏ СЃС‚СЂР°РЅРёС†С‹ /chain/.
//
// Р—Р°С‡РµРј РЅР° РіСЂР°РЅРёС†Рµ, Р° РЅРµ РІ Р±СЂР°СѓР·РµСЂРµ. РЈ on-chain РІРµСЂСЃРёРё РЅРµС‚ СЃРµСЂРІРµСЂР°, РїРѕСЌС‚РѕРјСѓ
// РѕРЅР° С„РёР·РёС‡РµСЃРєРё РЅРµ РјРѕР¶РµС‚ СѓР·РЅР°С‚СЊ СЃС‚СЂР°РЅСѓ РїРѕР»СЊР·РѕРІР°С‚РµР»СЏ: IP Р±СЂР°СѓР·РµСЂСѓ РЅРµРґРѕСЃС‚СѓРїРµРЅ,
// Р° СЃРїСЂРѕСЃРёС‚СЊ СЃС‚РѕСЂРѕРЅРЅРёР№ СЃРµСЂРІРёСЃ РЅРµР»СЊР·СЏ вЂ” Сѓ СЃС‚СЂР°РЅРёС†С‹ РЅРµС‚ РїСЂР°РІР° С…РѕРґРёС‚СЊ РєСѓРґР°-Р»РёР±Рѕ,
// РєСЂРѕРјРµ RPC-СѓР·Р»РѕРІ, Рё Р»СЋР±РѕР№ С‚Р°РєРѕР№ Р·Р°РїСЂРѕСЃ Р±С‹Р» Р±С‹ СѓС‚РµС‡РєРѕР№ Р°РґСЂРµСЃР° С‚СЂРµС‚СЊРµР№ СЃС‚РѕСЂРѕРЅРµ.
// Р•РґРёРЅСЃС‚РІРµРЅРЅР°СЏ С‚РѕС‡РєР°, РіРґРµ СЃС‚СЂР°РЅР° РёР·РІРµСЃС‚РЅР°, вЂ” РєСЂР°Р№ Cloudflare. РћРЅ РєР»Р°РґС‘С‚ РµС‘
// РІ request.cf.country, Рё Р·РґРµСЃСЊ РјС‹ РїРѕ РЅРµР№ СЂРµС€Р°РµРј.
//
// РџРѕС‡РµРјСѓ 451, Р° РЅРµ 403. 451 Unavailable For Legal Reasons вЂ” СЌС‚Рѕ СЂРѕРІРЅРѕ РЅР°С€
// СЃР»СѓС‡Р°Р№: РѕС‚РєР°Р· РїРѕ СЋСЂРёРґРёС‡РµСЃРєРёРј РїСЂРёС‡РёРЅР°Рј, Р° РЅРµ РёР·-Р·Р° РѕС€РёР±РєРё РёР»Рё Р·Р°РїСЂРµС‚Р°
// РґРѕСЃС‚СѓРїР°. РўР°РєРѕР№ РєРѕРґ РІРёРґРµРЅ РІ Р»РѕРіР°С… Рё РїРѕРЅСЏС‚РµРЅ РїСЂРѕРІРµСЂСЏСЋС‰РµРјСѓ.
//
// РџСЂРѕРІР°Р№РґРµСЂС‹ Рё РїРѕРёСЃРєРѕРІС‹Рµ СЂРѕР±РѕС‚С‹ РЅРµ Р±Р»РѕРєРёСЂСѓСЋС‚СЃСЏ: Сѓ РЅРёС… РЅРµС‚ CF-IPCountry,
// Р° РµСЃР»Рё Рё РµСЃС‚СЊ, С‚Рѕ СЌС‚Рѕ РЅРµ РїРѕР»СЊР·РѕРІР°С‚РµР»СЊ. РџСѓСЃС‚РѕРµ Р·РЅР°С‡РµРЅРёРµ country С‚СЂР°РєС‚СѓРµРј
// РєР°Рє В«РЅРµРёР·РІРµСЃС‚РЅРѕВ» Рё РїСЂРѕРїСѓСЃРєР°РµРј. Р‘Р»РѕРєРёСЂРѕРІР°С‚СЊ РІРµСЃСЊ СЃР°Р№С‚ РёР·-Р·Р° РѕС‚СЃСѓС‚СЃС‚РІРёСЏ
// Р·Р°РіРѕР»РѕРІРєР° РЅРµР»СЊР·СЏ: СЃР»РѕРјР°РµС‚СЃСЏ Рё Р»РѕРєР°Р»СЊРЅР°СЏ СЂР°Р·СЂР°Р±РѕС‚РєР°, Рё РјРѕРЅРёС‚РѕСЂРёРЅРі.

// РљРѕРґС‹ СЃС‚СЂР°РЅ РїРѕРґ Р±Р»РѕРєРёСЂРѕРІРєРѕР№. Р”РѕР»Р¶РЅС‹ СЃРѕРІРїР°РґР°С‚СЊ СЃ BLOCKED_COUNTRIES РІ
// src/lib/compliance.js вЂ” С‚Р°Рј С‚РѕС‚ Р¶Рµ СЃРїРёСЃРѕРє РґР»СЏ React-РїСЂРёР»РѕР¶РµРЅРёСЏ. Р”РµСЂР¶Р°С‚СЊ
// РґРІРµ РєРѕРїРёРё РїСЂРёС…РѕРґРёС‚СЃСЏ РїРѕС‚РѕРјСѓ, С‡С‚Рѕ Functions СЃРѕР±РёСЂР°СЋС‚СЃСЏ РѕС‚РґРµР»СЊРЅРѕ РѕС‚
// С„СЂРѕРЅС‚РµРЅРґР° Рё РЅРµ РјРѕРіСѓС‚ РёРјРїРѕСЂС‚РёСЂРѕРІР°С‚СЊ РёР· src/. Р Р°СЃС…РѕР¶РґРµРЅРёРµ Р»РѕРІРёС‚СЃСЏ С‚РµСЃС‚РѕРј
// scripts/test-geo-block.mjs.
const BLOCKED = new Set(['IR', 'KP', 'SY', 'CU', 'RU', 'BY'])

// Р РµРіРёРѕРЅС‹ РЈРєСЂР°РёРЅС‹ РїРѕРґ СЃР°РЅРєС†РёСЏРјРё. Cloudflare РѕС‚РґР°С‘С‚ РґР»СЏ РЅРёС… country='UA',
// РїРѕСЌС‚РѕРјСѓ СЃС‚СЂР°РЅСѓ РѕС‚Р»РёС‡РёС‚СЊ РЅРµР»СЊР·СЏ вЂ” С‚РѕР»СЊРєРѕ РїРѕ РЅР°Р·РІР°РЅРёСЋ СЂРµРіРёРѕРЅР°.
const BLOCKED_UA_REGIONS = [
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

function blockedPage(country, reason) {
  // РЎС‚СЂР°РЅРёС†Р° РЅР° РґРІСѓС… СЏР·С‹РєР°С… СЃСЂР°Р·Сѓ: РѕРїСЂРµРґРµР»РёС‚СЊ СЏР·С‹Рє РїРѕР»СЊР·РѕРІР°С‚РµР»СЏ РјС‹ РјРѕР¶РµРј
  // С‚РѕР»СЊРєРѕ РїРѕ Accept-Language, Р° РѕРЅ РІСЂС‘С‚ С‡Р°С‰Рµ, С‡РµРј С…РѕС‡РµС‚СЃСЏ. Р”РІР° РєРѕСЂРѕС‚РєРёС…
  // Р°Р±Р·Р°С†Р° РґРµС€РµРІР»Рµ, С‡РµРј РЅРµРІРµСЂРЅРѕ РІС‹Р±СЂР°РЅРЅС‹Р№ СЏР·С‹Рє.
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>451 вЂ” Unavailable For Legal Reasons</title>
<style>
body{background:#0b0e11;color:#e6edf3;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px}
.box{max-width:440px;background:#161b22;border:1px solid #2a2f3a;border-radius:16px;padding:24px}
h1{font-size:17px;margin:0 0 12px;font-weight:700}
p{font-size:13px;color:#8b949e;margin:0 0 10px}
code{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#f0b90b}
</style>
</head>
<body>
<div class="box">
  <h1>451 вЂ” Unavailable For Legal Reasons</h1>
  <p>This service is not available in your jurisdiction (${country}). Access is restricted for legal and regulatory reasons.</p>
  <p>Р”РѕСЃС‚СѓРї РёР· РІР°С€РµР№ СЃС‚СЂР°РЅС‹ (${country}) РѕРіСЂР°РЅРёС‡РµРЅ РїРѕ СЋСЂРёРґРёС‡РµСЃРєРёРј РїСЂРёС‡РёРЅР°Рј.</p>
  <p style="margin-top:14px"><code>${reason}</code></p>
</div>
</body>
</html>`
  return new Response(html, {
    status: 451,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // 451 РЅРµ РёРЅРґРµРєСЃРёСЂСѓРµС‚СЃСЏ: РЅРµР·Р°С‡РµРј РїСѓСЃРєР°С‚СЊ СЂРѕР±РѕС‚РѕРІ РЅР° СЃС‚СЂР°РЅРёС†Сѓ РѕС‚РєР°Р·Р°.
      'x-robots-tag': 'noindex',
    },
  })
}

export async function onRequest(context) {
  const { request, next } = context
  const cf = request.cf ?? {}
  const country = typeof cf.country === 'string' ? cf.country.toUpperCase() : null

  // РќРµС‚ РґР°РЅРЅС‹С… Рѕ СЃС‚СЂР°РЅРµ вЂ” РїСЂРѕРїСѓСЃРєР°РµРј. Р­С‚Рѕ Р»РѕРєР°Р»СЊРЅР°СЏ СЂР°Р·СЂР°Р±РѕС‚РєР°, curl,
  // РјРѕРЅРёС‚РѕСЂРёРЅРі Рё С‡Р°СЃС‚СЊ Р±РѕС‚РѕРІ. Р‘Р»РѕРєРёСЂРѕРІР°С‚СЊ РїРѕ РѕС‚СЃСѓС‚СЃС‚РІРёСЋ РґР°РЅРЅС‹С… РЅРµР»СЊР·СЏ.
  if (!country) {
    const resp = await next()
    const headers = new Headers(resp.headers)
    headers.set('x-geo-middleware', 'active')
    headers.set('x-geo-country', 'none')
    return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers })
  }

  if (BLOCKED.has(country)) {
    const resp = blockedPage(country, 'blocked_country:' + country)
    // Р”РёР°РіРЅРѕСЃС‚РёС‡РµСЃРєРёР№ Р·Р°РіРѕР»РѕРІРѕРє РЅСѓР¶РµРЅ, С‡С‚РѕР±С‹ РѕС‚Р»РёС‡РёС‚СЊ В«middleware РЅРµ
    // Р·Р°РїСѓСЃС‚РёР»СЃСЏВ» РѕС‚ В«Р·Р°РїСѓСЃС‚РёР»СЃСЏ Рё РїСЂРѕРїСѓСЃС‚РёР»В». Р‘РµР· РЅРµРіРѕ РёР· СЃС‚СЂР°РЅС‹, РєРѕС‚РѕСЂРѕР№
    // РЅРµС‚ РІ СЃРїРёСЃРєРµ, РЅРµР»СЊР·СЏ РїРѕРЅСЏС‚СЊ, СЂР°Р±РѕС‚Р°РµС‚ Р»Рё Р±Р»РѕРєРёСЂРѕРІРєР° РІРѕРѕР±С‰Рµ: РѕС‚РІРµС‚
    // РІС‹РіР»СЏРґРёС‚ РѕРґРёРЅР°РєРѕРІРѕ РІ РѕР±РѕРёС… СЃР»СѓС‡Р°СЏС….
    resp.headers.set('x-geo-middleware', 'active')
    resp.headers.set('x-geo-country', country)
    return resp
  }

  // РЈРєСЂР°РёРЅР°: СЂР°Р·Р»РёС‡Р°РµРј СЂРµРіРёРѕРЅС‹, РїРѕС‚РѕРјСѓ С‡С‚Рѕ РљСЂС‹Рј Рё Р”РѕРЅР±Р°СЃСЃ РїСЂРёС…РѕРґСЏС‚ РєР°Рє UA.
  if (country === 'UA') {
    const hay = [cf.region, cf.regionCode]
      .filter((v) => typeof v === 'string')
      .join(' ')
      .toLowerCase()
    if (hay.trim() && BLOCKED_UA_REGIONS.some((n) => hay.includes(n))) {
      return blockedPage(country, 'blocked_region:' + (cf.region ?? cf.regionCode))
    }
  }

  const resp = await next()
  const headers = new Headers(resp.headers)
  headers.set('x-geo-middleware', 'active')
  headers.set('x-geo-country', country)
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers })
}