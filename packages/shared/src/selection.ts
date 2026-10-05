/**
 * Pure photo-selection & retake rules (prototype: flat(), autoFp(), fpk(), tg(), retake()).
 */

export interface SelectablePhoto {
  id: string;
  angle: number;
  shot: number;
  selected: boolean;
  retaken?: boolean;
}

/** Photos that are "in" the session result, ordered by angle then shot (prototype flat()). */
export function activePhotos<T extends SelectablePhoto>(photos: T[]): T[] {
  return photos.filter((p) => p.selected).sort((a, b) => a.angle - b.angle || a.shot - b.shot);
}

/** Prototype autoFp(): spread picks evenly across all angles. */
export function autoPick(activeIds: string[], count: number): string[] {
  if (activeIds.length === 0) return [];
  const step = Math.max(1, Math.floor(activeIds.length / count));
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = activeIds[Math.min(activeIds.length - 1, i * step)];
    if (!out.includes(id)) out.push(id);
  }
  // Fill gaps (only possible when there are fewer photos than slots / duplicates).
  for (const id of activeIds) {
    if (out.length >= count) break;
    if (!out.includes(id)) out.push(id);
  }
  return out.slice(0, count);
}

/** Prototype fpk(): tap toggles; the oldest pick is dropped when the frame is full. */
export function togglePick(picks: string[], id: string, count: number): { picks: string[]; added: boolean } {
  const i = picks.indexOf(id);
  if (i >= 0) return { picks: picks.filter((p) => p !== id), added: false };
  const next = [...picks, id];
  while (next.length > count) next.shift();
  return { picks: next, added: true };
}

/**
 * Prototype tg(): on an angle that has more photos than shotsPerAngle (after a
 * retake) tapping a photo adds it to the angle's selection and drops the oldest.
 */
export function chooseForAngle(selected: string[], id: string, shotsPerAngle: number): string[] {
  if (selected.includes(id)) return selected;
  const next = [...selected, id];
  while (next.length > shotsPerAngle) next.shift();
  return next;
}

export function retakesLeft(retakenAngles: number[], limit: number): number {
  return Math.max(0, limit - new Set(retakenAngles).size);
}

export function canRetake(retakenAngles: number[], angle: number, limit: number, totalAngles: number): boolean {
  if (angle < 0 || angle >= totalAngles) return false;
  if (retakenAngles.includes(angle)) return false;
  return retakesLeft(retakenAngles, limit) > 0;
}

export interface CaptureStep {
  angle: number;
  shot: number;
}

/** Full capture plan, or the plan for a single retake angle. */
export function capturePlan(angles: number, shotsPerAngle: number, retakeAngle: number | null = null): CaptureStep[] {
  const list = retakeAngle === null ? [...Array(angles).keys()] : [retakeAngle];
  return list.flatMap((angle) => [...Array(shotsPerAngle).keys()].map((shot) => ({ angle, shot })));
}

/**
 * Next step that still needs a photo. Used to resume a session after a booth
 * restart. `photos` are all non-retake photos already stored for the session.
 */
export function nextMissingStep(
  photos: Pick<SelectablePhoto, 'angle' | 'shot' | 'retaken'>[],
  angles: number,
  shotsPerAngle: number,
): CaptureStep | null {
  const have = new Set(photos.filter((p) => !p.retaken).map((p) => `${p.angle}:${p.shot}`));
  for (const step of capturePlan(angles, shotsPerAngle)) if (!have.has(`${step.angle}:${step.shot}`)) return step;
  return null;
}
