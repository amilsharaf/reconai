# ReconAI

AI Finance Controller — multi-source reconciliation across orders, payments,
settlements, and bank records. Deterministic core, AI explains — never
calculates.

Built for the Razorpay Internship, Track 04.

**Start here:** [`PROJECT_SUMMARY.md`](./PROJECT_SUMMARY.md) — purpose,
scope, frozen technology decisions, repository structure.

**Then:** [`IMPLEMENTATION_ROADMAP.md`](./IMPLEMENTATION_ROADMAP.md) — the
day-by-day build plan and what has actually shipped so far.

## Quickstart

```bash
# Install app dependencies
npm install

# Generate the synthetic dataset (1,000 records, fixed seed)
cd scripts
pip install -r requirements.txt
python generate_synthetic_data.py

# Load it into Supabase (requires .env — see .env.example)
python load_synthetic_data.py
```

Metrics, architecture details, and honest limitations will be documented
here as the build progresses (Phase 7 — see the roadmap).
