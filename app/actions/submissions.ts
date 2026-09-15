'use server'

import { randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { requireUser } from '@/lib/auth'
import { extOf, safeFileName, validateNewFile, SUBMISSIONS_BUCKET, type FileRequirements } from '@/lib/submission-rules'

export interface UploadMeta { name: string; size: number; type: string }
export interface RegisterUploadResult { ok: boolean; error?: string; fileId?: string; path?: string; token?: string }
export interface SimpleResult { ok: boolean; error?: string }
export interface DownloadResult { ok: boolean; error?: string; url?: string }

interface AssessmentCtxRow {
  id: string
  course_offering_id: string
  status: string
  submission_deadline: string | null
  assessment_file_requirements: FileRequirements | FileRequirements[] | null
}

const rlsMsg = (m: string, fallback: string) =>
  /row-level security|permission denied/i.test(m) ? fallback : m

/**
 * Krok 1 uploadu: waliduje plik, zakłada wiersz w assessment_files
 * (RLS pilnuje: uczestnik tylko swoje, przed terminem; trener/administrator — swoje szkolenia)
 * i zwraca podpisany URL do bezpośredniego uploadu z przeglądarki.
 * `forParticipantId` — tylko dla trenera/administratora.
 */
export async function registerUpload(
  assessmentId: string,
  meta: UploadMeta,
  forParticipantId?: string | null,
): Promise<RegisterUploadResult> {
  const user = await requireUser()
  const supabase = await createClient()

  const { data: a } = await supabase
    .from('assessments')
    .select('id, course_offering_id, status, submission_deadline, assessment_file_requirements(allowed_extensions, max_size_mb, max_file_count)')
    .eq('id', assessmentId).maybeSingle()
  if (!a) return { ok: false, error: 'Nie znaleziono zadania.' }
  const ctx = a as unknown as AssessmentCtxRow
  const req = Array.isArray(ctx.assessment_file_requirements)
    ? ctx.assessment_file_requirements[0] ?? null
    : ctx.assessment_file_requirements

  let participantId: string | null
  if (user.role === 'uczestnik') {
    const { data: me } = await supabase.from('participants').select('id').maybeSingle()
    participantId = (me as { id: string } | null)?.id ?? null
    if (!participantId) return { ok: false, error: 'Twoje konto nie jest powiązane z rekordem uczestnika.' }
    if (!['open', 'grading'].includes(ctx.status)) return { ok: false, error: 'To zadanie nie przyjmuje już prac.' }
    if (ctx.submission_deadline && new Date(ctx.submission_deadline) < new Date())
      return { ok: false, error: 'Termin oddania pracy minął.' }
  } else {
    participantId = forParticipantId ?? null
    if (!participantId) return { ok: false, error: 'Wskaż uczestnika, dla którego wgrywasz plik.' }
  }

  const { count } = await supabase
    .from('assessment_files')
    .select('id', { count: 'exact', head: true })
    .eq('assessment_id', assessmentId).eq('participant_id', participantId)
  const err = validateNewFile(meta, req, count ?? 0)
  if (err) return { ok: false, error: err }

  const fileId = randomUUID()
  const path = `${ctx.course_offering_id}/${assessmentId}/${participantId}/${fileId}.${extOf(meta.name)}`

  const ins = await supabase.from('assessment_files').insert({
    id: fileId,
    assessment_id: assessmentId,
    participant_id: participantId,
    storage_path: path,
    original_name: meta.name.slice(0, 255),
    size_bytes: meta.size,
    mime_type: meta.type || null,
    uploaded_by: user.id,
  })
  if (ins.error)
    return { ok: false, error: rlsMsg(ins.error.message, 'Nie możesz wgrać pliku do tego zadania (termin minął lub brak uprawnień).') }

  const svc = createServiceClient()
  const { data: signed, error: sErr } = await svc.storage.from(SUBMISSIONS_BUCKET).createSignedUploadUrl(path)
  if (sErr || !signed) {
    await svc.from('assessment_files').delete().eq('id', fileId)
    return { ok: false, error: sErr?.message ?? 'Nie udało się przygotować uploadu.' }
  }
  return { ok: true, fileId, path, token: signed.token }
}

/** Krok 2 uploadu (opcjonalny): potwierdzenie — odświeża widoki. */
export async function confirmUpload(assessmentId: string, offeringId: string): Promise<SimpleResult> {
  await requireUser()
  revalidatePath(`/zadania/${assessmentId}`)
  revalidatePath(`/szkolenia/${offeringId}`)
  return { ok: true }
}

/** Usuwa plik (wiersz przez RLS użytkownika, obiekt przez service_role). */
export async function deleteSubmissionFile(fileId: string): Promise<SimpleResult> {
  await requireUser()
  const supabase = await createClient()
  const { data: del, error } = await supabase
    .from('assessment_files').delete().eq('id', fileId).select('storage_path, assessment_id')
  if (error) return { ok: false, error: rlsMsg(error.message, 'Nie można usunąć pliku.') }
  const row = (del ?? [])[0] as { storage_path: string; assessment_id: string } | undefined
  if (!row) return { ok: false, error: 'Nie można usunąć pliku — termin minął, praca jest już oceniona albo plik nie należy do Ciebie.' }
  const svc = createServiceClient()
  await svc.storage.from(SUBMISSIONS_BUCKET).remove([row.storage_path])
  revalidatePath(`/zadania/${row.assessment_id}`)
  return { ok: true }
}

/** Podpisany URL pobrania (120 s). Uprawnienie = widoczność wiersza przez RLS. */
export async function getSubmissionDownloadUrl(fileId: string): Promise<DownloadResult> {
  await requireUser()
  const supabase = await createClient()
  const { data } = await supabase
    .from('assessment_files').select('storage_path, original_name').eq('id', fileId).maybeSingle()
  const row = data as { storage_path: string; original_name: string | null } | null
  if (!row) return { ok: false, error: 'Brak dostępu do pliku.' }
  const svc = createServiceClient()
  const { data: signed, error } = await svc.storage
    .from(SUBMISSIONS_BUCKET)
    .createSignedUrl(row.storage_path, 120, { download: safeFileName(row.original_name ?? 'plik') })
  if (error || !signed) return { ok: false, error: error?.message ?? 'Nie udało się przygotować pobrania.' }
  return { ok: true, url: signed.signedUrl }
}
