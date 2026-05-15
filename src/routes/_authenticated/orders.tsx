import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { getCodecMode, setCodecMode } from "@/lib/codec.functions";

export const Route = createFileRoute("/_authenticated/orders")({
  component: OrdersPage,
});

type Order = {
  id: string;
  caller_msisdn: string | null;
  customer_name: string | null;
  receipt_no: string | null;
  items: unknown;
  total_pence: number;
  whatsapp_sent_at: string | null;
  dispatched_at: string | null;
  created_at: string;
};

type OrderItem = { base?: string; size?: string | null; qty?: number };

function fmtPence(p: number) {
  return `£${(p / 100).toFixed(2)}`;
}

function OrdersPage() {
  const qc = useQueryClient();
  const fetchCodec = useServerFn(getCodecMode);
  const writeCodec = useServerFn(setCodecMode);

  const codecQ = useQuery({
    queryKey: ["codec_mode"],
    queryFn: () => fetchCodec(),
    refetchInterval: 30000,
    retry: false,
  });

  const codecM = useMutation({
    mutationFn: (mode: "opus" | "g722") => writeCodec({ data: { mode } }),
    onSuccess: (res) => {
      if (!res.ok) {
        toast.error(`Switch failed: ${res.error}`);
        return;
      }
      toast.success(`Codec switched to ${res.mode.toUpperCase()}`);
      qc.invalidateQueries({ queryKey: ["codec_mode"] });
    },
    onError: (e: Error) => toast.error(`Switch failed: ${e.message}`),
  });

  const mode = codecQ.data?.mode ?? "unknown";

  const ordersQ = useQuery({
    queryKey: ["ss_orders"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sweetspot_orders")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as Order[];
    },
  });

  useEffect(() => {
    const ch = supabase
      .channel("ss_orders_rt")
      .on("postgres_changes", { event: "*", schema: "public", table: "sweetspot_orders" }, () =>
        qc.invalidateQueries({ queryKey: ["ss_orders"] }),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [qc]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <Card className="mb-4">
        <CardHeader className="py-3 border-b flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm font-medium">Audio codec (Asterisk)</CardTitle>
          <span className="text-xs text-muted-foreground">
            {codecQ.isLoading
              ? "checking…"
              : codecQ.error
                ? "bridge unreachable"
                : `active: ${mode.toUpperCase()}`}
          </span>
        </CardHeader>
        <CardContent className="p-4 flex items-center gap-2">
          <Button
            size="sm"
            variant={mode === "opus" ? "default" : "outline"}
            disabled={codecM.isPending || mode === "opus"}
            onClick={() => codecM.mutate("opus")}
          >
            Opus 48 kHz (fullband)
          </Button>
          <Button
            size="sm"
            variant={mode === "g722" ? "default" : "outline"}
            disabled={codecM.isPending || mode === "g722"}
            onClick={() => codecM.mutate("g722")}
          >
            G.722 / default
          </Button>
          {codecM.isPending && (
            <span className="text-xs text-muted-foreground ml-2">reloading Asterisk…</span>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="py-3 border-b">
          <CardTitle className="text-sm font-medium">Orders</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {ordersQ.isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : !ordersQ.data?.length ? (
            <div className="p-8 text-sm text-muted-foreground text-center">No orders yet.</div>
          ) : (
            <ul className="divide-y">
              {ordersQ.data.map((o) => {
                const items = (Array.isArray(o.items) ? o.items : []) as OrderItem[];
                return (
                  <li
                    key={o.id}
                    className="px-4 py-3 grid gap-2 lg:grid-cols-[120px_1fr_auto] lg:items-center"
                  >
                    <div className="text-xs text-muted-foreground tabular-nums">
                      {new Date(o.created_at).toLocaleString()}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">
                        {o.customer_name ?? "Unknown"} · {o.caller_msisdn ?? "private"}
                        {o.receipt_no ? (
                          <span className="text-muted-foreground font-normal">
                            {" "}
                            · #{o.receipt_no}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground truncate">
                        {items.length === 0
                          ? "(no items)"
                          : items
                              .map(
                                (i) =>
                                  `${i.qty ?? 1}× ${i.base ?? "item"}${i.size ? ` (${i.size})` : ""}`,
                              )
                              .join(", ")}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="flex gap-1">
                        {o.whatsapp_sent_at && <Badge variant="secondary">WhatsApp</Badge>}
                        {o.dispatched_at && <Badge variant="secondary">Dispatched</Badge>}
                      </div>
                      <div className="font-medium tabular-nums w-20 text-right">
                        {fmtPence(o.total_pence)}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
