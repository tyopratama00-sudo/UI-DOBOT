import { z } from 'zod';

/**
 * Data-driven photo frame templates. The six defaults reproduce the prototype
 * (TPL constant) one-to-one. New templates can be added from the admin panel
 * (stored in AppSetting "templates") without touching application code.
 */

export const slotStyleSchema = z.enum(['rounded', 'polaroid', 'square']);
export type SlotStyle = z.infer<typeof slotStyleSchema>;

export const reactionSchema = z.object({
  pose: z.string(),
  anim: z.string().nullable(),
  text: z.string(),
  fx: z.enum(['heart', 'star']).nullable(),
});
export type RobotReaction = z.infer<typeof reactionSchema>;

export const photoTemplateSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{2,40}$/),
  name: z.string().min(1).max(40),
  photoCount: z.number().int().min(1).max(12),
  columns: z.number().int().min(1).max(4),
  rows: z.number().int().min(1).max(12),
  /** width / height of the whole frame */
  aspectRatio: z.number().min(0.2).max(2),
  background: z.string().min(1).max(200),
  slotStyle: slotStyleSchema,
  label: z.string().max(40).default('ROBOT PHOTOBOOTH'),
  labelColor: z.string().default('#2B2A4C'),
  enabled: z.boolean().default(true),
  /** Robot mascot reaction when the frame is tapped (prototype FRR). */
  reaction: reactionSchema.optional(),
});
export type PhotoTemplate = z.infer<typeof photoTemplateSchema>;

export const templatesSchema = z
  .array(photoTemplateSchema)
  .min(1)
  .superRefine((list, ctx) => {
    const ids = new Set<string>();
    list.forEach((t, i) => {
      if (ids.has(t.id)) ctx.addIssue({ code: 'custom', message: `Duplicate template id ${t.id}`, path: [i, 'id'] });
      ids.add(t.id);
      if (t.columns * t.rows < t.photoCount)
        ctx.addIssue({ code: 'custom', message: `${t.id}: columns × rows must fit photoCount`, path: [i, 'rows'] });
    });
  });

export const DEFAULT_TEMPLATES: PhotoTemplate[] = [
  { id: 'duo-mini', name: 'Duo Mini', photoCount: 2, columns: 1, rows: 2, aspectRatio: 0.5, background: '#BDE7FF', slotStyle: 'rounded', label: 'ROBOT PHOTOBOOTH', labelColor: '#2B2A4C', enabled: true, reaction: { pose: 'peace', anim: 'wob', text: 'Duo yang manis!', fx: 'heart' } },
  { id: 'strip-klasik', name: 'Strip Klasik', photoCount: 4, columns: 1, rows: 4, aspectRatio: 0.3, background: '#FFFFFF', slotStyle: 'polaroid', label: 'ROBOT PHOTOBOOTH', labelColor: '#2B2A4C', enabled: true, reaction: { pose: 'cool', anim: 'hop', text: 'Klasik, keren!', fx: null } },
  { id: 'kotak-ceria', name: 'Kotak Ceria', photoCount: 4, columns: 2, rows: 2, aspectRatio: 0.667, background: '#FFD9A8', slotStyle: 'rounded', label: 'ROBOT PHOTOBOOTH', labelColor: '#2B2A4C', enabled: true, reaction: { pose: 'cheer', anim: 'spin', text: 'Ceria banget!', fx: 'star' } },
  { id: 'enam-momen', name: 'Enam Momen', photoCount: 6, columns: 2, rows: 3, aspectRatio: 0.667, background: '#DCCBFF', slotStyle: 'polaroid', label: 'ROBOT PHOTOBOOTH', labelColor: '#2B2A4C', enabled: true, reaction: { pose: 'heart', anim: 'wob', text: 'Penuh kenangan!', fx: 'heart' } },
  { id: 'taman-mint', name: 'Taman Mint', photoCount: 6, columns: 3, rows: 2, aspectRatio: 0.8, background: '#BDEBD3', slotStyle: 'square', label: 'ROBOT PHOTOBOOTH', labelColor: '#2B2A4C', enabled: true, reaction: { pose: 'wave', anim: 'dance', text: 'Segar banget!', fx: 'star' } },
  { id: 'galeri-robot', name: 'Galeri Robot', photoCount: 8, columns: 2, rows: 4, aspectRatio: 0.55, background: '#FFC7DE', slotStyle: 'rounded', label: 'ROBOT PHOTOBOOTH', labelColor: '#2B2A4C', enabled: true, reaction: { pose: 'free', anim: 'dance', text: 'Galeri meriah!', fx: 'star' } },
];

/** Prototype default selection was index 1 (Strip Klasik). */
export const DEFAULT_TEMPLATE_ID = 'strip-klasik';

export function findTemplate(list: PhotoTemplate[], id: string | null | undefined): PhotoTemplate | undefined {
  return list.find((t) => t.id === id);
}
