import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Phone, User, Clock } from "lucide-react";

export const Route = createFileRoute("/_authenticated/")({
  component: CallsDashboard,
});

type CallSession = {
  id: string;
  caller_msisdn: string | null;
  customer_name: string | null;
  status: string;
  cart: unknown;
  last_ai_line: string | null;
  last_caller_transcript: string | null;
  current_intent: string | null;
  language: string | null;
  started_at: string;
  ended_at: string | null;
};

type CallEvent = {
  id: string;
  session_id: string;
  at: string;
  kind: string;
  text: string | null;
  payload: unknown;
};

type CartLine = { base?: string; size?: string | null; qty?: number; unitPence?: number };

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtPence(p: number) {
  return `£${(p / 100).toFixed(2)}`;
}

function CallsDashboard() {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const sessionsQ = useQuery({
    queryKey: ["ss_sessions"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sweetspot_call_sessions")
        .select("*")
        .order("started_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as CallSession[];
    },
  });

  // Realtime: any change → refetch the list
  useEffect(() => {
    const ch = supabase
      .channel("ss_sessions_rt")
      .on("postgres_changes", { event: "*", schema: "public", table: "sweetspot_call_sessions" }, () => {
        qc.invalidateQueries({ queryKey: ["ss_sessions"] });
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [qc]);

  // Auto-select latest active call
  useEffect(() => {
    if (selectedId || !sessionsQ.data?.length) return;
    const active = sessionsQ.data.find((s) => s.status === "active") ?? sessionsQ.data[0];
    if (active) setSelectedId(active.id);
  }, [sessionsQ.data, selectedId]);

  const selected = sessionsQ.data?.find((s) => s.id === selectedId) ?? null;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 grid gap-4 lg:grid-cols-[360px_1fr]">
      <Card className="overflow-hidden">
        <CardHeader className="py-3">
          <CardTitle className="text-sm font-medium flex items-center justify-between">
            <span>Recent calls</span>
            <Badge variant="secondary">{sessionsQ.data?.length ?? 0}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="h-[calc(100vh-180px)]">
            {sessionsQ.isLoading ? (
              <div className="p-3 space-y-2">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-14 w-full" />
                ))}
              </div>
            ) : !sessionsQ.data?.length ? (
              <div className="p-6 text-sm text-muted-foreground text-center">
                No calls yet. When the agent on the droplet handles a call, it will appear here in real time.
              </div>
            ) : (
              <ul className="divide-y">
                {sessionsQ.data.map((s) => {
                  const active = s.id === selectedId;
                  return (
                    <li key={s.id}>
                      <button
                        onClick={() => setSelectedId(s.id)}
                        className={[
                          "w-full text-left px-4 py-3 hover:bg-accent/50 transition-colors",
                          active ? "bg-accent" : "",
                        ].join(" ")}
                      >
                        <div className="flex items-center justify-between text-sm">
                          <span className="font-medium truncate">
                            {s.customer_name ?? "Unknown caller"}
                          </span>
                          <StatusBadge status={s.status} />
                        </div>
                        <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Phone className="size-3" /> {s.caller_msisdn ?? "private"}
                          </span>
                          <span className="flex items-center gap-1">
                            <Clock className="size-3" /> {fmtTime(s.started_at)}
                          </span>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </ScrollArea>
        </CardContent>
      </Card>

      <div className="min-w-0">
        {selected ? <CallDetail session={selected} /> : (
          <Card className="h-full grid place-items-center">
            <div className="text-sm text-muted-foreground">Select a call to view its transcript</div>
          </Card>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    active: { label: "Live", cls: "bg-emerald-500/15 text-emerald-600 border-emerald-500/20" },
    confirmed: { label: "Confirmed", cls: "bg-blue-500/15 text-blue-600 border-blue-500/20" },
    ended: { label: "Ended", cls: "bg-muted text-muted-foreground" },
  };
  const m = map[status] ?? { label: status, cls: "bg-muted text-muted-foreground" };
  return <Badge variant="outline" className={m.cls}>{m.label}</Badge>;
}

function CallDetail({ session }: { session: CallSession }) {
  const qc = useQueryClient();
  const eventsQ = useQuery({
    queryKey: ["ss_events", session.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sweetspot_call_events")
        .select("*")
        .eq("session_id", session.id)
        .order("at", { ascending: true })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as CallEvent[];
    },
  });

  useEffect(() => {
    const ch = supabase
      .channel(`ss_events_rt_${session.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "sweetspot_call_events", filter: `session_id=eq.${session.id}` },
        () => qc.invalidateQueries({ queryKey: ["ss_events", session.id] }),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [session.id, qc]);

  const cart = Array.isArray(session.cart) ? (session.cart as CartLine[]) : [];
  const total = useMemo(
    () => cart.reduce((sum, l) => sum + (l.unitPence ?? 0) * (l.qty ?? 0), 0),
    [cart],
  );

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <Card className="min-w-0">
        <CardHeader className="py-3 border-b">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <User className="size-4" />
            {session.customer_name ?? "Unknown caller"}
            <span className="text-muted-foreground font-normal">· {session.caller_msisdn ?? "private"}</span>
            <span className="ml-auto"><StatusBadge status={session.status} /></span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="h-[calc(100vh-260px)]">
            <div className="p-4 space-y-3">
              {eventsQ.isLoading ? (
                <Skeleton className="h-32 w-full" />
              ) : !eventsQ.data?.length ? (
                <div className="text-sm text-muted-foreground">No events yet.</div>
              ) : (
                eventsQ.data.map((e) => <EventRow key={e.id} event={e} />)
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      <Card className="h-fit">
        <CardHeader className="py-3 border-b">
          <CardTitle className="text-sm font-medium">Cart</CardTitle>
        </CardHeader>
        <CardContent className="p-3 text-sm">
          {cart.length === 0 ? (
            <div className="text-muted-foreground">Empty</div>
          ) : (
            <ul className="divide-y">
              {cart.map((l, i) => (
                <li key={i} className="py-2 flex items-baseline justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate">
                      <span className="font-medium">{l.qty ?? 1}×</span> {l.base ?? "Item"}
                      {l.size ? <span className="text-muted-foreground"> · {l.size}</span> : null}
                    </div>
                  </div>
                  <div className="tabular-nums text-muted-foreground">
                    {fmtPence((l.unitPence ?? 0) * (l.qty ?? 1))}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 pt-3 border-t flex items-center justify-between font-medium">
            <span>Total</span>
            <span className="tabular-nums">{fmtPence(total)}</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function EventRow({ event }: { event: CallEvent }) {
  const speakerMap: Record<string, { label: string; cls: string }> = {
    ai: { label: "AI", cls: "bg-primary/10 text-primary" },
    caller: { label: "Caller", cls: "bg-secondary text-secondary-foreground" },
    tool: { label: "Tool", cls: "bg-amber-500/15 text-amber-600" },
    system: { label: "System", cls: "bg-muted text-muted-foreground" },
  };
  const tone = speakerMap[event.kind] ?? speakerMap.system;
  return (
    <div className="flex gap-3 text-sm">
      <div className="w-16 shrink-0 text-xs text-muted-foreground tabular-nums">
        {fmtTime(event.at)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 mb-0.5">
          <span className={`text-xs px-1.5 py-0.5 rounded ${tone.cls}`}>{tone.label}</span>
          {event.kind !== "ai" && event.kind !== "caller" && event.kind !== "tool" && (
            <span className="text-xs text-muted-foreground">{event.kind}</span>
          )}
        </div>
        <div className="whitespace-pre-wrap break-words">{event.text ?? <span className="text-muted-foreground italic">(no text)</span>}</div>
      </div>
    </div>
  );
}