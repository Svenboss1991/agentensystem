const LINKS = [
  { href: "#/", label: "Heute" },
  { href: "#/akten", label: "Akten" },
  { href: "#/adressbuch", label: "Adressbuch" },
  { href: "#/dokumente", label: "Dokumente" },
  { href: "#/abos", label: "Abos" },
  { href: "#/finanzen", label: "Finanzen" },
];

/** Hauptnavigation oben auf jeder Seite. */
export function Navigation() {
  const hash = window.location.hash || "#/";
  const aktiv = (href: string) =>
    href === "#/" ? hash === "#/" || hash === "" : hash.startsWith(href) || (href === "#/adressbuch" && /^#\/(kontakt|firma)\//.test(hash)) ||
        (href === "#/finanzen" && hash.startsWith("#/wertpapier/"));
  return (
    <nav className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      <a href="#/" className="mr-2 flex items-center gap-1.5 font-semibold text-stone-900">
        <img src="/lupita.svg" alt="" className="h-8 w-8" />
        Lupita
      </a>
      {LINKS.map((l) => (
        <a key={l.href} href={l.href} className={aktiv(l.href) ? "font-semibold text-stone-900" : "text-stone-500 hover:text-stone-800"}>
          {l.label}
        </a>
      ))}
    </nav>
  );
}

export function Seite({ titel, breit, children }: { titel: string; breit?: boolean; children: React.ReactNode }) {
  return (
    <main className={`mx-auto px-4 py-8 ${breit ? "max-w-5xl" : "max-w-3xl"}`}>
      <Navigation />
      <h1 className="mb-6 text-3xl font-semibold">{titel}</h1>
      {children}
    </main>
  );
}
