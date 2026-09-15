// Współdzielona logika liczenia oceny (klient — podgląd na żywo; serwer — zapis).

export interface CriterionCalc { id: string; weight_percent: number; max_points: number | null }
export interface ScaleRow {
  id: string
  grade_label: string
  grade_value: number | null
  min_percent: number
  max_percent: number
  is_passing: boolean
}

/**
 * Wynik procentowy: dla każdego kryterium udział = (punkty / maks_pkt) × waga%.
 * Suma udziałów (przy wagach = 100%) daje 0–100%. Kryteria bez maks_pkt lub bez
 * wpisanych punktów nie wnoszą udziału.
 */
export function computePercent(
  points: Record<string, number | string | null | undefined>,
  criteria: CriterionCalc[],
): number {
  let acc = 0
  for (const c of criteria) {
    const max = Number(c.max_points)
    const raw = points[c.id]
    if (max > 0 && raw !== '' && raw != null && !Number.isNaN(Number(raw))) {
      acc += Math.min(Number(raw) / max, 1) * Number(c.weight_percent)
    }
  }
  return Math.round(acc * 100) / 100
}

/** Ocena z progów skali: największy próg, którego min_percent ≤ wynik. */
export function findGrade(percent: number, scales: ScaleRow[]): ScaleRow | null {
  if (!scales.length) return null
  const sorted = [...scales].sort((a, b) => a.min_percent - b.min_percent)
  let chosen = sorted[0]
  for (const s of sorted) if (s.min_percent <= percent) chosen = s
  return chosen
}

/** Suma wpisanych punktów. */
export function sumPoints(points: Record<string, number | string | null | undefined>): number {
  let s = 0
  for (const k in points) {
    const v = points[k]
    if (v !== '' && v != null && !Number.isNaN(Number(v))) s += Number(v)
  }
  return Math.round(s * 100) / 100
}
