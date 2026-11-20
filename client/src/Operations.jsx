import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, RefreshCw, ReceiptText } from "lucide-react";
import { api, amount, dateTime, useData } from "./api";
import { ActionForm, Modal, Pager, State, Table } from "./ui";

export function SupplierCatalog({ supplier, close }) {
  const [linked, setLinked] = useState(true);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const client = useQueryClient();
  const path = `/suppliers/${supplier.id}/products`;
  const q = useData(
    `${path}?linked=${linked}&limit=20&offset=${(page - 1) * 20}`,
  );
  const rows = q.data?.products || [];
  async function toggle(p) {
    setBusy(true);
    setError("");
    try {
      await api(path + "/" + p.id, { method: p.linked ? "DELETE" : "PUT" });
      if (linked && rows.length === 1 && page > 1) setPage(page - 1);
      await client.invalidateQueries({
        predicate: (query) => query.queryKey[0]?.startsWith(path + "?"),
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={supplier.name + " · Products"} close={close} busy={busy}>
      <div className="tabs">
        {["Linked products", "All products"].map((name, i) => (
          <button
            key={name}
            disabled={busy}
            aria-pressed={linked === !i}
            onClick={() => {
              setPage(1);
              setLinked(!i);
            }}
          >
            {name}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <State
        query={q}
        empty={!rows.length}
        message={
          linked
            ? "No linked products. Open All products to assign one."
            : "No products on this page."
        }
      >
        <Table
          heads={["Product", "SKU", "Relationship"]}
          rows={rows.map((p) => ({
            key: p.id,
            cells: [
              p.name,
              p.sku,
              <button disabled={busy} onClick={() => toggle(p)}>
                {p.linked ? "Unlink" : "Link"}
              </button>,
            ],
          }))}
        />
      </State>
      <Pager page={page} setPage={setPage} next={rows.length === 20} />
    </Modal>
  );
}

export function Receipt({ orderId, storeName, preview }) {
  const path = "/orders/" + orderId + "/receipt";
  const q = useQuery({
    queryKey: [path],
    queryFn: async ({ signal }) => {
      const result = await api(path, { signal });
      return result.receipt ? result : api(path, { method: "POST", signal });
    },
  });
  const receipt = q.data?.receipt;
  function download() {
    const text = [
      `InvenKai receipt ${receipt.receipt_number}`,
      `Issued: ${receipt.issued_at}`,
      `Order #${orderId}`,
      "",
      ...receipt.items.map(
        (i) =>
          `${i.productName} (${i.sku}) — ${i.quantity} × ${amount(i.unitPrice)} = ${amount(i.lineTotal)}`,
      ),
      "",
      `Total: ${amount(receipt.total_amount)}`,
    ].join("\n");
    const url = URL.createObjectURL(
      new Blob([text], { type: "text/plain;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = receipt.receipt_number + ".txt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <>
      {!receipt && preview}
      <section className="receipt invoice" aria-label="Receipt">
        <State query={q}>
          {receipt ? (
            <>
              <header className="invoice-header">
                <span className="invoice-icon">
                  <ReceiptText size={23} />
                </span>
                <div>
                  <h3>{storeName || "InvenKai"} receipt</h3>
                  <p>
                    {receipt.receipt_number} · {dateTime(receipt.issued_at)}
                  </p>
                </div>
              </header>
              <dl className="invoice-reference">
                <div>
                  <dt>Order</dt>
                  <dd>#{orderId}</dd>
                </div>
                <div>
                  <dt>Items</dt>
                  <dd>
                    {receipt.items.reduce(
                      (sum, item) => sum + Number(item.quantity),
                      0,
                    )}
                  </dd>
                </div>
              </dl>
              <Table
                heads={["Item", "Qty", "Unit price", "Amount"]}
                rows={receipt.items.map((item, index) => ({
                  key: index,
                  cells: [
                    item.productName,
                    item.quantity,
                    amount(item.unitPrice),
                    amount(item.lineTotal),
                  ],
                }))}
              />
              <div className="invoice-total">
                <span>Total</span>
                <strong>{amount(receipt.total_amount)}</strong>
              </div>
              <button onClick={download}>
                <Download size={16} /> Download receipt
              </button>
            </>
          ) : (
            <p role="status">
              <ReceiptText size={18} /> Your receipt could not be loaded.{" "}
              <button type="button" onClick={() => q.refetch()}>
                Try again
              </button>
              .
            </p>
          )}
        </State>
      </section>
    </>
  );
}

export function Operations() {
  const q = useData("/operations/failed-receipts");
  const summary = useData("/operations/summary");
  const [selected, setSelected] = useState(null),
    [notice, setNotice] = useState("");
  const jobs = q.data?.jobs || [];
  return (
    <>
      <div className="page-heading">
        <h1>Receipt recovery</h1>
      </div>
      <section className="panel">
        <div className="panel-title">
          <h2>Order processing</h2>
          <button
            onClick={() => summary.refetch()}
            disabled={summary.isFetching}
          >
            Refresh status
          </button>
        </div>
        <State query={summary}>
          {summary.data && (
            <>
              <p>
                PostgreSQL: {summary.data.database} · Redis:{" "}
                {summary.data.redis}
              </p>
              <Table
                heads={[
                  "Pending dispatch",
                  "Processing",
                  "Dispatched",
                  "Receipts issued",
                ]}
                rows={[
                  {
                    key: "totals",
                    cells: [
                      summary.data.pending,
                      summary.data.processing,
                      summary.data.dispatched,
                      summary.data.issued,
                    ],
                  },
                ]}
              />
            </>
          )}
        </State>
      </section>
      <section className="panel">
        <div className="panel-title">
          <h2>Failed receipt jobs</h2>
          <button onClick={() => q.refetch()} disabled={q.isFetching}>
            <RefreshCw size={16} />
            Refresh
          </button>
        </div>
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        <State
          query={q}
          empty={!jobs.length}
          message="No failed receipt jobs in the latest 100 failed queue entries."
        >
          <Table
            heads={["Order", "Attempts", "Action"]}
            rows={jobs.map((j) => ({
              key: j.orderId,
              cells: [
                "#" + j.orderId,
                j.attemptsMade,
                <button onClick={() => setSelected(j)}>Retry receipt</button>,
              ],
            }))}
          />
        </State>
      </section>
      {selected && (
        <ActionForm
          title={"Retry receipt for order #" + selected.orderId}
          close={() => setSelected(null)}
          submitLabel="Retry receipt"
          onSubmit={async () => {
            const result = await api(
              "/operations/failed-receipts/" + selected.orderId + "/retry",
              { method: "POST" },
            );
            setNotice(
              result.alreadyGenerated
                ? "The receipt already exists."
                : "The receipt job was queued for another attempt.",
            );
            await Promise.all([q.refetch(), summary.refetch()]);
          }}
        >
          <p>
            Retry this job after the cause of its failure has been resolved.
          </p>
        </ActionForm>
      )}
    </>
  );
}
