import { createFileRoute } from "@tanstack/react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MENU, CATEGORY_LABELS, fmtPence, type MenuItem } from "@/data/menu";

export const Route = createFileRoute("/_authenticated/menu")({
  component: MenuPage,
  ssr: false,
});

function MenuPage() {
  const grouped = MENU.reduce<Record<string, MenuItem[]>>((acc, it) => {
    (acc[it.cat] ||= []).push(it);
    return acc;
  }, {});

  const order: MenuItem["cat"][] = ["waffle", "dough", "cake", "brownie", "shake", "drink", "kunafah", "churros", "sundae"];

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Menu</h1>
        <span className="text-sm text-muted-foreground">{MENU.length} items</span>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {order
          .filter((cat) => grouped[cat]?.length)
          .map((cat) => (
            <Card key={cat} className="overflow-hidden">
              <CardHeader className="py-3 border-b">
                <CardTitle className="text-sm font-medium flex items-center justify-between">
                  <span>{CATEGORY_LABELS[cat]}</span>
                  <Badge variant="secondary">{grouped[cat].length}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <ul className="divide-y">
                  {grouped[cat].map((it) => (
                    <li key={it.id} className="px-4 py-3 flex items-start justify-between gap-3">
                      <span className="font-medium">{it.base}</span>
                      <span className="text-sm tabular-nums text-muted-foreground text-right">
                        {it.pence != null
                          ? fmtPence(it.pence)
                          : it.sizes
                            ? Object.entries(it.sizes)
                                .map(([s, p]) => `${s} ${fmtPence(p)}`)
                                .join(" · ")
                            : "—"}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))}
      </div>
    </div>
  );
}