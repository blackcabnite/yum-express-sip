import type { OrderLine } from "@/domain/types";

interface Props {
  order: readonly OrderLine[];
  receipt: { receiptNo: string; totalPence: number } | null;
  format: (pence: number) => string;
}

export function OrderPanel({ order, receipt, format }: Props): JSX.Element {
  const total = order.reduce((sum, l) => sum + l.unitPence * l.qty, 0);
  return (
    <section className="panel">
      <h2 className="panel-title">order</h2>
      {order.length === 0 ? (
        <p className="empty">no items yet</p>
      ) : (
        <ul className="lines">
          {order.map((l) => (
            <li key={l.id} className="line">
              <span className="qty">{l.qty}×</span>
              <span className="item">
                {l.base}
                {l.size && <span className="size"> ({l.size})</span>}
                {l.notes && <em className="notes"> [{l.notes}]</em>}
              </span>
              <span className="price">{format(l.unitPence * l.qty)}</span>
            </li>
          ))}
        </ul>
      )}
      {order.length > 0 && (
        <div className="total-row">
          <span>total</span>
          <span className="total">{format(total)}</span>
        </div>
      )}
      {receipt && (
        <div className="receipt">
          <span className="label">receipt</span>
          <code>{receipt.receiptNo}</code>
        </div>
      )}
    </section>
  );
}
