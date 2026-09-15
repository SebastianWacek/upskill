// Reguły plików prac (czysta logika — współdzielona klient/serwer, testowana Vitest).

export const SUBMISSIONS_BUCKET = 'submissions'

export interface FileRequirements {
  allowed_extensions: string[] | null
  max_size_mb: number | null
  max_file_count: number | null
}

/** Domyślne limity, gdy trener nie skonfigurował wymagań. */
export const DEFAULT_REQUIREMENTS: Required<{ [K in keyof FileRequirements]: NonNullable<FileRequirements[K]> }> = {
  allowed_extensions: ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'zip', 'jpg', 'jpeg', 'png'],
  max_size_mb: 20,
  max_file_count: 5,
}

export function effectiveRequirements(req: FileRequirements | null | undefined) {
  return {
    allowed_extensions: req?.allowed_extensions?.length
      ? req.allowed_extensions.map((e) => e.toLowerCase())
      : DEFAULT_REQUIREMENTS.allowed_extensions,
    max_size_mb: req?.max_size_mb ?? DEFAULT_REQUIREMENTS.max_size_mb,
    max_file_count: req?.max_file_count ?? DEFAULT_REQUIREMENTS.max_file_count,
  }
}

export function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase() : ''
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Bezpieczna nazwa do wyświetlania / nagłówka Content-Disposition. */
export function safeFileName(name: string): string {
  return name.replace(/[\/:*?"<>|\s-]+/g, '_').slice(0, 180) || 'plik'
}

/**
 * Walidacja nowego pliku względem wymagań. Zwraca komunikat błędu albo null.
 * `existingCount` — ile plików uczestnik już wgrał do tego zadania.
 */
export function validateNewFile(
  file: { name: string; size: number },
  req: FileRequirements | null | undefined,
  existingCount: number,
): string | null {
  const r = effectiveRequirements(req)
  const ext = extOf(file.name)
  if (!ext) return 'Plik musi mieć rozszerzenie (np. .pdf).'
  if (!r.allowed_extensions.includes(ext))
    return `Niedozwolony typ pliku „.${ext}". Dozwolone: ${r.allowed_extensions.map((e) => '.' + e).join(', ')}.`
  if (file.size <= 0) return 'Plik jest pusty.'
  if (file.size > r.max_size_mb * 1024 * 1024)
    return `Plik jest za duży (${formatBytes(file.size)}). Limit: ${r.max_size_mb} MB.`
  if (existingCount >= r.max_file_count)
    return `Osiągnięto limit plików (${r.max_file_count}). Usuń któryś, żeby dodać nowy.`
  return null
}

export type DeadlineState = 'none' | 'open' | 'soon' | 'passed'

/** Stan terminu: brak / otwarty / <48h / minął. */
export function deadlineState(deadline: string | null | undefined, now: Date = new Date()): DeadlineState {
  if (!deadline) return 'none'
  const d = new Date(deadline)
  if (Number.isNaN(d.getTime())) return 'none'
  const diff = d.getTime() - now.getTime()
  if (diff < 0) return 'passed'
  if (diff < 48 * 3600 * 1000) return 'soon'
  return 'open'
}
