// Shared client for the example scripts. Each numbered case file focuses on
// the REQUEST BODY and flow (the interesting part for an integrator); the HTTP
// mechanics, config, polling, and receipt printing live here so the 14 case
// files stay short and correct-by-construction.
//
// Everything here is plain `fetch` — copy this file alongside any example you
// lift into your own project, or inline the two or three functions you need.

export const BASE = process.env.VSMS_CONNECT_BACKEND_URL; // up to and including /api/v1
export const BUSINESS = process.env.VSMS_CONNECT_BUSINESS_ID;
export const API_KEY = process.env.VSMS_CONNECT_API_KEY; // scope "http"

if (!BASE || !BUSINESS || !API_KEY) {
  console.error(
    "Missing config — copy .env.example to .env, then run: node --env-file=.env examples/<script>.mjs",
  );
  process.exit(2);
}

const FISCALISE = `${BASE}/businesses/${BUSINESS}/fiscalise`;
const TAX_RATES = `${BASE}/businesses/${BUSINESS}/tax-rates`;
const HEADERS = {
  // No JWT and no Idempotency-Key header — the server derives an idempotency
  // key from invoiceNumber + a body hash, so a byte-identical retry replays.
  Authorization: `ApiKey ${API_KEY}`,
  "Content-Type": "application/json",
};

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  // Read as text first so a non-JSON response (an HTML 404 / proxy error page,
  // or the SPA's index.html when the URL points at the app instead of the API)
  // becomes a clear diagnostic rather than a cryptic `Unexpected token '<'`.
  const raw = await res.text();
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    const snippet = raw.slice(0, 120).replace(/\s+/g, " ").trim();
    return {
      status: res.status,
      envelope: {
        error: true,
        status: res.status,
        code: "NON_JSON_RESPONSE",
        message:
          `Expected JSON from ${method} ${url} but got a non-JSON response ` +
          `(HTTP ${res.status}). Usually means VSMS_CONNECT_BACKEND_URL is wrong ` +
          `(pointing at the app/proxy, not the API), or this backend build ` +
          `predates the endpoint. First bytes: ${snippet}`,
      },
      payload: null,
    };
  }
  // Success envelopes nest the payload: { data: { object, data: <payload> } }.
  const payload = envelope.error ? null : (envelope.data?.data ?? null);
  return { status: res.status, envelope, payload };
}

export const fiscalise = (body) => call("POST", FISCALISE, body);
export const trigger = (invoiceId) =>
  call("POST", `${FISCALISE}/${invoiceId}/trigger`);
// Cancel a fiscalised payment. Pass a string to target it by SDC
// fiscalInvoiceNumber (back-compat), or a body object to target it by your own
// invoiceNumber (+ optional transactionType / externalPaymentId) — TAXCORE-639.
export const cancelDoc = (target) =>
  call(
    "POST",
    `${FISCALISE}/cancel`,
    typeof target === "string" ? { fiscalInvoiceNumber: target } : target,
  );
export const getStatus = (invoiceId) =>
  call("GET", `${FISCALISE}/${invoiceId}`);

/**
 * Declare the caller's tax table (the push equivalent of "list all tax rates").
 * `taxRates` is an array of `{ code, name?, rate? }`. Each not-yet-mapped code
 * becomes a PROPOSAL a business admin confirms to a V-SDC label; re-declaring a
 * rate or name that diverges from an already-confirmed mapping deactivates it
 * for re-review. Nothing is auto-confirmed. Payload:
 * `{ proposed, driftDetected, alreadyMapped }`.
 */
export const declareTaxRates = (taxRates) =>
  call("POST", TAX_RATES, { taxRates });

const IN_FLIGHT = new Set([
  "pending",
  "imported",
  "processing",
  "queued",
  "received",
]);

/** Poll a (usually 202-queued) invoice until every payment result is terminal. */
export async function pollUntilTerminal(invoiceId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { envelope, payload } = await getStatus(invoiceId);
    if (envelope.error) throw new Error(`status GET failed: ${envelope.code}`);
    if (
      payload.paymentResults.length > 0 &&
      payload.paymentResults.every(
        (p) => !IN_FLIGHT.has(String(p.status).toLowerCase()),
      )
    ) {
      return payload;
    }
    if (Date.now() >= deadline)
      throw new Error(`invoice ${invoiceId} not terminal after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/**
 * Resolve a POST result to a terminal payload, converging a 202 via polling.
 * On an error envelope, print it (with any validationErrors) and exit non-zero.
 */
export async function expectFiscalised(result, label) {
  if (result.envelope.error) {
    console.error(
      `✗ ${label}: HTTP ${result.status} ${result.envelope.code}: ${result.envelope.message}`,
    );
    for (const v of result.envelope.validationErrors ?? [])
      console.error(`    ${v.field}: ${v.message}`);
    process.exit(1);
  }
  let payload = result.payload;
  if (result.status === 202 && payload.invoiceId) {
    payload = await pollUntilTerminal(payload.invoiceId);
  }
  return payload;
}

// fiscalTimestamp is a BIGINT serialised as a STRING — coerce before date math.
export const toMs = (v) => (v == null ? null : Number(v));

/** First payment result carrying a fiscal number, or null. */
export function firstFiscal(payload) {
  const pr = payload.paymentResults.find((p) => p.fiscalInvoiceNumber);
  return pr
    ? { number: pr.fiscalInvoiceNumber, timestampMs: toMs(pr.fiscalTimestamp) }
    : null;
}

/**
 * Assert the source sale is fiscalised (signed) and return its fiscal ref.
 *
 * A refund/copy can only build on a SIGNED sale. When auto-fiscalise is off for
 * the HTTP connector the sale is only `imported` (no fiscal number), so instead
 * of a cryptic `Cannot read properties of null` crash this prints a clear
 * message and exits. (Refunds no longer need the number — they reference the
 * sale by its `invoiceNumber` — but COPY still does, and either way this is the
 * point to tell the user their source isn't signed.)
 */
export function requireFiscal(payload, label) {
  const f = firstFiscal(payload);
  if (!f) {
    const status = payload?.paymentResults?.[0]?.status ?? "unknown";
    console.error(
      `✗ ${label}: the source sale is not fiscalised (status "${status}") — it has no SDC fiscal number.\n` +
        `  A refund/copy needs a SIGNED sale. The likely cause is that auto-fiscalise is OFF for the\n` +
        `  HTTP connector, so the sale was only imported. Turn auto-fiscalise on (HTTP integration\n` +
        `  screen) or fiscalise the sale from the app, then retry.`,
    );
    process.exit(1);
  }
  return f;
}

/** epoch-ms → ISO-8601 (the form the server wants for referent/source timestamps). */
export const msToIso = (ms) => new Date(ms).toISOString();

/** Print the fiscal outcome of a payload — one line per payment + the receipt. */
export function printReceipt(payload, label) {
  // `invoiceId` is the server-issued GUID — the handle for GET /:invoiceId,
  // POST /:invoiceId/trigger, and examples/status-poll.mjs. It is NOT the
  // caller's invoiceNumber, and it differs from each invoicePaymentId below.
  console.log(
    `✓ ${label} — invoiceNumber ${payload.invoiceNumber} · invoiceId ${payload.invoiceId ?? "—"}`,
  );
  for (const p of payload.paymentResults) {
    let line = `  payment ${p.invoicePaymentId}: ${p.status} — ${p.fiscalInvoiceNumber ?? "—"}`;
    // TAXCORE-645: when a payment is imported rather than fiscalised, say why —
    // blocked (ineligible, e.g. MISSING_TAX_MAPPING) vs merely awaiting an
    // admin's fiscalise action (eligible, no block reasons).
    if (p.status !== "fiscalised") {
      const reasons = p.fiscalisationBlockReasons ?? [];
      if (reasons.length > 0) line += `  [blocked: ${reasons.join(", ")}]`;
      else if (p.eligibleForFiscalisation === true)
        line += "  [eligible — awaiting fiscalise]";
    }
    console.log(line);
  }
  const pr = payload.paymentResults[0];
  if (pr?.fiscalVerificationUrl)
    console.log(`  verify URL: ${pr.fiscalVerificationUrl}`);
  if (pr?.fiscalJournal) console.log(`\n${pr.fiscalJournal}`);
}

// ── Body builders ───────────────────────────────────────────────────────────
// Keep line reconciliation correct-by-construction. Each returns a wire-ready
// line item; totalsOf() sums them for the header.

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * A reconciled line item. `taxCode` is the semantic code you send; it must be
 * declared (POST /tax-rates) and mapped to a V-SDC label by an admin before it
 * will fiscalise — there are NO pre-seeded defaults. `"VAT15"` / `"VAT0"` here
 * are just the codes these examples happen to use (declare + map them first,
 * e.g. via examples/21-declare-tax-rates.mjs). `taxRatePercent` is the caller's
 * own rate; the confirmed mapping's V-SDC rate is authoritative.
 * Pass `gtin` (barcode) to attach one — V-SDC accepts 8–14 chars; omit or
 * pass null for lines without a barcode (the field is left off the wire body).
 */
export function vatLine(
  description,
  unitPrice,
  quantity = 1,
  taxCode = "VAT15",
  gtin = null,
) {
  const rate = taxCode === "VAT0" ? 0 : 15;
  const lineSubtotal = round2(unitPrice * quantity);
  const lineTaxAmount = round2((lineSubtotal * rate) / 100);
  return {
    description,
    quantity,
    unitPrice,
    taxCode,
    taxRatePercent: rate,
    lineSubtotal,
    lineTaxAmount,
    lineTotal: round2(lineSubtotal + lineTaxAmount),
    ...(gtin ? { gtin } : {}),
  };
}

/** Header totals summed across line items. */
export function totalsOf(lineItems) {
  return {
    subtotalAmount: round2(lineItems.reduce((s, l) => s + l.lineSubtotal, 0)),
    taxAmount: round2(lineItems.reduce((s, l) => s + l.lineTaxAmount, 0)),
    totalAmount: round2(lineItems.reduce((s, l) => s + l.lineTotal, 0)),
  };
}

export const uniqueNumber = (prefix = "EX") =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

export const BUYER = {
  tin: "123456",
  name: "Acme Trading Ltd",
  email: "accounts@acme-trading.test",
};
