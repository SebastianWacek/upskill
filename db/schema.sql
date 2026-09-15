-- Reprezentatywny schemat spójny z zapytaniami w kodzie (Supabase / PostgreSQL).
-- Szkielet pokazujący relacje i kolumny, nie pełna migracja produkcyjna.

-- Profile (rola + dane) — 1:1 z auth.users.
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  full_name  text,
  role       text not null default 'uczestnik'
             check (role in ('uczestnik', 'trener', 'administrator')),
  created_at timestamptz not null default now()
);

-- Uczestnik (konto szkoleniowe powiązane z profilem).
create table if not exists public.participants (
  id         uuid primary key default gen_random_uuid(),
  profile_id uuid references public.profiles(id),
  first_name text not null,
  last_name  text not null,
  is_active  boolean not null default true,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_participants_profile on public.participants(profile_id);

-- Szkolenia (definicja) i ich edycje/terminy.
create table if not exists public.courses (
  id   uuid primary key default gen_random_uuid(),
  name text not null,
  description text
);
create table if not exists public.course_offerings (
  id         uuid primary key default gen_random_uuid(),
  course_id  uuid not null references public.courses(id) on delete cascade,
  code       text,
  status     text not null default 'active',   -- active | draft | archived
  trainer_id uuid references public.participants(id),  -- prowadzący (rola trener)
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

-- Zapisy na szkolenie (+ postęp uczestnika).
create table if not exists public.course_enrollments (
  id                 uuid primary key default gen_random_uuid(),
  participant_id     uuid not null references public.participants(id) on delete cascade,
  course_offering_id uuid not null references public.course_offerings(id) on delete cascade,
  status             text not null default 'active',  -- active | completed | withdrawn
  progress_percent   int  not null default 0,
  enrolled_at        timestamptz not null default now(),
  unique (participant_id, course_offering_id)
);
create index if not exists idx_enrollments_participant on public.course_enrollments(participant_id);

-- Skala ocen (progi %).
create table if not exists public.grade_scales (
  id          uuid primary key default gen_random_uuid(),
  scale_group text not null,
  grade_label text not null,
  grade_value numeric,
  min_percent int not null,
  max_percent int not null,
  is_passing  boolean not null default false
);
create index if not exists idx_grade_scales_group on public.grade_scales(scale_group);

-- Test wiedzy / zaliczenie w ramach edycji szkolenia.
create table if not exists public.assessments (
  id                  uuid primary key default gen_random_uuid(),
  course_offering_id  uuid not null references public.course_offerings(id) on delete cascade,
  name                text not null,
  term                int  not null default 1,
  time_limit_minutes  int,
  available_from      timestamptz,
  available_to        timestamptz,
  max_attempts        int,
  grade_scale_group   text not null default 'default',
  status              text not null default 'open',   -- open | grading | closed
  submission_deadline timestamptz,
  deleted_at          timestamptz,
  created_at          timestamptz not null default now()
);
create index if not exists idx_assessments_offering on public.assessments(course_offering_id);

create table if not exists public.assessment_forms (
  id            uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references public.assessments(id) on delete cascade,
  kind          text not null   -- np. 'test' | 'file' | 'oral'
);

create table if not exists public.assessment_file_requirements (
  assessment_id      uuid primary key references public.assessments(id) on delete cascade,
  allowed_extensions text[],
  max_size_mb        int,
  max_file_count     int
);

-- Bank pytań i opcji odpowiedzi (is_correct NIGDY nie trafia do uczestnika — RLS + sanityzacja).
create table if not exists public.test_questions (
  id            uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references public.assessments(id) on delete cascade,
  question      text not null,
  type          text not null check (type in ('single', 'multiple', 'open')),
  points        numeric not null default 1
);
create index if not exists idx_questions_assessment on public.test_questions(assessment_id);

create table if not exists public.test_answers (
  id               uuid primary key default gen_random_uuid(),
  test_question_id uuid not null references public.test_questions(id) on delete cascade,
  content          text not null,
  is_correct       boolean not null default false
);
create index if not exists idx_answers_question on public.test_answers(test_question_id);

-- Podejścia i zapisane odpowiedzi uczestnika.
create table if not exists public.test_attempts (
  id            uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references public.assessments(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  attempt_no    int not null,
  status        text not null default 'in_progress' check (status in ('in_progress', 'submitted', 'graded')),
  started_at    timestamptz not null default now(),
  submitted_at  timestamptz,
  total_points  numeric,
  unique (assessment_id, participant_id, attempt_no)
);
create index if not exists idx_attempts_participant on public.test_attempts(assessment_id, participant_id);

create table if not exists public.attempt_answers (
  id               uuid primary key default gen_random_uuid(),
  attempt_id       uuid not null references public.test_attempts(id) on delete cascade,
  test_question_id uuid not null references public.test_questions(id) on delete cascade,
  test_answer_id   uuid references public.test_answers(id),
  answer_multi     uuid[],
  answer_open      text,
  points           numeric,
  unique (attempt_id, test_question_id)   -- idempotentny autozapis (upsert)
);

-- Wynik zaliczenia (jeden na uczestnika).
create table if not exists public.assessment_results (
  id             uuid primary key default gen_random_uuid(),
  assessment_id  uuid not null references public.assessments(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  total_points   numeric,
  percent_score  numeric,
  grade_scale_id uuid references public.grade_scales(id),
  graded_by      uuid references public.profiles(id),
  graded_at      timestamptz,
  unique (assessment_id, participant_id)
);

-- Pliki prac (Supabase Storage — metadane w bazie, obiekt w buckecie).
create table if not exists public.assessment_files (
  id            uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references public.assessments(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  storage_path  text not null,
  original_name text,
  size_bytes    bigint,
  mime_type     text,
  uploaded_by   uuid references public.profiles(id),
  created_at    timestamptz not null default now()
);

-- Certyfikaty ukończenia.
create table if not exists public.certificates (
  id                 uuid primary key default gen_random_uuid(),
  participant_id     uuid not null references public.participants(id) on delete cascade,
  course_offering_id uuid not null references public.course_offerings(id) on delete cascade,
  serial             text unique,
  issued_at          timestamptz not null default now(),
  valid_until        timestamptz
);
create index if not exists idx_certificates_participant on public.certificates(participant_id);
