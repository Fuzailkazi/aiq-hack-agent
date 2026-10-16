# Vendored ArmorIQ design system

Copied from the ArmorIQ `design-system/` kit (identical in every ArmorIQ repo checked on 2026-10-02:
tokens.json md5 c343d0724e675b3d29662dd510a913c5, components.json md5 5f2c492e372cbd5337391ac133e1679d).

Included: `tokens.json`, `components.json`, `styles/` (tokens.css + Tailwind v4 `@theme` in globals.css),
`primitives/` (imported as `@shared/ui`, `@shared/icons`, `@shared/motion`, `@shared/hooks`), `references/`,
the Geist + Geist Mono variable fonts (OFL), and the ArmorIQ mark.

Left out on purpose: the showcase `site/`, the agent `skills/` (installed at the user level), the sync script
(it only runs inside the origin app), Sunflower/Instrument Serif fonts and the other logos (unused here).

Do not edit files in this folder: extend the system by adding tokens/variants upstream, then re-copy.
