// Zawężone typy wierszy używane przez silnik testów i akcje serwerowe.
// (W pełnym projekcie generowane/utrzymywane szerzej — tu tylko potrzebny podzbiór.)

export type QuestionType = 'single' | 'multiple' | 'open'
export type AttemptStatus = 'in_progress' | 'submitted' | 'graded'

export interface ParticipantRow {
  id: string
  profile_id: string
  deleted_at: string | null
}

export interface AssessmentRow {
  id: string
  name: string
  term: number
  course_offering_id: string
  time_limit_minutes: number | null
  available_from: string | null
  available_to: string | null
  max_attempts: number | null
  grade_scale_group: string
  status: string
  submission_deadline: string | null
}

export interface TestQuestionRow {
  id: string
  assessment_id: string
  question: string
  type: QuestionType
  points: number
}

export interface TestAnswerRow {
  id: string
  test_question_id: string
  content: string
  is_correct: boolean
}

export interface AttemptRow {
  id: string
  assessment_id: string
  participant_id: string
  attempt_no: number
  started_at: string
  submitted_at: string | null
  status: AttemptStatus
  total_points: number | null
}

export interface AttemptAnswerRow {
  id: string
  attempt_id: string
  test_question_id: string
  test_answer_id: string | null
  answer_multi: string[] | null
  answer_open: string | null
  points: number | null
}

export interface GradeScaleRow {
  id: string
  scale_group: string
  grade_label: string
  grade_value: number | null
  min_percent: number
  max_percent: number
  is_passing: boolean
}

// ── Kształty złączeń (embedded selects Supabase) ──
export interface TestIntroAssessmentRow extends AssessmentRow {
  assessment_forms: { kind: string } | null
  course_offerings: { code: string; courses: { name: string } | null } | null
}
export type AttemptSummaryRow = Pick<
  AttemptRow, 'id' | 'attempt_no' | 'started_at' | 'submitted_at' | 'status' | 'total_points'
>
export interface ResultPercentRow {
  percent_score: number | string
  grade_scales: { grade_label: string } | null
}
export interface SolveAssessmentRow {
  name: string
  time_limit_minutes: number | null
  course_offerings: { code: string } | null
}
export interface TestQuestionWithOptionsRow extends TestQuestionRow {
  test_answers: { id: string; content: string }[] | null
}
export interface TestQuestionGradingRow {
  id: string
  type: QuestionType
  points: number
  test_answers: { id: string; is_correct: boolean }[] | null
}
