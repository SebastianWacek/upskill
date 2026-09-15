// Pulpit uczestnika (React Server Component). Dane pobierane równolegle po
// stronie serwera; RLS zawęża wszystko do zalogowanego uczestnika. KPI i postęp
// liczone serwerowo — klient dostaje gotowe liczby.
import { requireRole } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'

interface EnrollmentRow {
  status: string
  progress_percent: number | null
  course_offerings: { code: string; courses: { name: string } | null } | null
}
interface CertificateRow {
  issued_at: string
  valid_until: string | null
  course_offerings: { courses: { name: string } | null } | null
}

export default async function DashboardPage() {
  await requireRole(['uczestnik'])
  const supabase = await createClient()

  // Odczyty równolegle — RLS pilnuje, że to dane bieżącego uczestnika.
  const [{ data: enrData }, { data: certData }] = await Promise.all([
    supabase
      .from('course_enrollments')
      .select('status, progress_percent, course_offerings(code, courses(name))')
      .neq('status', 'withdrawn'),
    supabase
      .from('certificates')
      .select('issued_at, valid_until, course_offerings(courses(name))')
      .order('issued_at', { ascending: false }),
  ])

  const enrollments = (enrData ?? []) as unknown as EnrollmentRow[]
  const certificates = (certData ?? []) as unknown as CertificateRow[]

  const assigned = enrollments.length
  const toComplete = enrollments.filter((e) => e.status !== 'completed').length
  const avgProgress = assigned
    ? Math.round(enrollments.reduce((s, e) => s + (e.progress_percent ?? 0), 0) / assigned)
    : 0
  const inProgress = enrollments
    .filter((e) => e.status !== 'completed' && (e.progress_percent ?? 0) > 0)
    .sort((a, b) => (b.progress_percent ?? 0) - (a.progress_percent ?? 0))

  return (
    <main className="mx-auto max-w-4xl p-6 space-y-8">
      <section className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Kpi label="Przypisane szkolenia" value={assigned} />
        <Kpi label="Do ukończenia" value={toComplete} />
        <Kpi label="Certyfikaty" value={certificates.length} />
        <Kpi label="Średni postęp" value={`${avgProgress}%`} />
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">Kontynuuj naukę</h2>
        {inProgress.length === 0 ? (
          <p className="text-sm text-neutral-400">Brak rozpoczętych szkoleń.</p>
        ) : (
          <ul className="space-y-2">
            {inProgress.map((e, i) => (
              <li key={i} className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">{e.course_offerings?.courses?.name ?? e.course_offerings?.code ?? '—'}</span>
                  <span className="text-neutral-500">{e.progress_percent ?? 0}%</span>
                </div>
                <div className="mt-2 h-1.5 w-full rounded-full bg-neutral-200 dark:bg-neutral-800">
                  <div className="h-1.5 rounded-full bg-indigo-500" style={{ width: `${e.progress_percent ?? 0}%` }} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {certificates[0] && (
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">Ostatni certyfikat</h2>
          <div className="rounded-lg border border-neutral-200 p-3 text-sm dark:border-neutral-800">
            <div className="font-medium">{certificates[0].course_offerings?.courses?.name ?? '—'}</div>
            <div className="text-neutral-500">
              Wydany {new Date(certificates[0].issued_at).toLocaleDateString('pl-PL')}
              {certificates[0].valid_until && ` · ważny do ${new Date(certificates[0].valid_until).toLocaleDateString('pl-PL')}`}
            </div>
          </div>
        </section>
      )}
    </main>
  )
}

function Kpi({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </div>
  )
}
