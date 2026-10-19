import { setLang } from "@/lib/actions";
import type { Lang } from "@/lib/i18n";

export function LangToggle({ current }: { current: Lang }) {
  const next = current === "es" ? "en" : "es";
  return (
    <form action={setLang.bind(null, next)}>
      <button
        type="submit"
        className="cursor-pointer rounded-lg px-2 py-1 text-xs font-semibold text-slate-500 ring-1 ring-slate-200 hover:bg-slate-50"
        title={next === "es" ? "Cambiar a español" : "Switch to English"}
      >
        {next === "es" ? "ES" : "EN"}
      </button>
    </form>
  );
}
