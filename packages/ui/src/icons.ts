/** Line icons from the prototype IC() helper (24×24 stroke icons). */
export const ICON_PATHS = {
  back: 'M15 5l-7 7 7 7',
  next: 'M9 5l7 7-7 7',
  cam: 'M4 8h3l2-3h6l2 3h3v11H4zM12 16.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7z',
  print: 'M7 9V4h10v5M7 17H4v-7h16v7h-3M7 14h10v6H7z',
  flip: 'M12 3v18M8 7L3 12l5 5zM16 7l5 5-5 5z',
  rot: 'M20 12a8 8 0 11-3-6.2M20 4v5h-5',
  crop: 'M6 2v16h16M2 6h16v16',
  sun: 'M12 16a4 4 0 100-8 4 4 0 000 8zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2',
  moon: 'M20 14A8 8 0 1110 4a7 7 0 0010 10z',
  reset: 'M4 12a8 8 0 108-8H7M7 1L4 4l3 3',
  drag: 'M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3',
  pinch: 'M4 4l6 6M10 6v4H6M20 20l-6-6M14 18v-4h4',
  twist: 'M12 4a8 8 0 018 8M20 12l-3-3M12 20a8 8 0 01-8-8M4 12l3 3',
  tap: 'M10.5 12a1.5 1.5 0 103 0a1.5 1.5 0 10-3 0M7 12a5 5 0 1010 0a5 5 0 10-10 0M3 12a9 9 0 1018 0a9 9 0 10-18 0',
  auto: 'M12 3v6M12 15v6M3 12h6M15 12h6',
  check: 'M5 12l5 5 9-10',
  x: 'M6 6l12 12M18 6L6 18',
  clock: 'M12 7v5l3 2M12 3a9 9 0 100 18 9 9 0 000-18z',
  wrench: 'M14.7 6.3a4 4 0 00-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 005.4-5.4l-2.5 2.5-2.5-.5-.5-2.5z',
  download: 'M12 3v12M7 10l5 5 5-5M4 19h16',
} as const;

export type IconName = keyof typeof ICON_PATHS;

export function iconSvg(n: IconName, z = 44, c = 'currentColor'): string {
  return `<svg class="ic" width="${z}" height="${z}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${ICON_PATHS[n]}"/></svg>`;
}
