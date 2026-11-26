// React-обвязка над i18n.js: контекст языка и хук t().
//
// Язык живёт в состоянии провайдера, а не в каждом компоненте: переключатель
// один, а читателей много, и дублировать состояние значило бы рассинхронизировать
// их при переключении.
//
// Побочный эффект, который важен и легко забывается: при смене языка меняется
// <html lang>. Без этого браузер продолжает считать страницу русской и,
// например, предлагает перевод или озвучивает английский текст русскими
// правилами.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { loadLang, saveLang, applyDocumentLang, translate, LANGS } from './i18n.js'

const LangContext = createContext(null)

export function LangProvider({ children }) {
  const [lang, setLangState] = useState(() => loadLang())

  useEffect(() => {
    applyDocumentLang(lang)
  }, [lang])

  const setLang = useCallback((next) => {
    if (!LANGS.includes(next)) return
    saveLang(next)
    setLangState(next)
  }, [])

  const value = useMemo(() => {
    const t = (key, params) => translate(lang, key, params)
    return { lang, setLang, t }
  }, [lang, setLang])

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>
}

/// Хук перевода. Возвращает { lang, setLang, t }.
///
/// Вне провайдера не бросает ошибку, а отдаёт русский: компонент, случайно
/// отрендеренный без провайдера (например, в тесте), должен показать текст,
/// а не упасть.
export function useI18n() {
  const ctx = useContext(LangContext)
  if (ctx) return ctx
  return {
    lang: 'ru',
    setLang: () => {},
    t: (key, params) => translate('ru', key, params),
  }
}