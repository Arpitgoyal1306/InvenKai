import { useEffect, useRef, useState } from "react";
import {
  Layers3,
  ChevronLeft,
  ChevronRight,
  PackageOpen,
  X,
} from "lucide-react";

export function Brand({ compact = false } = {}) {
  return (
    <div className={compact ? "brand brand-market" : "brand"}>
      <span className="brand-mark">
        <Layers3 size={24} />
      </span>
      InvenKai
    </div>
  );
}
export function State({ query, children, empty, message = "No records yet." }) {
  if (query.isPending)
    return (
      <p role="status" className="state">
        Loading…
      </p>
    );
  if (query.isError)
    return (
      <div role="alert" className="state error">
        {query.error.message}{" "}
        <button onClick={() => query.refetch()}>Retry</button>
      </div>
    );
  if (empty)
    return (
      <div className="state empty">
        <PackageOpen size={26} />
        <p>{message}</p>
      </div>
    );
  return children;
}
export function Pager({ page, setPage, next }) {
  return (
    <div className="pager">
      <span>Page {page}</span>
      <button
        aria-label="Previous page"
        disabled={page === 1}
        onClick={() => setPage(page - 1)}
      >
        <ChevronLeft size={17} />
      </button>
      <button
        aria-label="Next page"
        disabled={!next}
        onClick={() => setPage(page + 1)}
      >
        <ChevronRight size={17} />
      </button>
    </div>
  );
}
export function Table({ heads, rows }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {heads.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ key, cells }) => (
            <tr key={key}>
              {cells.map((v, i) => (
                <td key={i}>{v}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function Modal({ title, close, children, busy = false, className }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      className={className}
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
      aria-label={title}
    >
      <div className="modal-heading">
        <h2>{title}</h2>
        <button
          disabled={busy}
          className="icon"
          aria-label="Close"
          onClick={close}
        >
          <X size={19} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function ActionForm({
  title,
  close,
  onSubmit,
  submitLabel = "Save changes",
  children,
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(e) {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    setError("");
    try {
      await onSubmit(values);
      close();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={title} close={close} busy={busy}>
      <form onSubmit={submit}>
        <fieldset disabled={busy}>
          {children}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <div className="form-actions">
            <button type="button" onClick={close}>
              Cancel
            </button>
            <button className="primary">
              {busy ? "Saving…" : submitLabel}
            </button>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}
export function Field({ label, ...props }) {
  return (
    <label>
      {label}
      <input {...props} />
    </label>
  );
}
