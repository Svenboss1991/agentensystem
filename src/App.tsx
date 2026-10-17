import type { Session } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { supabase } from "./lib/supabase";
import Heute from "./Heute";

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [istSven, setIstSven] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return setIstSven(undefined);
    supabase.rpc("ist_sven").then(({ data }) => setIstSven(data === true));
  }, [session]);

  if (session === undefined) return null;
  if (!session) return <Login />;
  if (istSven === undefined) return null;
  if (!istSven) {
    return (
      <Rahmen>
        <p className="mb-2">Angemeldet, aber noch nicht als Besitzer eingetragen.</p>
        <p className="text-sm text-stone-600">
          Benutzer-ID: <code className="select-all rounded bg-stone-200 px-1">{session.user.id}</code> (siehe README,
          «Besitzer festlegen»).
        </p>
        <button className="mt-4 text-sm underline" onClick={() => supabase.auth.signOut()}>
          Abmelden
        </button>
      </Rahmen>
    );
  }
  return <Heute />;
}

function Rahmen({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto max-w-md px-4 py-16">{children}</main>;
}

function Login() {
  const [email, setEmail] = useState("");
  const [passwort, setPasswort] = useState("");
  const [fehler, setFehler] = useState("");

  async function anmelden(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await supabase.auth.signInWithPassword({ email, password: passwort });
    setFehler(error ? "Anmeldung fehlgeschlagen. E-Mail oder Passwort stimmt nicht." : "");
  }

  return (
    <Rahmen>
      <h1 className="mb-6 text-2xl font-semibold">Heute</h1>
      <form onSubmit={anmelden} className="flex flex-col gap-3">
        <input
          type="email"
          required
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="E-Mail"
          className="rounded border border-stone-300 px-3 py-2"
        />
        <input
          type="password"
          required
          autoComplete="current-password"
          value={passwort}
          onChange={(e) => setPasswort(e.target.value)}
          placeholder="Passwort"
          className="rounded border border-stone-300 px-3 py-2"
        />
        <button className="rounded bg-stone-900 px-3 py-2 text-white">Anmelden</button>
        {fehler && <p className="text-sm text-red-700">{fehler}</p>}
      </form>
    </Rahmen>
  );
}
