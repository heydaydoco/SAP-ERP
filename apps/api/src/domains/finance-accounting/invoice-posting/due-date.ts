/**
 * Net due date = document (invoice) date + the partner's payment terms in days (D4: derived, never
 * stored — there is no due_date column; the open-item read computes it from the journal's
 * document_date and the customer/vendor master's `payment_terms_days`). Null terms ⇒ due on the
 * document date. Pure UTC date math so it never drifts with the server timezone.
 */
export function deriveDueDate(documentDate: string, paymentTermsDays: number | null): string {
  const d = new Date(`${documentDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (paymentTermsDays ?? 0));
  return d.toISOString().slice(0, 10);
}
