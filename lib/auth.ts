import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

// Role platformy (rozdzielenie obowiązków):
//   uczestnik     → uczy się, rozwiązuje testy, widzi tylko swoje dane
//   trener        → prowadzi szkolenia, ocenia, zarządza swoimi kursami
//   administrator → zarządza kontami i całą platformą
export type AppRole = 'administrator' | 'trener' | 'uczestnik'

export interface SessionUser {
  id: string
  email: string | null
  role: AppRole
  fullName: string | null
}

/** Zwraca zalogowanego użytkownika z rolą (z profiles) albo null. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, full_name, email')
    .eq('id', user.id)
    .single()

  return {
    id: user.id,
    email: profile?.email ?? user.email ?? null,
    role: (profile?.role as AppRole) ?? 'uczestnik',
    fullName: profile?.full_name ?? null,
  }
}

/** Wymusza zalogowanie — przekierowuje na /login, jeśli brak sesji. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser()
  if (!user) redirect('/login')
  return user
}

/** Wymusza konkretną rolę (lub jedną z listy) — inaczej przekierowuje. */
export async function requireRole(roles: AppRole | AppRole[]): Promise<SessionUser> {
  const user = await requireUser()
  const allowed = Array.isArray(roles) ? roles : [roles]
  if (!allowed.includes(user.role)) redirect('/')
  return user
}
