/**
 * Manifest-pinned typed scoring: Unicode, monetary and date normalization
 * under the suite's frozen normalizer configuration. All comparisons are
 * deterministic and produce interpretable field errors (FR-05/INV-05).
 */

export interface NormalizerConfig {
  unicode?: string;
  dateFormats: string[];
  money: { decimalSeparator: string; thousandsSeparator?: string; currency?: string };
  field_types?: Record<string, "date" | "money" | "text">;
}

export interface FieldResult {
  field: string;
  outcome: string; // 'correct' or an interpretable error code
}

export interface ScoreResult {
  fieldsCorrect: number;
  fieldsTotal: number;
  accepted: boolean;
  fieldResults: FieldResult[];
}

const DEFAULT_FIELD_TYPES: Record<string, "date" | "money" | "text"> = {
  date: "date",
  tax: "money",
  total: "money",
};

function nfc(v: string, cfg: NormalizerConfig): string {
  return cfg.unicode === "NFC" ? v.normalize("NFC") : v;
}

/** Convert a date-format token string (YYYY-MM-DD etc.) into a regex+decoder. */
function compileDateFormat(fmt: string): { re: RegExp; toIso: (m: RegExpMatchArray) => string | null } {
  const esc = fmt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let idx = 0;
  const order: string[] = [];
  const pattern = esc.replace(/YYYY|MM|DD/g, (tok) => {
    order.push(tok);
    return `(\\d{${tok === "YYYY" ? 4 : 2}})`;
  });
  const re = new RegExp(`^${pattern}$`);
  return {
    re,
    toIso: (m) => {
      const parts: Record<string, string> = {};
      order.forEach((tok, i) => (parts[tok] = m[i + 1]));
      const y = parts.YYYY, mo = parts.MM, d = parts.DD;
      if (!y || !mo || !d) return null;
      const mi = Number(mo), di = Number(d);
      if (mi < 1 || mi > 12 || di < 1 || di > 31) return null;
      return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
    },
  };
}

function compareDate(label: string, raw: string, cfg: NormalizerConfig): string {
  const labelIso = label.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(labelIso)) return "label_invalid";
  const value = nfc(raw.trim(), cfg);
  const isos = new Set<string>();
  let matchedFmt = 0;
  for (const fmt of cfg.dateFormats) {
    const { re, toIso } = compileDateFormat(fmt);
    const m = value.match(re);
    if (!m) continue;
    matchedFmt++;
    const parsed = toIso(m);
    if (parsed === null) return "date_invalid";
    isos.add(parsed);
  }
  if (matchedFmt === 0) return "date_format_not_allowed";
  if (isos.size > 1) return "date_ambiguous";
  const [iso] = isos;
  return iso === labelIso ? "correct" : "date_mismatch";
}

function parseMoney(raw: string, cfg: NormalizerConfig): number | null {
  let v = nfc(raw.trim(), cfg);
  if (cfg.money.currency) {
    v = v.replace(new RegExp(`\\b${cfg.money.currency}\\b`, "g"), "");
  }
  v = v.replace(/[$€£₹]/g, "").trim();
  if (cfg.money.thousandsSeparator) {
    v = v.split(cfg.money.thousandsSeparator).join("");
  }
  if (cfg.money.decimalSeparator !== ".") {
    v = v.replace(cfg.money.decimalSeparator, ".");
  }
  if (!/^-?\d+(\.\d{1,2})?$/.test(v)) return null;
  return Math.round(parseFloat(v) * 100);
}

function compareMoney(label: string, raw: string, cfg: NormalizerConfig): string {
  const expected = parseMoney(label, cfg);
  const actual = parseMoney(raw, cfg);
  if (actual === null) return "amount_unparseable";
  if (expected === null) return "label_invalid";
  return actual === expected ? "correct" : "amount_mismatch";
}

function compareText(label: string, raw: string, cfg: NormalizerConfig): string {
  return nfc(label.trim(), cfg) === nfc(raw.trim(), cfg) ? "correct" : "value_mismatch";
}

export function scoreExtraction(
  labels: Record<string, string>,
  responseFields: Record<string, string> | undefined,
  normalizer: NormalizerConfig,
  mandatoryFields: string[],
): ScoreResult {
  const fieldTypes = { ...DEFAULT_FIELD_TYPES, ...(normalizer.field_types ?? {}) };
  const fieldResults: FieldResult[] = [];
  let correct = 0;
  for (const field of mandatoryFields) {
    const label = labels[field];
    const raw = responseFields?.[field];
    let outcome: string;
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      outcome = "field_missing";
    } else {
      const type = fieldTypes[field] ?? "text";
      outcome =
        type === "date"
          ? compareDate(label, String(raw), normalizer)
          : type === "money"
            ? compareMoney(label, String(raw), normalizer)
            : compareText(label, String(raw), normalizer);
    }
    if (outcome === "correct") correct++;
    fieldResults.push({ field, outcome });
  }
  return {
    fieldsCorrect: correct,
    fieldsTotal: mandatoryFields.length,
    accepted: correct === mandatoryFields.length,
    fieldResults,
  };
}
