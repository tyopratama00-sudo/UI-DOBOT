/**
 * Pose guidance copied verbatim from the prototype (TIPS / PN / KC).
 * TIPS[angle][shot] = [category, title, description, poseKey]
 */

export type TipCategory = 'POSE' | 'MIMIK' | 'GAYA';
export type PoseTip = readonly [TipCategory, string, string, string];

export const TIPS: ReadonlyArray<ReadonlyArray<PoseTip>> = [
  [['POSE', 'Lambaikan tangan', 'Sapa kameranya seperti ke teman lama', 'wave'], ['MIMIK', 'Senyum lebar', 'Mata ikut tersenyum, bukan cuma bibir', 'grin']],
  [['POSE', 'Tanda peace', 'Dua jari di samping pipi', 'peace'], ['GAYA', 'Bersandar santai', 'Miringkan kepala sedikit ke bahu', 'lean']],
  [['MIMIK', 'Pura-pura kaget', 'Mulut bentuk O, mata selebar mungkin', 'shock'], ['POSE', 'Tangan di pipi', 'Tatapan melamun yang manis', 'cheek']],
  [['GAYA', 'Sok cool', 'Dagu sedikit naik, tatapan tenang', 'cool'], ['POSE', 'Dua jempol', 'Angkat dekat kamera', 'thumbs']],
  [['POSE', 'Saling bersandar', 'Rapatkan bahu dengan temanmu', 'hug'], ['MIMIK', 'Tertawa lepas', 'Bayangkan cerita paling lucu', 'laugh']],
  [['GAYA', 'Pose model', 'Satu tangan di pinggang, badan miring', 'model'], ['MIMIK', 'Manyun imut', 'Bibir maju sedikit, tatap lensa', 'pout']],
  [['POSE', 'Bentuk hati', 'Buat hati dengan tangan, sendiri atau berdua', 'heart'], ['GAYA', 'Mengintip', 'Tutup satu mata, senyum miring', 'peek']],
  [['POSE', 'Tunjuk kamera', 'Telunjuk ke lensa sambil berkedip', 'point'], ['MIMIK', 'Serius total', 'Tatapan tajam, tanpa senyum', 'serious']],
  [['POSE', 'Tangan ke atas', 'Seperti baru menang lomba', 'arms'], ['GAYA', 'Lompat kecil', 'Tekuk lutut, siap melayang', 'hop']],
  [['MIMIK', 'Senyum favoritmu', 'Pilih ekspresi terbaikmu', 'fav'], ['POSE', 'Bebas berkreasi', 'Ini sudut terakhir, buat sesukamu', 'free']],
] as const;

const FLAT_TIPS: PoseTip[] = TIPS.flatMap((a) => a);

/**
 * Tip for a given angle/shot. With the default 10×2 configuration this is exactly
 * TIPS[angle][shot]; other configurations walk the same list cyclically.
 */
export function tipFor(angleIndex: number, shotIndex: number, shotsPerAngle: number): PoseTip {
  const i = (angleIndex * shotsPerAngle + shotIndex) % FLAT_TIPS.length;
  return FLAT_TIPS[(i + FLAT_TIPS.length) % FLAT_TIPS.length];
}

/** Short pose names shown in the live-view status pill. */
export const POSE_NAMES: Record<string, string> = {
  wave: 'Halo!', grin: 'Cheese!', peace: 'Peace', lean: 'Santai', shock: 'Kaget', cheek: 'Manis', cool: 'Cool',
  thumbs: 'Jempol', hug: 'Rangkul', laugh: 'Ngakak', model: 'Model', pout: 'Manyun', heart: 'Love', peek: 'Ngintip',
  point: 'Tunjuk', serious: 'Serius', arms: 'Hore!', hop: 'Lompat', fav: 'Senyum', free: 'Bebas',
};

/** Category chip colours (prototype KC). */
export const TIP_CATEGORY_COLORS: Record<TipCategory, string> = {
  GAYA: 'var(--lv)',
  MIMIK: 'var(--pk)',
  POSE: 'var(--mi)',
};
