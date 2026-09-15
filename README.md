# Upskill — wybrane wzorce implementacyjne (LMS SaaS)

Zestaw **zanonimizowanych fragmentów kodu** z komercyjnej platformy edukacyjnej
SaaS (LMS) do zarządzania szkoleniami i certyfikacją, którą zaprojektowałem i
zbudowałem (frontend, backend, baza danych, logika, testy).

To **nie jest pełna aplikacja** — to celowo dobrany przekrój pokazujący *sposób
implementacji*: połączenie z bazą, model uprawnień egzekwowany przez RLS, silnik
testów wiedzy, obsługa plików przez podpisane URL-e oraz struktura ekranów.
Nazwy domenowe zostały zneutralizowane, a dane, sekrety i identyfikatory usunięte.

> **Kontekst:** oryginalny system jest objęty poufnością. Publikuję jedynie
> wzorce architektoniczne i własny styl implementacji — bez danych i bez
> konfiguracji produkcyjnej.

---

## Co pokazuje ten kod

| Obszar | Plik(i) | Co demonstruje |
|---|---|---|
| **Połączenie z bazą (Supabase)** | `lib/supabase/{server,client,middleware}.ts` | klient SSR (cookies) + klient service-role omijający RLS |
| **Uwierzytelnianie i role** | `lib/auth.ts`, `middleware.ts` | sesja, `requireUser` / `requireRole`, role uczestnik / trener / administrator |
| **Silnik testów wiedzy** | `lib/test-engine.ts`, `app/actions/test-actions.ts` | serwerowy limit czasu, deterministyczne losowanie pytań per podejście, autozapis (upsert), auto-ocena pytań zamkniętych, **poprawne odpowiedzi nigdy nie trafiają do klienta** |
| **Pliki przez podpisany URL** | `app/actions/submissions.ts`, `lib/submission-rules.ts` | walidacja, wstawienie wiersza pod RLS + bezpośredni upload/pobranie przez krótkotrwały signed URL (Supabase Storage) |
| **Logika ocen** | `lib/grade-calc.ts` | wynik procentowy z kryteriów i dobór oceny z progów skali |
| **Raporty / eksport CSV** | `lib/report-export.ts` | CSV z BOM i separatorem `;` — poprawne polskie znaki w Excelu |
| **Ekran (RSC)** | `app/dashboard/page.tsx` | pulpit uczestnika: równoległe zapytania (Promise.all), KPI liczone serwerowo |
| **Baza danych + RLS** | `db/schema.sql`, `db/rls-policies.sql` | schemat i polityki RLS z rozdzieleniem ról; sanityzacja banku pytań |

## Stack

Next.js (App Router, RSC + Server Actions) · React · TypeScript · Tailwind · shadcn/ui
· Supabase (PostgreSQL, Auth, Storage, RLS) · Vitest · Playwright · Vercel

## Uruchomienie (opcjonalnie)

```bash
cp .env.example .env.local   # uzupełnij własnymi kluczami
pnpm install
pnpm dev
```

Schemat i polityki RLS znajdziesz w `db/`.

---

Autor: **Sebastian Wacek** — Fullstack / Frontend Developer
