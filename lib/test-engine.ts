import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/server'
import { getSessionUser } from '@/lib/auth'
import { findGrade, type ScaleRow } from '@/lib/grade-calc'
import type {
  ParticipantRow, TestIntroAssessmentRow, TestQuestionRow, AttemptRow, AttemptSummaryRow, ResultPercentRow,
  SolveAssessmentRow, TestQuestionWithOptionsRow, AttemptAnswerRow, AssessmentRow, GradeScaleRow,
} from '@/lib/types/rows'

// ── Deterministyczne losowanie (stabilne per podejście, różne u każdego uczestnika) ──
function hash(str: string): number {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}
export function seededOrder<T>(items: T[], keyOf: (t: T) => string, seed: string): T[] {
  return items
    .map((it) => ({ it, k: hash(seed + '|' + keyOf(it)), key: keyOf(it) }))
    .sort((a, b) => (a.k - b.k) || a.key.localeCompare(b.key))
    .map((x) => x.it)
}

// ── Kontekst uczestnika ──
export interface ParticipantCtx { userId: string; participantId: string }
export async function currentParticipantContext(): Promise<ParticipantCtx | null> {
  const user = await getSessionUser()
  if (!user) return null
  const svc = createServiceClient()
  const { data } = await svc.from('participants').select('id').eq('profile_id', user.id).is('deleted_at', null).maybeSingle()
  if (!data) return null
  const participant = data as unknown as Pick<ParticipantRow, 'id'>
  return { userId: user.id, participantId: participant.id }
}

async function enrolled(svc: SupabaseClient, participantId: string, offeringId: string): Promise<boolean> {
  const { data } = await svc.from('course_enrollments').select('id')
    .eq('participant_id', participantId).eq('course_offering_id', offeringId).neq('status', 'withdrawn').maybeSingle()
  return !!data
}

// ── Ekran wejściowy testu ──
export interface TestIntro {
  assessment: {
    id: string; name: string; offeringId: string; code: string; courseName: string | null; term: number
    timeLimit: number | null; availableFrom: string | null; availableTo: string | null; maxAttempts: number | null
    questionCount: number; totalPoints: number; hasOpen: boolean
  }
  attempts: { id: string; attempt_no: number; started_at: string; submitted_at: string | null; status: string; total_points: number | null }[]
  windowOpen: boolean
  windowMsg: string | null
  attemptsLeft: number | null
  activeAttemptId: string | null
  myResult: { percent: number; grade: string | null } | null
}

export async function getTestIntro(assessmentId: string): Promise<TestIntro | null> {
  const me = await currentParticipantContext()
  if (!me) return null
  const svc = createServiceClient()
  const { data: aData } = await svc.from('assessments')
    .select('id, name, term, course_offering_id, time_limit_minutes, available_from, available_to, max_attempts, assessment_forms(kind), course_offerings(code, courses(name))')
    .eq('id', assessmentId).maybeSingle()
  if (!aData) return null
  const a = aData as unknown as TestIntroAssessmentRow
  const off = a.course_offering_id
  if (!(await enrolled(svc, me.participantId, off))) return null

  const { data: qsData } = await svc.from('test_questions').select('id, points, type').eq('assessment_id', assessmentId)
  const qs = (qsData ?? []) as unknown as Pick<TestQuestionRow, 'id' | 'points' | 'type'>[]
  const totalPoints = qs.reduce((s, q) => s + Number(q.points), 0)
  const hasOpen = qs.some((q) => q.type === 'open')

  const { data: attemptsData } = await svc.from('test_attempts')
    .select('id, attempt_no, started_at, submitted_at, status, total_points')
    .eq('assessment_id', assessmentId).eq('participant_id', me.participantId).order('attempt_no', { ascending: true })
  const attempts = (attemptsData ?? []) as unknown as AttemptSummaryRow[]

  const now = Date.now()
  const from = a.available_from ? new Date(a.available_from).getTime() : null
  const to = a.available_to ? new Date(a.available_to).getTime() : null
  let windowOpen = true, windowMsg: string | null = null
  if (from && from > now) { windowOpen = false; windowMsg = 'Test jeszcze się nie rozpoczął.' }
  else if (to && to < now) { windowOpen = false; windowMsg = 'Okno na rozwiązanie testu jest już zamknięte.' }

  const used = attempts.length
  const maxA = a.max_attempts
  const attemptsLeft = maxA ? Math.max(0, maxA - used) : null
  const active = attempts.find((t) => t.status === 'in_progress')

  const { data: resData } = await svc.from('assessment_results')
    .select('percent_score, grade_scales(grade_label)')
    .eq('assessment_id', assessmentId).eq('participant_id', me.participantId).maybeSingle()
  const res = (resData ?? null) as unknown as ResultPercentRow | null

  return {
    assessment: {
      id: a.id, name: a.name, offeringId: off,
      code: a.course_offerings?.code ?? '', courseName: a.course_offerings?.courses?.name ?? null,
      term: a.term, timeLimit: a.time_limit_minutes ?? null,
      availableFrom: a.available_from ?? null, availableTo: a.available_to ?? null,
      maxAttempts: maxA, questionCount: qs.length, totalPoints, hasOpen,
    },
    attempts,
    windowOpen, windowMsg, attemptsLeft, activeAttemptId: active?.id ?? null,
    myResult: res ? { percent: Number(res.percent_score), grade: res.grade_scales?.grade_label ?? null } : null,
  }
}

// ── Widok rozwiązywania (sanityzowany: BEZ is_correct) ──
export interface SolveQuestion {
  id: string; question: string; type: 'single' | 'multiple' | 'open'; points: number
  options: { id: string; content: string }[]
  saved: { test_answer_id: string | null; answer_multi: string[] | null; answer_open: string | null }
}
export interface SolveView {
  attemptId: string; assessmentId: string; assessmentName: string; code: string
  timeLimitSec: number | null; timeLeftSec: number | null; expired: boolean
  questions: SolveQuestion[]; submitted: boolean
}

type SolveAttemptRow = Pick<AttemptRow, 'id' | 'assessment_id' | 'participant_id' | 'started_at' | 'submitted_at' | 'status'>
type SavedAnswerRow = Pick<AttemptAnswerRow, 'test_question_id' | 'test_answer_id' | 'answer_multi' | 'answer_open'>

export async function getAttemptForSolving(attemptId: string): Promise<SolveView | null> {
  const me = await currentParticipantContext()
  if (!me) return null
  const svc = createServiceClient()
  const { data: attData } = await svc.from('test_attempts')
    .select('id, assessment_id, participant_id, started_at, submitted_at, status').eq('id', attemptId).maybeSingle()
  const att = (attData ?? null) as unknown as SolveAttemptRow | null
  if (!att || att.participant_id !== me.participantId) return null
  const assessmentId = att.assessment_id

  const [{ data: aData }, { data: qsData }, { data: savedData }] = await Promise.all([
    svc.from('assessments').select('name, time_limit_minutes, course_offerings(code)').eq('id', assessmentId).maybeSingle(),
    svc.from('test_questions').select('id, question, type, points, test_answers(id, content)').eq('assessment_id', assessmentId),
    svc.from('attempt_answers').select('test_question_id, test_answer_id, answer_multi, answer_open').eq('attempt_id', attemptId),
  ])
  const a = (aData ?? null) as unknown as SolveAssessmentRow | null
  const qs = (qsData ?? []) as unknown as TestQuestionWithOptionsRow[]
  const saved = (savedData ?? []) as unknown as SavedAnswerRow[]

  const savedMap = new Map(saved.map((s) => [s.test_question_id, s]))
  const ordered = seededOrder(qs, (q) => q.id, attemptId)
  const questions: SolveQuestion[] = ordered.map((q) => {
    const s = savedMap.get(q.id)
    return {
      id: q.id, question: q.question, type: q.type, points: Number(q.points),
      options: q.type === 'open' ? [] : seededOrder(q.test_answers ?? [], (o) => o.id, attemptId + ':' + q.id).map((o) => ({ id: o.id, content: o.content })),
      saved: {
        test_answer_id: s?.test_answer_id ?? null,
        answer_multi: Array.isArray(s?.answer_multi) ? s.answer_multi : null,
        answer_open: s?.answer_open ?? null,
      },
    }
  })

  const limitMin = a?.time_limit_minutes ?? null
  const timeLimitSec = limitMin ? limitMin * 60 : null
  let timeLeftSec: number | null = null
  let expired = false
  if (timeLimitSec) {
    const elapsed = (Date.now() - new Date(att.started_at).getTime()) / 1000
    timeLeftSec = Math.max(0, Math.round(timeLimitSec - elapsed))
    expired = timeLeftSec <= 0
  }
  return {
    attemptId, assessmentId, assessmentName: a?.name ?? 'Test', code: a?.course_offerings?.code ?? '',
    timeLimitSec, timeLeftSec, expired,
    questions, submitted: att.status !== 'in_progress',
  }
}

// ── Przegląd podejścia dla UCZESTNIKA (sanityzowany: bez is_correct) ──
export interface ReviewQuestion {
  id: string; question: string; type: 'single' | 'multiple' | 'open'; maxPoints: number
  /** treści zaznaczonych opcji (pytania zamknięte) */
  selected: string[]
  answerOpen: string | null
  /** przyznane punkty (null = pytanie otwarte jeszcze nieocenione) */
  points: number | null
}
export interface AttemptReview {
  attemptId: string; assessmentId: string; assessmentName: string; attemptNo: number
  startedAt: string; submittedAt: string | null; graded: boolean
  questions: ReviewQuestion[]; awarded: number; totalPoints: number
  result: { percent: number; grade: string | null } | null
}

export async function getAttemptReview(attemptId: string): Promise<AttemptReview | null> {
  const me = await currentParticipantContext()
  if (!me) return null
  const svc = createServiceClient()
  const { data: attData } = await svc.from('test_attempts')
    .select('id, assessment_id, participant_id, attempt_no, started_at, submitted_at, status').eq('id', attemptId).maybeSingle()
  const att = (attData ?? null) as unknown as AttemptRow | null
  if (!att || att.participant_id !== me.participantId || att.status === 'in_progress') return null

  const [{ data: aData }, { data: qsData }, { data: saData }, { data: resData }] = await Promise.all([
    svc.from('assessments').select('name').eq('id', att.assessment_id).maybeSingle(),
    svc.from('test_questions').select('id, question, type, points, test_answers(id, content)').eq('assessment_id', att.assessment_id),
    svc.from('attempt_answers').select('test_question_id, test_answer_id, answer_multi, answer_open, points').eq('attempt_id', attemptId),
    svc.from('assessment_results').select('percent_score, grade_scales(grade_label)')
      .eq('assessment_id', att.assessment_id).eq('participant_id', me.participantId).maybeSingle(),
  ])
  const qs = (qsData ?? []) as unknown as TestQuestionWithOptionsRow[]
  const sa = (saData ?? []) as unknown as Pick<AttemptAnswerRow, 'test_question_id' | 'test_answer_id' | 'answer_multi' | 'answer_open' | 'points'>[]
  const res = (resData ?? null) as unknown as { percent_score: number | string | null; grade_scales: { grade_label: string } | null } | null
  const saMap = new Map(sa.map((s) => [s.test_question_id, s]))

  const questions: ReviewQuestion[] = seededOrder(qs, (q) => q.id, attemptId).map((q) => {
    const s = saMap.get(q.id)
    const optionText = new Map((q.test_answers ?? []).map((o) => [o.id, o.content]))
    const chosen = q.type === 'multiple' ? (Array.isArray(s?.answer_multi) ? s.answer_multi : []) : s?.test_answer_id ? [s.test_answer_id] : []
    return {
      id: q.id, question: q.question, type: q.type, maxPoints: Number(q.points),
      selected: chosen.map((id) => optionText.get(id) ?? '—'),
      answerOpen: q.type === 'open' ? s?.answer_open ?? null : null,
      points: s?.points != null ? Number(s.points) : q.type === 'open' ? null : 0,
    }
  })
  return {
    attemptId, assessmentId: att.assessment_id, assessmentName: (aData as { name: string } | null)?.name ?? 'Test', attemptNo: att.attempt_no,
    startedAt: att.started_at, submittedAt: att.submitted_at, graded: att.status === 'graded',
    questions,
    awarded: Math.round(questions.reduce((s, q) => s + (q.points ?? 0), 0) * 100) / 100,
    totalPoints: questions.reduce((s, q) => s + q.maxPoints, 0),
    result: res ? { percent: Number(res.percent_score), grade: res.grade_scales?.grade_label ?? null } : null,
  }
}

// ── Finalizacja: sumuje punkty, liczy % i ocenę, zapisuje wynik ──
export async function computeAndFinalize(svc: SupabaseClient, attemptId: string, gradedBy: string | null): Promise<{ percent: number; grade: string | null }> {
  const { data: attData } = await svc.from('test_attempts').select('id, assessment_id, participant_id').eq('id', attemptId).single()
  const att = attData as unknown as Pick<AttemptRow, 'id' | 'assessment_id' | 'participant_id'>
  const { data: aData } = await svc.from('assessments').select('grade_scale_group').eq('id', att.assessment_id).single()
  const a = aData as unknown as Pick<AssessmentRow, 'grade_scale_group'>
  const { data: qsData } = await svc.from('test_questions').select('id, points').eq('assessment_id', att.assessment_id)
  const qs = (qsData ?? []) as unknown as Pick<TestQuestionRow, 'id' | 'points'>[]
  const totalPossible = qs.reduce((s, q) => s + Number(q.points), 0)
  const { data: saData } = await svc.from('attempt_answers').select('points').eq('attempt_id', attemptId)
  const sa = (saData ?? []) as unknown as Pick<AttemptAnswerRow, 'points'>[]
  const awarded = sa.reduce((s, x) => s + Number(x.points ?? 0), 0)
  const percent = totalPossible > 0 ? Math.round((awarded / totalPossible) * 100) : 0

  const { data: scaleData } = await svc.from('grade_scales')
    .select('id, grade_label, grade_value, min_percent, max_percent, is_passing').eq('scale_group', a.grade_scale_group)
  const scaleRows = (scaleData ?? []) as unknown as Pick<
    GradeScaleRow, 'id' | 'grade_label' | 'grade_value' | 'min_percent' | 'max_percent' | 'is_passing'
  >[]
  const scales: ScaleRow[] = scaleRows.map((s) => ({
    id: s.id, grade_label: s.grade_label, grade_value: s.grade_value,
    min_percent: s.min_percent, max_percent: s.max_percent, is_passing: s.is_passing,
  }))
  const grade = findGrade(percent, scales)

  await svc.from('test_attempts').update({ total_points: awarded, status: 'graded' }).eq('id', attemptId)
  await svc.from('assessment_results').upsert({
    assessment_id: att.assessment_id, participant_id: att.participant_id,
    total_points: awarded, percent_score: percent, grade_scale_id: grade?.id ?? null,
    graded_by: gradedBy, graded_at: new Date().toISOString(),
  }, { onConflict: 'assessment_id,participant_id' })
  return { percent, grade: grade?.grade_label ?? null }
}
