// Eksport tabeli do CSV (klient). Samodzielny moduł raportów.
// Separator ; + BOM — poprawne polskie znaki w Excelu.

export function rowsToCsv(headers: string[], keys: string[], rows: Record<string, unknown>[]): string {
  const cell = (x: unknown) => `"${String(x ?? '').replace(/"/g, '""')}"`
  const lines = [headers.map(cell).join(';')]
  for (const r of rows) lines.push(keys.map((k) => cell(r[k])).join(';'))
  return '\uFEFF' + lines.join('\r\n')
}

export function downloadText(filename: string, content: string, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.replace(/[\\/:*?"<>|]+/g, '_')
  a.click()
  URL.revokeObjectURL(url)
}
