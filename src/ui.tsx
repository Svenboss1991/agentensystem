// Gemeinsame Bausteine der Seite «Heute».

export function Abschnitt(props: { nummer: string; titel: string; anzahl?: number; leer?: string; children: React.ReactNode }) {
  const leer = props.anzahl === 0;
  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold">
        <span className="mr-2 text-stone-400">{props.nummer}</span>
        {props.titel}
        {props.anzahl ? <span className="ml-2 text-stone-400">{props.anzahl}</span> : null}
      </h2>
      {leer ? <p className="text-sm text-stone-500">{props.leer}</p> : <div className="flex flex-col gap-3">{props.children}</div>}
    </section>
  );
}

export function Karte({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">{children}</div>;
}

export function Marker({ children }: { children: React.ReactNode }) {
  return <span className="rounded bg-stone-100 px-1.5 py-0.5 text-stone-600">{children}</span>;
}

export function Knopf(props: {
  onClick: () => void;
  primaer?: boolean;
  disabled?: boolean;
  typ?: "button" | "submit";
  children: React.ReactNode;
}) {
  return (
    <button
      type={props.typ ?? "button"}
      onClick={props.onClick}
      disabled={props.disabled}
      className={`rounded px-3 py-1.5 text-sm disabled:opacity-50 ${
        props.primaer ? "bg-stone-900 text-white" : "border border-stone-300 bg-white"
      }`}
    >
      {props.children}
    </button>
  );
}
