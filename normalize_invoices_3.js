// =============================================================
// n8n Code Node — Invoice Normalizer
// Vendors: Reliable Parts, Marcone (credits only), Encompass
//
// GE and LG removed — will be added when access + samples are available.
//
// USAGE:
//   - Place this after the Merge node in your n8n workflow
//   - The Merge node should combine all vendor HTTP responses
//   - Each input item must have a `vendor` field set upstream
//     (add a Set node before Merge for each vendor branch to
//      inject vendor: "reliable" | "marcone" | "encompass")
//   - Output: one normalized invoice object per line item
//   - NOTE: Marcone filters to credit memos and warranty credits only.
//     Regular Marcone invoices are skipped and logged with _skipped: true.
//   - NOTE: Encompass reads from Excel via Spreadsheet File node.
//     Column headers map exactly to Excel columns (see normalizeEncompass).
//
// STANDARD SCHEMA OUTPUT:
//   vendor            string   — source vendor name
//   invoice_no        string   — credit memo / invoice number
//   invoice_type      string   — "invoice" | "credit_memo" | "warranty_credit" | "warranty" | "credit_reprint"
//   invoice_date      string   — ISO 8601 date (YYYY-MM-DD)
//   po_number         string   — purchase order / reference number
//   part_no           string   — manufacturer part number
//   description       string   — part description / credit reason
//   qty_shipped       number   — quantity shipped
//   unit_price        number   — price per unit
//   amount            number   — extended amount (negative = credit)
//   total             number   — invoice/memo total
//   claim_number      string   — warranty claim number (where applicable)
//   raw               object   — original parsed data (for audit trail)
// =============================================================

// ---------- helpers ----------

function parseDate(str) {
  if (!str) return null;
  const s = str.toString().trim();

  // MM/DD/YYYY
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2,'0')}-${mdy[2].padStart(2,'0')}`;

  // MM/DD/YY
  const mdy2 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (mdy2) {
    const yr = parseInt(mdy2[3]) >= 50 ? `19${mdy2[3]}` : `20${mdy2[3]}`;
    return `${yr}-${mdy2[1].padStart(2,'0')}-${mdy2[2].padStart(2,'0')}`;
  }

  // YYYY-MM-DD passthrough
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  return s; // return raw if unrecognised
}

function parseMoney(val) {
  if (val === null || val === undefined || val === '') return 0;
  const n = parseFloat(
    val.toString()
      .replace(/[$,\s]/g, '')
      .replace(/\(([^)]+)\)/, '-$1') // (609.11) -> -609.11
  );
  return isNaN(n) ? 0 : n;
}

function parseQty(val) {
  if (val === null || val === undefined || val === '') return 0;
  const n = parseInt(val.toString().replace(/[^0-9\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

function inferType(str) {
  if (!str) return 'invoice';
  const s = str.toString().toLowerCase();
  if (s.includes('credit-reprint') || s.includes('credit_reprint')) return 'credit_reprint';
  if (s.includes('warranty credit') || s.includes('warranty_credit')) return 'warranty_credit';
  if (s.includes('warranty')) return 'warranty';
  if (s.includes('credit memo') || s.includes('credit_memo')) return 'credit_memo';
  return 'invoice';
}

// ---------- vendor normalizers ----------

function normalizeReliable(data) {
  // Expected parsed fields from Reliable Parts portal / scraped HTML:
  // invoice_no, order_no, order_date, inv_date, part_no, description,
  // qty_ordered, qty_shipped, qty_backordered, suggested_list, price, amount,
  // credit_note_total, terms, transport
  //
  // Sample: Invoice 2847977, date 05/01/26, part W11612326, Wash Pump, qty 1, $50.58
  // NOTE: field names pending real HTML snippet — update when available
  const lines = Array.isArray(data.line_items) ? data.line_items : [data];

  return lines.map(line => ({
    vendor:          'Reliable Parts',
    invoice_no:      (data.invoice_no || data.invoiceNo || '').toString().trim(),
    invoice_type:    inferType(data.document_type || data.type || 'warranty'),
    invoice_date:    parseDate(data.inv_date || data.invoice_date || data.order_date),
    po_number:       (data.your_order_number || data.order_no || data.po_number || '').toString().trim(),
    part_no:         (line.part_no || line.partNo || line.sku || '').toString().trim(),
    description:     (line.description || line.product || '').toString().trim(),
    qty_shipped:     parseQty(line.qty_shipped ?? line.shipped ?? 0),
    unit_price:      parseMoney(line.price ?? line.unit_price ?? 0),
    amount:          parseMoney(line.amount ?? 0),
    total:           parseMoney(data.credit_note_total ?? data.order_total ?? data.amount ?? 0),
    claim_number:    '',
    raw:             data,
  }));
}

function normalizeMarcone(data) {
  // Marcone — CREDITS ONLY (warranty_credit and credit_memo).
  // Regular invoices are skipped and returned with _skipped: true.
  //
  // Expected parsed fields from Marcone portal:
  // order_number, order_date, invoice_number, invoice_date,
  // po_number, make_part_number, description, qty_ordered, qty_shipped,
  // qty_backordered, price, total, sub_total, document_type ("Warranty Credit")
  //
  // Sample: Invoice 73674443, date 05/01/2026, part 5304536563, PC Board, qty -1, -$609.11

  const type = inferType(data.document_type || data.type || '');

  // Skip anything that is not a credit
  if (type !== 'warranty_credit' && type !== 'credit_memo') {
    return [{
      _skipped:     true,
      _skipped_msg: `Marcone invoice skipped — not a credit (type: "${type}"). Will be included in a future phase.`,
      vendor:       'Marcone',
      invoice_no:   (data.invoice_number || data.order_number || '').toString().trim(),
      invoice_type: type,
      raw:          data,
    }];
  }

  const lines = Array.isArray(data.line_items) ? data.line_items : [data];

  return lines.map(line => ({
    vendor:          'Marcone',
    invoice_no:      (data.invoice_number || data.order_number || data.invoiceNumber || '').toString().trim(),
    invoice_type:    type,
    invoice_date:    parseDate(data.invoice_date || data.invoiceDate || data.order_date),
    po_number:       (data.po_number || data.poNumber || data.narda || '').toString().trim(),
    part_no:         (line.make_part_number || line.part_no || line.partNumber || '').toString().trim(),
    description:     (line.description || '').toString().trim(),
    qty_shipped:     parseQty(line.qty_shipped ?? line.shipped ?? 0),
    unit_price:      parseMoney(line.price ?? line.unit_price ?? 0),
    amount:          parseMoney(line.total ?? line.amount ?? 0),
    total:           parseMoney(data.sub_total ?? data.total ?? 0),
    claim_number:    '',
    raw:             data,
  }));
}

function normalizeEncompass(data) {
  // Encompass Supply Chain Solutions — Excel file input
  //
  // Excel column headers map directly to these JSON keys after
  // passing through n8n's Spreadsheet File node:
  //
  //   CreditMemo#          -> invoice_no
  //   OriginalInvoice#     -> original_invoice (audit trail)
  //   InvoiceDate          -> invoice_date
  //   Order#               -> order_number
  //   OrderDate            -> order_date
  //   Reference#_PO#       -> po_number
  //   ShipToName           -> ship_to_name
  //   LineCode             -> line_code (manufacturer)
  //   PartNumber           -> part_no
  //   QuantityShipped      -> qty_shipped
  //   UnitPartCharge       -> unit_price
  //   ExtendedPartCharge   -> amount
  //   CoreFlag             -> core_flag
  //   ClaimNumber          -> claim_number
  //   CreditReason         -> description

  return [{
    vendor:           'Encompass',
    invoice_no:       (data['CreditMemo#'] || '').toString().trim(),
    invoice_type:     'credit_memo',
    invoice_date:     parseDate(data['InvoiceDate']),
    po_number:        (data['Reference#_PO#'] || '').toString().trim(),
    part_no:          (data['PartNumber'] || '').toString().trim(),
    description:      (data['CreditReason'] || '').toString().trim(),
    qty_shipped:      parseQty(data['QuantityShipped'] ?? 0),
    unit_price:       parseMoney(data['UnitPartCharge'] ?? 0),
    amount:           parseMoney(data['ExtendedPartCharge'] ?? 0),
    total:            parseMoney(data['ExtendedPartCharge'] ?? 0),
    claim_number:     (data['ClaimNumber'] || '').toString().trim(),
    // audit fields preserved in raw but also surfaced here for ServiceDesk
    original_invoice: (data['OriginalInvoice#'] || '').toString().trim(),
    order_number:     (data['Order#'] || '').toString().trim(),
    ship_to:          (data['ShipToName'] || '').toString().trim(),
    line_code:        (data['LineCode'] || '').toString().trim(),
    core_flag:        (data['CoreFlag'] || '').toString().trim(),
    raw:              data,
  }];
}

// GE Appliances — removed. Will be added when access and sample data are available.
// LG Electronics — removed. Will be added when access and sample data are available.

// ---------- router ----------

const NORMALIZERS = {
  reliable:  normalizeReliable,
  marcone:   normalizeMarcone,
  encompass: normalizeEncompass,
  // ge and lg — coming soon
};

// ---------- main ----------

const results = [];

for (const item of $input.all()) {
  const raw = item.json;

  // Each item must have a `vendor` key injected by a Set node upstream.
  // Value should be one of: reliable | marcone | encompass
  const vendorKey = (raw.vendor || '').toString().toLowerCase().trim();

  const normalizer = NORMALIZERS[vendorKey];

  if (!normalizer) {
    results.push({
      json: {
        _error:     true,
        _error_msg: `Unknown vendor key: "${vendorKey}". Add a Set node upstream to inject vendor name.`,
        raw,
      }
    });
    continue;
  }

  try {
    const normalized = normalizer(raw);
    for (const invoice of normalized) {
      invoice._error     = !invoice._skipped && (!invoice.invoice_no || invoice.amount === 0);
      invoice._error_msg = invoice._error
        ? `Missing invoice_no or zero amount (vendor: ${vendorKey})`
        : null;

      results.push({ json: invoice });
    }
  } catch (err) {
    results.push({
      json: {
        _error:     true,
        _error_msg: `Normalizer threw for vendor "${vendorKey}": ${err.message}`,
        raw,
      }
    });
  }
}

return results;
