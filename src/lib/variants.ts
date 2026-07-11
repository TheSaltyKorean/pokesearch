const VARIANT_LABELS: Record<string, string> = {
  normal: 'Normal',
  holofoil: 'Holofoil',
  reverseHolofoil: 'Reverse Holo',
  '1stEditionNormal': '1st Edition',
  '1stEditionHolofoil': '1st Ed. Holo',
  unlimited: 'Unlimited',
  graded: 'Graded',
}

export function variantLabel(v: string): string {
  return VARIANT_LABELS[v] ?? v
}
