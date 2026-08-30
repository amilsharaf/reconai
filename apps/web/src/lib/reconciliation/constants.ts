/**
 * Tolerances and thresholds for the deterministic reconciliation engine.
 *
 * Every value here is derived from the actual shape of the anomalies the
 * synthetic generator injects (scripts/generate_synthetic_data.py) — each
 * tolerance sits comfortably between "normal" noise and the smallest real
 * anomaly of its kind, verified against the generator's own math below.
 */

/** Standard settlement math (matches scripts/generate_synthetic_data.py). */
export const RAZORPAY_FEE_RATE = 0.02; // 2%
export const GST_RATE_ON_FEE = 0.18; // 18% GST on the platform fee

/**
 * Settlement fee vs. payment fee should be identical under normal
 * conditions (both derive from the same rate at capture time). The
 * smallest injected FEE_MISMATCH is +0.5% on the smallest order
 * (₹199 → ~99 paise), so 5 paise safely separates rounding noise from a
 * real mismatch.
 */
export const FEE_TOLERANCE_PAISE = 5;

/**
 * Bank-confirmed amount vs. expected net. The smallest injected
 * AMOUNT_MISMATCH is ₹5 (500 paise); ₹1 (100 paise) absorbs rounding
 * noise only.
 */
export const AMOUNT_TOLERANCE_PAISE = 100;

/**
 * Settlement → bank credit lag. Normal lag in the generator is 0-1 days;
 * the smallest injected TIMING anomaly is +10 days. 3 days is a safe
 * midpoint.
 */
export const TIMING_TOLERANCE_DAYS = 3;

/**
 * ₹-value threshold above which a REVIEW-grade exception is escalated to
 * INVESTIGATE regardless of confidence — money at risk above ₹100 is
 * treated as material.
 */
export const MATERIALITY_PAISE = 100_00; // ₹100
