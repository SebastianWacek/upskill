'use server'

import { revalidatePath } from 'next/cache'
import { createServiceClient } from '@/lib/supabase/server'
import { requireRole } from '@/lib/auth'
import { currentParticipantContext, computeAndFinalize } from '@/lib/test-engine'
import type { AssessmentRow, AttemptRow, AttemptAnswerRow, TestQuestionGradingRow } from '@/lib/types/rows'

export interface StartResult { ok: boolean; error?: string; attemptId?: string }
export interface SaveResult { ok: boolean; error?: string }
export interface SubmitResult { ok: boolean; error?: string; finalized?: boolean; percent?: number; grade?: string | null }

type StartAssessmentRow = Pick<AssessmentRow, 'id' | 'course_offering_id' | 'available_from' | 'available_to' | 'max_attempts'>
type StartAttemptRow = Pick<AttemptRow, 'id' | 'attempt_no' | 'status'>
type SaveAttemptRow = Pick<AttemptRow, 'id' | 'participant_id' | 'assessment_id' | 'status' | 'started_at'>
type SubmitAttemptRow = Pick<AttemptRow, 'id' | 'assessment_id' | 'participant_id' | 'status'>
type SubmitAnswerRow = Pick<AttemptAnswerRow, 'id' | 'test_question_id' | 'test_answer_id' | 'answer_multi'>

/** Rozpocznij (lub wznów) podejście do testu. */
export async function startAttempt(assessmentId: string): Promise<StartResult> {
  await requireRole(['uczestnik'])
  const ctx = await currentParticipantContext()
  if (!ctx) return { ok: false, error: 'Brak powiązanego konta uczestnika.' }
  const svc = createServiceClient()

  const { data: aData } = await svc.from('assessments')
    .select('id, course_offering_id, available_from, available_to, max_attempts')
    .eq('id', assessmentId).maybeSingle()
  if (!aData) return { ok: false, error: 'Nie znaleziono testu.' }
  const a = aData as unknown as StartAssessmentRow

  const { data: enr } = await svc.from('course_enrollments').select('id')
    .eq('participant_id', ctx.participantId).eq('course_offering_id', a.course_offering_id).neq('status', 'withdrawn').maybeSingle()
  if (!enr) return { ok: false, error: 'Nie jesteś zapisany na to szkolenie.' }

  const now = Date.now()
  if (a.available_from && new Date(a.available_from).getTime() > now) return { ok: false, error: 'Test jeszcze się nie rozpoczął.' }
  if (a.available_to && new Date(a.available_to).getTime() < now) return { ok: false, error: 'Okno na rozwiązanie testu jest zamknięte.' }

  const { data: attemptsData } = await svc.from('test_attempts')
    .select('id, attempt_no, status').eq('assessment_id', assessmentId).eq('participant_id', ctx.participantId)
    .order('attempt_no', { ascending: false })
  const attempts = (attemptsData ?? []) as unknown as StartAttemptRow[]
  const active = attempts.find((t) => t.status === 'in_progress')
  if (active) return { ok: true, attemptId: active.id } // wznów

  const used = attempts.length
  const maxA = a.max_attempts
  if (maxA && used >= maxA) return { ok: false, error: 'Wykorzystałeś dostępną liczbę podejść.' }

  const ins = await svc.from('test_attempts')
    .insert({ assessment_id: assessmentId, participant_id: ctx.participantId, attempt_no: used + 1, status: 'in_progress', started_at: new Date().toISOString() })
    .select('id').single()
  if (ins.error) return { ok: false, error: ins.error.message }
  const inserted = ins.data as unknown as Pick<AttemptRow, 'id'>
  return { ok: true, attemptId: inserted.id }
}

/** Autozapis pojedynczej odpowiedzi. */
export async function saveAnswer(
  attemptId: string, questionId: string,
  payload: { test_answer_id?: string | null; answer_multi?: string[] | null; answer_open?: string | null },
): Promise<SaveResult> {
  await requireRole(['uczestnik'])
  const ctx = await currentParticipantContext()
  if (!ctx) return { ok: false, error: 'Brak dostępu.' }
  const svc = createServiceClient()

  const { data: attData } = await svc.from('test_attempts')
    .select('id, participant_id, assessment_id, status, started_at').eq('id', attemptId).maybeSingle()
  const att = (attData ?? null) as unknown as SaveAttemptRow | null
  if (!att || att.participant_id !== ctx.participantId) return { ok: false, error: 'Brak dostępu.' }
  if (att.status !== 'in_progress') return { ok: false, error: 'Test został już oddany.' }

  const { data: aData } = await svc.from('assessments').select('time_limit_minutes').eq('id', att.assessment_id).maybeSingle()
  const a = (aData ?? null) as unknown as Pick<AssessmentRow, 'time_limit_minutes'> | null
  if (a?.time_limit_minutes) {
    const elapsedMin = (Date.now() - new Date(att.started_at).getTime()) / 60000
    if (elapsedMin > a.time_limit_minutes) return { ok: false, error: 'Czas na rozwiązanie testu minął.' }
  }

  const { data: q } = await svc.from('test_questions').select('id').eq('id', questionId).eq('assessment_id', att.assessment_id).maybeSingle()
  if (!q) return { ok: false, error: 'Nieprawidłowe pytanie.' }

  const row = {
    attempt_id: attemptId,
    test_question_id: questionId,
    test_answer_id: payload.test_answer_id ?? null,
    answer_multi: payload.answer_multi ?? null,
    answer_open: payload.answer_open ?? null,
    points: null as number | null,
  }
  // upsert po unikacie (attempt_id, test_question_id) — idempotentny autozapis
  const r = await svc.from('attempt_answers').upsert(row, { onConflict: 'attempt_id,test_question_id' })
  if (r.error) return { ok: false, error: r.error.message }
  return { ok: true }
}

/** Oddanie testu: auto-ocena pytań zamkniętych; finalizacja gdy brak otwartych. */
export async function submitAttempt(attemptId: string): Promise<SubmitResult> {
  await requireRole(['uczestnik'])
  const ctx = await currentParticipantContext()
  if (!ctx) return { ok: false, error: 'Brak dostępu.' }
  const svc = createServiceClient()

  const { data: attData } = await svc.from('test_attempts')
    .select('id, assessment_id, participant_id, status').eq('id', attemptId).maybeSingle()
  const att = (attData ?? null) as unknown as SubmitAttemptRow | null
  if (!att || att.participant_id !== ctx.participantId) return { ok: false, error: 'Brak dostępu.' }
  if (att.status !== 'in_progress') return { ok: true, finalized: att.status === 'graded' }

  const assessmentId = att.assessment_id
  const { data: qsData } = await svc.from('test_questions')
    .select('id, type, points, test_answers(id, is_correct)').eq('assessment_id', assessmentId)
  const { data: saData } = await svc.from('attempt_answers')
    .select('id, test_question_id, test_answer_id, answer_multi').eq('attempt_id', attemptId)
  const qs = (qsData ?? []) as unknown as TestQuestionGradingRow[]
  const sa = (saData ?? []) as unknown as SubmitAnswerRow[]
  const saMap = new Map(sa.map((x) => [x.test_question_id, x]))

  let hasOpen = false
  for (const q of qs) {
    if (q.type === 'open') { hasOpen = true; continue }
    const ans = saMap.get(q.id)
    const correctIds = new Set((q.test_answers ?? []).filter((o) => o.is_correct).map((o) => o.id))
    let ok = false
    if (q.type === 'single') {
      ok = !!ans?.test_answer_id && correctIds.size === 1 && correctIds.has(ans.test_answer_id)
    } else {
      const chosen = new Set<string>(Array.isArray(ans?.answer_multi) ? ans.answer_multi : [])
      ok = chosen.size > 0 && chosen.size === correctIds.size && [...correctIds].every((id) => chosen.has(id))
    }
    const pts = ok ? Number(q.points) : 0
    if (ans) await svc.from('attempt_answers').update({ points: pts }).eq('id', ans.id)
    else await svc.from('attempt_answers').insert({ attempt_id: attemptId, test_question_id: q.id, points: pts })
  }
  // pytania otwarte: upewnij się, że mają wiersz (punkty NULL = do oceny)
  for (const q of qs) {
    if (q.type === 'open' && !saMap.has(q.id)) {
      await svc.from('attempt_answers').insert({ attempt_id: attemptId, test_question_id: q.id })
    }
  }

  await svc.from('test_attempts').update({ submitted_at: new Date().toISOString(), status: 'submitted' }).eq('id', attemptId)

  let result: SubmitResult = { ok: true, finalized: false }
  if (!hasOpen) {
    const r = await computeAndFinalize(svc, attemptId, null)
    result = { ok: true, finalized: true, percent: r.percent, grade: r.grade }
  }
  revalidatePath('/dashboard')
  revalidatePath('/testy')
  return result
}
