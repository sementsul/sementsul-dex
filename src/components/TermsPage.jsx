// Страница условий использования.
//
// Тексты в src/lib/terms.js, здесь только вёрстка. Так правка формулировки не
// требует трогать JSX, а проверка структуры документа делается тестом по
// данным, а не по разметке.

import { TERMS, TERMS_VERSION, TERMS_SUMMARY } from '../lib/terms.js'
import { useI18n } from '../lib/useI18n.jsx'

export default function TermsPage({ onBack }) {
  const { lang, t } = useI18n()
  const sections = TERMS[lang] ?? TERMS.ru
  const summary = TERMS_SUMMARY[lang] ?? TERMS_SUMMARY.ru

  return (
    <div className="page">
      {onBack && (
        <button className="back-btn" onClick={onBack}>
          {t('terms.back')}
        </button>
      )}

      <h1 className="page-title">{t('terms.title')}</h1>
      <p className="page-sub">{t('terms.sub', { version: TERMS_VERSION })}</p>

      {/* Сводка: то, что действительно надо понять до подписи транзакции.
          Полный текст ниже читают единицы, а эти четыре пункта — все. */}
      <div className="card terms-summary">
        <ul>
          {summary.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      </div>

      <article className="kb-article terms-article">
        {sections.map((s) => (
          <section key={s.id}>
            <h2>{s.title}</h2>
            {s.paragraphs.map((text, i) => (
              <p key={i}>{text}</p>
            ))}
          </section>
        ))}
      </article>

      <div className="page-note">
        <strong>{t('terms.contactTitle')}</strong> {t('terms.contactPre')}{' '}
        <a href="https://github.com/sementsul/sementsul-dex" target="_blank" rel="noreferrer">
          {t('terms.contactLink')}
        </a>
        {t('terms.contactPost')}
      </div>

      <p className="fine-print">{t('terms.finePrint')}</p>
    </div>
  )
}