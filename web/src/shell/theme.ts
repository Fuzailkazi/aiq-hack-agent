/** Light/dark via data-theme on <html> (the system's switch), remembered per browser. */
import { useEffect, useState } from "react";
import { recall, remember } from "../shared/storage";

export type Theme = "light" | "dark";

function initialTheme(): Theme {
  const saved = recall("hackeval.theme");
  if (saved === "light" || saved === "dark") return saved;
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return [
    theme,
    (t) => {
      remember("hackeval.theme", t);
      setTheme(t);
    },
  ];
}
