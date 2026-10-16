/**
 * Bare controls inside FormField carry these classes: the canonical ArmorIQ control (same recipe as SearchField's
 * wrapper — surface fill, hairline border, accent border on focus). The kit has no Input primitive yet.
 */
export const inputClass =
  "border-aq-border bg-aq-surface text-aq-sm text-aq-ink placeholder:text-aq-ink-faint h-9 w-full rounded-md border px-3 outline-none transition-colors focus:border-aq-accent";

export const textareaClass =
  "border-aq-border bg-aq-surface text-aq-sm text-aq-ink placeholder:text-aq-ink-faint w-full rounded-md border px-3 py-2 outline-none transition-colors focus:border-aq-accent";

export const codeAreaClass = `${textareaClass} font-mono text-aq-xs`;

export const fileClass =
  "text-aq-xs text-aq-ink-soft w-full file:mr-3 file:h-8 file:cursor-pointer file:rounded-md file:border file:border-aq-border file:bg-aq-zebra file:px-3 file:text-aq-xs file:font-medium file:text-aq-ink hover:file:bg-aq-accent-soft";
