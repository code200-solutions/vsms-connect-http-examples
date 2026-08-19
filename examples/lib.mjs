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
// `/stores`, not `/locations` — the admin Locations CRUD owns that path.
const LOCATIONS = `${BASE}/businesses/${BUSINESS}/stores`;
const HEADERS = {
  // No JWT and no Idempotency-Key header — the server derives an idempotency
  // key from invoiceNumber + a body hash, so a byte-identical retry replays.
  Authorization: `ApiKey ${API_KEY}`,
  "Content-Type": "application/json",
  // Correct for any API client, and load-bearing behind a tunnel: ngrok's free
  // tier answers GETs that do not ask for JSON with an HTML browser-warning
  // page. POSTs pass through, so without this every GET (status polling,
  // 23-get-invoice, reading back declared stores) fails with
  // NON_JSON_RESPONSE while writes look perfectly healthy.
  Accept: "application/json",
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
      headers: res.headers,
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
  // `headers` is exposed so callers can read response-only signals the body
  // doesn't carry — notably `Idempotency-Replayed: true` on a cached re-POST
  // (see examples/24-idempotent-retry.mjs). Most cases ignore it.
  return { status: res.status, headers: res.headers, envelope, payload };
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

/**
 * Declare your own store codes (the push equivalent of "list all locations").
 * `stores` is an array of `{ storeCode, name?, street?, city? }`. Each code you
 * send that we don't already hold becomes a PROPOSED location a business admin
 * accepts (or rejects) on the app's Locations screen — nothing is ever
 * auto-accepted, and re-declaring never overwrites a row the admin owns.
 * Payload: `{ declared, proposed: string[], alreadyKnown: string[] }`.
 */
export const declareStores = (stores) => call("POST", LOCATIONS, { stores });

/**
 * Read back what your declared (or invoice-discovered) store codes currently
 * resolve to. Payload: `{ stores: [{ storeCode, name, status, locationId }] }`,
 * where `status` is `'mapped'` (accepted — invoices carrying the code sign at
 * that location), `'proposed'` (awaiting an admin), or `'rejected'`.
 *
 * HTTP-sourced rows only: a location an admin created by hand has no store code
 * of yours, so it is not addressable through this surface and is not listed.
 */
export const listStores = () => call("GET", LOCATIONS);

const IN_FLIGHT = new Set([
  "pending",
  "imported",
  "processing",
  "queued",
  "received",
]);

/** Poll a (usually 202-queued) invoice until every payment result is terminal. */
/**
 * Ends the script with a message and a non-zero status, WITHOUT `process.exit`.
 *
 * `process.exit()` tears the process down while Node's fetch keep-alive socket
 * is still open, which on Windows aborts inside libuv:
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c
 * — a crash dump after a clean message, and a meaningless exit code (127).
 *
 * Setting `exitCode` and throwing lets the socket close on its own and still
 * exits non-zero. The stack is blanked because the message is the whole point;
 * a trace through the poller tells the reader nothing they need.
 */
export function failWith(message) {
  if (message) console.error(message);
  process.exitCode = 1;
  throw Object.assign(new Error("VSMS_CLEAN_EXIT"), { __cleanExit: true });
}

// The throw above unwinds the script (so no caller carries on with a payload
// that never fiscalised) but must not print anything: `failWith` has already
// said everything useful, and Node's default handler would append a stack
// through the poller that tells the reader nothing. Real errors still print.
const onFatal = (err) => {
  if (!err?.__cleanExit) console.error(err?.stack ?? String(err));
  process.exitCode = 1;
};
process.on("uncaughtException", onFatal);
process.on("unhandledRejection", onFatal);

/**
 * What an admin has to DO about each block reason — the poller prints these
 * rather than only echoing the code, because the code alone does not tell an
 * integrator whose problem it is (some are theirs, most are the merchant's).
 */
const BLOCK_REASON_FIXES = {
  MISSING_TAX_MAPPING:
    "a taxCode on this invoice is not mapped to a V-SDC label yet. Declare it (examples/21-declare-tax-rates.mjs), then have an admin map it on the Generic HTTP screen.",
  HTTP_STORE_NOT_MAPPED:
    "this invoice's storeCode is not mapped to a location. Map it on the Generic HTTP screen -> Stores tab (declare it first with examples/17-multi-location.mjs).",
  HTTP_STORE_LOCATION_NO_CERTIFICATE:
    "the store IS mapped, but its location holds no active certificate. Upload one for that location.",
  HTTP_STORE_CODE_REQUIRED:
    "no storeCode was sent and this business has several certified locations, so there is no way to tell which should sign. Send storeCode on every invoice.",
  REFERENT_NOT_FISCALISED:
    "the document this one refers to has not been signed yet. Fiscalise the source first.",
};

export async function pollUntilTerminal(invoiceId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  // Consecutive polls seeing "imported, eligible, never dispatched". A couple
  // of grace polls absorb the gap between a trigger returning and the job row
  // appearing; beyond that it is a standing state, not a slow one.
  let idlePolls = 0;
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

    // A BLOCKED payment is not in flight — it is parked until an admin fixes
    // something, so no amount of waiting will move it. Without this check the
    // loop burns the whole timeout and then reports "not terminal", which
    // describes the symptom and hides the cause. Stop on the first poll
    // instead and say what needs fixing.
    //
    // `eligibleForFiscalisation === false` is what separates blocked from
    // merely queued: a PROFORMA awaiting its explicit trigger is `imported`
    // too, but eligible, so it correctly keeps polling.
    const blocked = payload.paymentResults.filter(
      (p) => p.eligibleForFiscalisation === false,
    );
    if (blocked.length > 0) {
      const reasons = [
        ...new Set(blocked.flatMap((p) => p.fiscalisationBlockReasons ?? [])),
      ];
      console.error(
        `
✗ Invoice ${invoiceId} is BLOCKED — it will never fiscalise as-is, so this is not worth waiting for.` +
          `
  Reason(s): ${reasons.join(", ") || "(none reported)"}
`,
      );
      for (const r of reasons) {
        const fix = BLOCK_REASON_FIXES[r];
        if (fix)
          console.error(`  ${r}
    → ${fix}
`);
      }
      failWith(
        `  Once fixed, an admin's "Re-sync blocked invoices" releases this one in place —
` + `  you do not need to re-send it.`,
      );
    }

    // Nothing was ever dispatched: every payment is `imported`, none is
    // blocked, and no fiscalisation job exists. Polling cannot change that —
    // something has to ASK for this invoice to be signed. Two ways to get here:
    //   * a PROFORMA, which is never auto-dispatched. It fiscalises only on an
    //     explicit POST /fiscalise/:invoiceId/trigger (11-proforma-sale.mjs).
    //   * auto-fiscalise is off for this connector, so an admin fiscalises it
    //     from the app.
    // Either way, waiting out the timeout and reporting "not terminal" would
    // describe the symptom and hide both causes.
    const allImported = payload.paymentResults.every(
      (p) => String(p.status).toLowerCase() === "imported",
    );
    if (allImported && !payload.jobId) {
      if (++idlePolls >= 3) {
        failWith(
          `
✗ Invoice ${invoiceId} is imported and NOT blocked, but no fiscalisation job exists —
` +
            `  nothing is going to move it, so waiting will not help.

` +
            `  If this is a PROFORMA quote: it is never auto-dispatched. Trigger it with
` +
            `    POST /businesses/<businessId>/fiscalise/${invoiceId}/trigger
` +
            `  Otherwise auto-fiscalise is probably off for this connector — fiscalise it
` +
            `  from the app, or turn the setting on.`,
        );
      }
    } else {
      idlePolls = 0;
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
    failWith("");
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
 *
 * `taxCode` takes ONE code or AN ARRAY of them, exactly as the wire field does
 * — an item can be liable for several taxes at once (VAT plus a levy). It is
 * passed straight through; see 27-multi-tax-line.mjs for what that means.
 */
export function vatLine(
  description,
  unitPrice,
  quantity = 1,
  taxCode = "VAT15",
  gtin = null,
  ratePercent = null,
) {
  // Local display figure ONLY — V-SDC computes the real tax from the labels,
  // and with several taxes on a line there is no single rate to state anyway.
  // Zero-rated only when VAT0 is the line's *only* code; a naive
  // `taxCode === "VAT0"` would silently fall through to 15 for `["VAT0"]`,
  // and every derived amount would inherit that wrong rate while still
  // reconciling — a wrong number with no error.
  // `ratePercent` overrides the guess below. A line bearing SEVERAL taxes has
  // to state its COMBINED rate: there is one `taxRatePercent` per line however
  // many taxes apply, so leaving it at 15 while a second tax is also charged
  // understates the line and — because an unmapped code is recorded at this
  // rate — invites an admin to map that second code to a 15% label.
  const codes = Array.isArray(taxCode) ? taxCode : [taxCode];
  const rate =
    ratePercent ?? (codes.length === 1 && codes[0] === "VAT0" ? 0 : 15);
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

/**
 * YOUR store code — the caller's own identifier for the shop a sale rang up in,
 * sent on every invoice. It is NOT a VSMS Connect id, and it is deliberately a
 * literal in the test data rather than an env var: these files exist to show
 * the request body, and a field injected from the environment would be
 * invisible to anyone reading them.
 *
 * ONE-TIME SETUP: declare it (examples/17-multi-location.mjs declares this same
 * code) and map it to one of your business locations on the app's Generic HTTP
 * screen → Stores tab. Until it is mapped, invoices carrying it are accepted
 * and BLOCKED with HTTP_STORE_NOT_MAPPED — same shape as an unmapped taxCode.
 */
export const STORE_CODE = "STORE-PV-01";

export const BUYER = {
  tin: "123456",
  name: "Acme Trading Ltd",
  email: "accounts@acme-trading.test",
};
