# Translating DEADBOARD

The app's text is translated with one file per language in `src/i18n/`. English is the source:
every string in the code is written in English and that English text is the key.

```ts
t('Run tests')                                   // → 'Проверить'
t('Loaded {title}', { title })                   // placeholders in {braces}
t('{n} part|{n} parts', { n })                   // plurals: English one|other, the count is n
```

## Add a language

1. Copy `src/i18n/ru.ts` to `src/i18n/<code>.ts` (`de`, `es`, `pt`, …) and translate the values.
   Leave the keys (left side) exactly as they are.
2. Register it in `src/i18n/index.ts`: add `{ code, name }` to `LANGUAGES` (the name in its own
   language, e.g. `Deutsch`) and a loader line to `LOADERS`.
3. Run `npm test`. To require the language to be complete, add it to `MAINTAINED` in
   `test/i18n.test.ts`. A partial language works too: missing strings show in English.
4. Try it: `app.html?lang=<code>`, or the language picker in the top bar, in Help, and in the
   phone's More sheet.

## Rules for a translation

- **Placeholders** (`{ref}`, `{n}`, `{title}`) stay as they are; you can move them anywhere in the
  sentence. The test fails if one is missing or misspelt.
- **HTML tags** (`<b>`, `<code>`, `<a …>`) stay, in the same order. Translate the text around and
  inside them.
- **Plurals**: give one form per plural category of the language, as `Intl.PluralRules` names them
  (English and German: `one`, `other`; Russian: `one`, `few`, `many`, `other`). The test lists what
  is missing.
- **No straight double quotes** (`"`) unless the English has them: many strings end up in HTML
  attributes. Use the language's own quotes («», „“).
- **Units** in sentences follow the language (Russian: В, мА, Ом). Instrument faces (the meter's
  display, the supply's VOLTS / AMPS, the scope's V/div) keep the Latin units of real instruments.
- **Phones**: English is rewritten for touch automatically ("click" becomes "tap"). Translations
  are shown as written on every device, so pick wording that works for mouse and finger alike
  (Russian «нажмите» fits both).
- **Short labels**: buttons, tabs and the phone's tool strip have little room. Check the top bar
  at 1280 px wide and the phone layout (`?mobile=1`, landscape) after translating.

## What is translated

- The whole app UI: top bar, tools, panels, instruments, toasts, help, feedback form.
- The built-in lessons, challenges and demo boards (titles, descriptions, notes) and the
  interactive tutorial steps. They are English in their own files and translated where shown.
- Simulator messages: meter notes, test results, overloads, fault and rework messages, scope notes.

Not translated: the board itself (silkscreen, part references, net names), boards and mods made by
players, the website pages (`index.html`, `modding.html`, `privacy.html`), and the technical
details in bug reports, which the developer reads.

## When the English changes

Changing an English string in the code makes its old translation stale. `npm test` then lists the
new string as untranslated and the old entry as left over for every language in `MAINTAINED`.
Move the translation to the new key and update it.
