import mark from "../../design-system/assets/logos/armormark.svg";

/** The ArmorIQ mark + product name. */
export function Brand({ onDark = false }: { onDark?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <img src={mark} alt="" className="size-6" />
      <span
        className={`text-aq-md tracking-aq-tight font-semibold ${onDark ? "text-aq-ink-on" : "text-aq-ink"}`}
      >
        hackeval
      </span>
    </span>
  );
}
