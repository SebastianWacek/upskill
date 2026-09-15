-- ============================================================================
-- RLS: profil przy rejestracji, helpery roli/własności, polityki dostępu.
-- Kluczowy wzorzec bezpieczeństwa: bank pytań i poprawne odpowiedzi NIGDY nie
-- są widoczne dla uczestnika — rozwiązywanie testu obsługują Server Actions na
-- kliencie service-role (sanityzacja + liczenie punktów po stronie serwera).
-- ============================================================================

-- 1) Automatyczne utworzenie profilu przy rejestracji (rola z user_metadata).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id, new.email,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    coalesce(new.raw_user_meta_data->>'role', 'uczestnik')
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 2) Helper roli (security definer → omija RLS na profiles, brak rekurencji).
create or replace function public.current_app_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;
grant execute on function public.current_app_role() to authenticated;

-- 3) Helper własności: czy bieżący trener prowadzi daną edycję szkolenia.
create or replace function public.trainer_owns_offering(offering_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.course_offerings o
    join public.participants p on p.id = o.trainer_id
    where o.id = offering_id and p.profile_id = auth.uid()
  )
$$;
grant execute on function public.trainer_owns_offering(uuid) to authenticated;

-- ── Włącz RLS na tabelach ──
alter table public.profiles            enable row level security;
alter table public.participants        enable row level security;
alter table public.course_enrollments  enable row level security;
alter table public.assessments         enable row level security;
alter table public.test_questions      enable row level security;
alter table public.test_answers        enable row level security;
alter table public.test_attempts       enable row level security;
alter table public.attempt_answers     enable row level security;
alter table public.assessment_results  enable row level security;
alter table public.assessment_files    enable row level security;

-- ── Profile: właściciel + administrator ──
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.current_app_role() = 'administrator');

-- ── Uczestnik: widzi własny rekord; administrator wszystkie ──
drop policy if exists participants_select on public.participants;
create policy participants_select on public.participants for select to authenticated
  using (profile_id = auth.uid() or public.current_app_role() = 'administrator');

-- ── Zapisy: uczestnik swoje; trener swoje edycje; administrator wszystko ──
drop policy if exists enrollments_select on public.course_enrollments;
create policy enrollments_select on public.course_enrollments for select to authenticated
  using (
    public.current_app_role() = 'administrator'
    or exists (select 1 from public.participants p
               where p.id = course_enrollments.participant_id and p.profile_id = auth.uid())
    or public.trainer_owns_offering(course_enrollments.course_offering_id)
  );

-- ── BANK PYTAŃ: tylko trener (własne szkolenia) + administrator.
--    Uczestnik NIE dostaje żadnego dostępu — poprawne odpowiedzi nie mogą wyciec. ──
drop policy if exists test_questions_rw on public.test_questions;
create policy test_questions_rw on public.test_questions for all to authenticated
  using (
    public.current_app_role() = 'administrator'
    or (public.current_app_role() = 'trener' and exists (
      select 1 from public.assessments a
      where a.id = test_questions.assessment_id
        and public.trainer_owns_offering(a.course_offering_id)))
  )
  with check (
    public.current_app_role() = 'administrator'
    or (public.current_app_role() = 'trener' and exists (
      select 1 from public.assessments a
      where a.id = test_questions.assessment_id
        and public.trainer_owns_offering(a.course_offering_id)))
  );

drop policy if exists test_answers_rw on public.test_answers;
create policy test_answers_rw on public.test_answers for all to authenticated
  using (
    public.current_app_role() = 'administrator'
    or (public.current_app_role() = 'trener' and exists (
      select 1 from public.test_questions q
      join public.assessments a on a.id = q.assessment_id
      where q.id = test_answers.test_question_id
        and public.trainer_owns_offering(a.course_offering_id)))
  )
  with check (
    public.current_app_role() = 'administrator'
    or (public.current_app_role() = 'trener' and exists (
      select 1 from public.test_questions q
      join public.assessments a on a.id = q.assessment_id
      where q.id = test_answers.test_question_id
        and public.trainer_owns_offering(a.course_offering_id)))
  );

-- ── Podejścia: uczestnik widzi tylko swoje (metadane, bez poprawnych odpowiedzi);
--    trener/administrator — do oceny i statystyk swoich szkoleń. ──
drop policy if exists attempts_owner_select on public.test_attempts;
create policy attempts_owner_select on public.test_attempts for select to authenticated
  using (
    public.current_app_role() = 'administrator'
    or exists (select 1 from public.participants p
               where p.id = test_attempts.participant_id and p.profile_id = auth.uid())
    or exists (select 1 from public.assessments a
               where a.id = test_attempts.assessment_id
                 and public.trainer_owns_offering(a.course_offering_id))
  );

-- ── Pliki prac: uczestnik swoje; trener/administrator — swoje szkolenia.
--    (Zapis egzekwuje dodatkowo termin — sprawdzany w Server Action.) ──
drop policy if exists files_select on public.assessment_files;
create policy files_select on public.assessment_files for select to authenticated
  using (
    public.current_app_role() = 'administrator'
    or exists (select 1 from public.participants p
               where p.id = assessment_files.participant_id and p.profile_id = auth.uid())
    or exists (select 1 from public.assessments a
               where a.id = assessment_files.assessment_id
                 and public.trainer_owns_offering(a.course_offering_id))
  );
