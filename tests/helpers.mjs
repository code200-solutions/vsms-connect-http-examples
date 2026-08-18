// Shared plumbing for the E2E suite — the same plain-fetch style as
// examples/, factored so each test stays a few readable lines.

export const BASE = process.env.VSMS_CONNECT_BACKEND_URL;
export const BUSINESS = process.env.VSMS_CONNECT_BUSINESS_ID;
export const API_KEY = process.env.VSMS_CONNECT_API_KEY;
// Optional Location UUID (multi-location) — gates the "sale to a location" test.
/**
 * The suite's own store code — the caller's identifier, not a VSMS Connect id.
 *
 * A literal rather than an env var, matching examples/lib.mjs: the fixtures
 * exist to show the request body, and a field injected from the environment
 * would be invisible to anyone reading them. Declare and map it once on the
 * app's Stores tab, or these fresh sales come back blocked with
 * HTTP_STORE_NOT_MAPPED.
 */
export const STORE_CODE = "STORE-PV-01";
export const HTTP_TIMEOUT_MS = Number(
  process.env.VSMS_CONNECT_HTTP_TIMEOUT_MS ?? 60_000,
);

if (!BASE || !BUSINESS || !API_KEY) {
  console.error(
    "Missing config — copy .env.example to .env, then run: yarn test",
  );
  process.exit(2);
}

export const FISCALISE = `${BASE}/businesses/${BUSINESS}/fiscalise`;
const HEADERS = {
  Authorization: `ApiKey ${API_KEY}`,
  "Content-Type": "application/json",
};

/**
 * One request. Never throws on HTTP error statuses — returns
 * { status, headers, envelope, payload } where `payload` is the success
 * payload unwrapped from the nested `{ data: { object, data } }` container
 * (null on error envelopes).
 */
export async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const envelope = await res.json();
  const payload = envelope.error ? null : (envelope.data?.data ?? null);
  return { status: res.status, headers: res.headers, envelope, payload };
}

export function fiscalise(body, syncTimeoutMs = 25_000) {
  return request("POST", `${FISCALISE}?sync_timeout_ms=${syncTimeoutMs}`, body);
}

export function getStatus(invoiceId) {
  return request("GET", `${FISCALISE}/${invoiceId}`);
}

export function trigger(invoiceId) {
  return request(
    "POST",
    `${FISCALISE}/${invoiceId}/trigger?sync_timeout_ms=25000`,
  );
}

export function cancel(fiscalInvoiceNumber) {
  return request("POST", `${FISCALISE}/cancel?sync_timeout_ms=25000`, {
    fiscalInvoiceNumber,
  });
}

const IN_FLIGHT = new Set([
  "pending",
  "imported",
  "processing",
  "queued",
  "received",
]);

export function isTerminal(status) {
  return !IN_FLIGHT.has(String(status).toLowerCase());
}

/** Poll a (usually 202-queued) invoice until every payment result is terminal. */
export async function pollUntilTerminal(invoiceId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { status, envelope, payload } = await getStatus(invoiceId);
    if (envelope.error)
      throw new Error(`status GET failed: HTTP ${status} ${envelope.code}`);
    if (
      payload.paymentResults.length > 0 &&
      payload.paymentResults.every((pr) => isTerminal(pr.status))
    ) {
      return payload;
    }
    if (Date.now() >= deadline)
      throw new Error(`invoice ${invoiceId} not terminal after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/** Resolve a POST result to a terminal payload (converges a 202 via polling). */
export async function ensureFiscalised(result) {
  if (result.envelope.error) {
    const e = result.envelope;
    const details = (e.validationErrors ?? [])
      .map((v) => `${v.field}: ${v.message}`)
      .join("; ");
    throw new Error(
      `HTTP ${result.status} ${e.code ?? ""} ${e.message}${details ? ` [${details}]` : ""}`.trim(),
    );
  }
  if (result.status === 202 && result.payload.invoiceId) {
    return pollUntilTerminal(result.payload.invoiceId);
  }
  return result.payload;
}

/** First payment result carrying a fiscal number (fiscalTimestamp coerced to ms). */
export function firstFiscal(payload) {
  const pr = payload.paymentResults.find((p) => p.fiscalInvoiceNumber !== null);
  if (!pr) return null;
  // fiscalTimestamp is a BIGINT serialised as a string on the wire.
  const ms = pr.fiscalTimestamp === null ? null : Number(pr.fiscalTimestamp);
  return { number: pr.fiscalInvoiceNumber, timestampMs: ms };
}

let seq = 0;
export function uniqueInvoiceNumber(prefix = "E2E") {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}`;
}

const round2 = (n) => Math.round(n * 100) / 100;

/** VAT rate for a semantic tax code. VAT0 = zero-rated; everything else 15%. */
function rateForCode(taxCode) {
  return taxCode === "VAT0" ? 0 : 15;
}

/**
 * Build one reconciled line item from a spec:
 *   { description?, unitPrice, quantity?, taxCode?|taxLabel?, taxRatePercent?, gtin? }
 * Exactly one of taxCode / taxLabel; taxRatePercent defaults from the code
 * (VAT15→15, VAT0→0) and must be supplied for a raw taxLabel line.
 */
function buildLine(spec) {
  const quantity = spec.quantity ?? 1;
  const rate =
    spec.taxRatePercent ??
    (spec.taxLabel ? 15 : rateForCode(spec.taxCode ?? "VAT15"));
  const lineSubtotal = round2(spec.unitPrice * quantity);
  const lineTaxAmount = round2((lineSubtotal * rate) / 100);
  return {
    description: spec.description ?? "E2E test item",
    quantity,
    unitPrice: spec.unitPrice,
    ...(spec.taxLabel
      ? { taxLabel: spec.taxLabel }
      : { taxCode: spec.taxCode ?? "VAT15" }),
    taxRatePercent: rate,
    lineSubtotal,
    lineTaxAmount,
    lineTotal: round2(lineSubtotal + lineTaxAmount),
    ...(spec.gtin ? { gtin: spec.gtin } : {}),
  };
}

/**
 * Invoice factory with auto-reconciled totals — mirrors the wire rules in
 * docs/SPEC.md §1. Line + payment shape is fully controllable, with
 * convenience flags for the common variants:
 *   - lines: [spec, …]     → explicit line items (mix taxCode/VAT0 per line)
 *   - payments: [spec, …]  → explicit payments (multiple entries and/or tenders[])
 *   - buyer / buyerEmail   → adds the buyer block (email gets the receipt copy)
 *   - training             → training:true (invoiceType TRAINING server-side)
 *   - gtin                 → two lines, one EAN-13 + one EAN-8 barcode
 *   - mixedTax             → a VAT15 line + a VAT0 line in one basket
 *   - splitTender          → one payment carrying a CASH+CARD tenders[] breakdown
 *   - advanceDeposits: N   → splits totalAmount into N payments (an ADVANCE chain)
 *   - taxCode ("VAT15"|"VAT0") | taxLabel (raw V-SDC label) — single-line default
 *   - locationId          → per-request location selector on a fresh sale
 *   - invoiceType / transactionType / reference / referentDocumentNumber
 *   - unitPrice / quantity / paymentType
 */
export function makeInvoice(opts = {}) {
  // ── Line items ────────────────────────────────────────────────────────
  let lineSpecs;
  if (opts.lines) {
    lineSpecs = opts.lines;
  } else if (opts.gtin) {
    // One EAN-13 and one EAN-8 — both inside the 8–14 char window.
    lineSpecs = [
      {
        description: "E2E item with EAN-13",
        unitPrice: 1000,
        gtin: "4006381333931",
      },
      { description: "E2E item with EAN-8", unitPrice: 250, gtin: "96385074" },
    ];
  } else if (opts.mixedTax) {
    // A realistic mixed basket: one standard-rated line + one zero-rated line.
    lineSpecs = [
      {
        description: "Standard-rated goods",
        unitPrice: 1000,
        taxCode: "VAT15",
      },
      {
        description: "Zero-rated staple",
        unitPrice: 500,
        quantity: 2,
        taxCode: "VAT0",
      },
    ];
  } else {
    lineSpecs = [
      {
        description: "E2E test item",
        unitPrice: opts.unitPrice ?? 1000,
        quantity: opts.quantity ?? 1,
        ...(opts.taxLabel
          ? { taxLabel: opts.taxLabel }
          : { taxCode: opts.taxCode ?? "VAT15" }),
      },
    ];
  }
  const lineItems = lineSpecs.map(buildLine);
  const totalAmount = round2(lineItems.reduce((s, li) => s + li.lineTotal, 0));

  // ── Payments ──────────────────────────────────────────────────────────
  // Priority: explicit payments[] → advance chain → split tender → single.
  let payments;
  if (opts.payments) {
    payments = opts.payments.map((p) => ({
      paymentDate: new Date().toISOString(),
      ...p,
    }));
  } else if (opts.advanceDeposits && opts.advanceDeposits > 1) {
    const n = opts.advanceDeposits;
    const each = round2(totalAmount / n);
    payments = [];
    let remaining = totalAmount;
    for (let i = 0; i < n; i++) {
      const amount = i === n - 1 ? round2(remaining) : each; // last absorbs rounding
      remaining = round2(remaining - amount);
      payments.push({
        amount,
        paymentType: opts.paymentType ?? "CARD",
        paymentDate: new Date().toISOString(),
      });
    }
  } else {
    const payment = {
      amount: totalAmount,
      paymentType: opts.paymentType ?? "CASH",
      paymentDate: new Date().toISOString(),
    };
    if (opts.splitTender) {
      const half = round2(totalAmount / 2);
      payment.paymentType = "OTHER";
      payment.tenders = [
        { amount: half, paymentType: "CASH" },
        { amount: round2(totalAmount - half), paymentType: "CARD" },
      ];
    }
    payments = [payment];
  }

  const invoice = {
    invoiceNumber: opts.invoiceNumber ?? uniqueInvoiceNumber(),
    invoiceType: opts.invoiceType ?? "NORMAL",
    transactionType: opts.transactionType ?? "SALE",
    invoiceDate: new Date().toISOString(),
    currencyCode: "VUV",
    cashierId: "e2e-suite",
    lineItems,
    payments,
    subtotalAmount: round2(lineItems.reduce((s, li) => s + li.lineSubtotal, 0)),
    taxAmount: round2(lineItems.reduce((s, li) => s + li.lineTaxAmount, 0)),
    totalAmount,
  };
  if (opts.training) invoice.training = true;
  // Exactly one of the two selectors, and only on a fresh SALE: a COPY
  // forbids both (422 INVALID_COPY_BODY) and a refund follows its source.
  // An explicit locationId wins — that is what the escape-hatch test asserts.
  if (opts.locationId) invoice.locationId = opts.locationId;
  else if (
    (opts.invoiceType ?? "NORMAL") !== "COPY" &&
    (opts.transactionType ?? "SALE") === "SALE"
  )
    invoice.storeCode = STORE_CODE;
  if (opts.reference) invoice.reference = opts.reference;
  if (opts.referentDocumentNumber)
    invoice.referentDocumentNumber = opts.referentDocumentNumber;
  if (opts.buyer || opts.buyerEmail) {
    invoice.buyer = {
      tin: "1000001",
      name: "E2E Test Buyer Ltd",
      email: opts.buyerEmail ?? "buyer@example.test",
    };
  }
  return invoice;
}

/**
 * Minimal COPY body. COPY inherits lines/payments/totals/buyer from the source
 * document, so the wire body carries ONLY the four identity fields + `source`.
 * `transactionType` must match the source ("SALE" to reprint a sale, "REFUND"
 * to reprint a refund). `fiscalTimestampMs` is coerced to the ISO-8601 form the
 * server requires for `referencedFiscalTimestamp`.
 */
export function makeCopy({ fiscalNumber, fiscalTimestampMs, transactionType }) {
  return {
    invoiceNumber: uniqueInvoiceNumber("E2E-COPY"),
    invoiceType: "COPY",
    transactionType,
    cashierId: "e2e-suite",
    source: {
      referencedFiscalNumber: fiscalNumber,
      referencedFiscalTimestamp: new Date(fiscalTimestampMs).toISOString(),
    },
  };
}

/**
 * Flatten an error envelope into one searchable string — code, message, and
 * every validationError's field AND message (a missing required field reports
 * `field: "cashierId", message: "Required"`, so the field name must be in the
 * haystack for field-based assertions to match).
 */
export function errorHaystack(envelope) {
  return [
    envelope.code,
    envelope.message,
    ...(envelope.validationErrors ?? []).flatMap((v) => [v.field, v.message]),
  ]
    .filter(Boolean)
    .join(" | ");
}
