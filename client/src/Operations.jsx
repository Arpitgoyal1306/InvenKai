import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, RefreshCw } from "lucide-react";
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

export function Receipt({ orderId }) {
  const path = "/orders/" + orderId + "/receipt";
  const q = useQuery({
    queryKey: [path],
    queryFn: ({ signal }) => api(path, { signal }),
    refetchInterval: (query) =>
      query.state.data?.receipt || query.state.error ? false : 4000,
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
    <section className="receipt">
      <h3>Receipt</h3>
      <State query={q}>
        {receipt ? (
          <>
            <p>
              {receipt.receipt_number} · {dateTime(receipt.issued_at)}
            </p>
            <button onClick={download}>
              <Download size={16} />
              Download receipt
            </button>
          </>
        ) : (
          <p role="status">
            Awaiting receipt generation. This view updates automatically.
          </p>
        )}
      </State>
    </section>
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
