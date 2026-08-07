# Local-AI Model Research — UnysonPlus Site Converter

**Date:** 2026-08-06
**Scope:** Which models the Site Converter's *local-AI tier* (Ollama on a user PC) should offer, optimized for the specific job: turn a captured region's **HTML + per-element computed styles** into **valid, schema-conforming JSON** that maps into UnysonPlus Theme Settings.
**Verification:** All tags/sizes below were checked live on `ollama.com/library` (not from memory) on 2026-08-06.

---

## Executive summary

- **The backbone should move from Qwen2.5 → Qwen3.** Qwen3 is the current Qwen generation on Ollama (Apache-2.0), and it is a strict upgrade for our task: better reasoning, better instruction-following, and — critically — **`qwen3:4b` ships a 256K context window at just 2.5 GB on disk**, which is unusual and ideal for feeding a whole header/footer's HTML+CSS. `qwen3:8b`/`14b`/`30b` scale quality up cleanly.
- **One caveat that matters for JSON:** Qwen3 is a *hybrid reasoning* model. If thinking mode is left on, the model emits a `<think>…</think>` monologue before the answer, which pollutes raw-JSON parsing. **We must disable thinking** for this task — send `/no_think` in the prompt (or `think:false` / `enable_thinking=false` via the Ollama API), and ideally pair it with Ollama's **`format` / JSON-schema grammar** parameter, which token-constrains output to valid JSON regardless of model. This single change is the highest-leverage reliability win available and applies to every model below.
- **Best value pick overall:** `qwen3:4b` — 2.5 GB, 256K context, Apache-2.0, runs on modest PCs, and is good enough to be the *default recommended* mainstream model. `qwen3:8b` is the *quality* pick when the PC can spare ~6 GB.
- **Vision tier:** replace `qwen2.5vl:7b` with **`qwen3-vl`** (real, current, Apache-2.0): `qwen3-vl:4b` (3.3 GB) and `qwen3-vl:8b` (6.1 GB), both 256K context, both explicitly built for "code/layout from design mockups" — a near-perfect fit for the screenshot visual-fix pass.
- **Strong structured-output specialists worth offering:** **IBM Granite 4** (`granite4:3b`, 2.1 GB, Apache-2.0) is purpose-tuned for instruction-following + tool-calling and is a great *light-tier* pick; **Mistral Small 3.2** (`mistral-small3.2:24b`, 15 GB, Apache-2.0, multimodal) is explicitly tuned for "precise instruction following" and "more robust function-calling template" — the best *enthusiast* instruction-follower and it also does vision.
- **Honest framing:** every local model still trails Claude on this task (subtle CSS→semantic-zone judgment is where they slip). The gap narrows sharply with size — a 14B/24B local model is usably close; a 3–4B model needs the JSON-grammar guardrail to stay reliable.

---

## Per-tier recommendation table

Sizes are the q4 default GGUF on disk; **plan for ~1.3–1.6× that in RAM/VRAM** at runtime with an 8–16K working context.

### Light tier (~2–4 GB RAM) — modest laptops / no dGPU
| Model (Ollama tag) | Params | ~Disk (q4) | Context | License | Take for our task |
|---|---|---|---|---|---|
| **`qwen3:4b`** ⭐ | 4B | 2.5 GB | **256K** | Apache-2.0 | Best light pick *and* good enough to be the default. Huge context, solid reasoning. Disable thinking for clean JSON. |
| `granite4:3b` | 3B | 2.1 GB | 128K | Apache-2.0 | Purpose-tuned for instruction-following + tool/function calling → emits tidy JSON for its size. Great low-RAM alternative. |
| `qwen3:1.7b` | 1.7B | 1.4 GB | 40K | Apache-2.0 | Emergency ultra-light. Reasoning is thin; only for very weak hardware, always with the JSON grammar on. |
| `llama3.2:3b` | 3B | 2.0 GB | 128K | Llama 3.2 Community | General small model; fine, but Qwen3 4B and Granite 3B out-follow it. Keep only as a familiar fallback. |

### Mainstream tier (~5–8 GB RAM) — typical gaming PC / 8 GB GPU
| Model | Params | ~Disk | Context | License | Take |
|---|---|---|---|---|---|
| **`qwen3:8b`** ⭐ | 8B | 5.2 GB | 40K | Apache-2.0 | The recommended *quality* default. Best instruction-following + HTML/CSS reasoning at a size most PCs handle. |
| `gemma3:4b` | 4B | 3.3 GB | 128K | Gemma Terms | Strong all-rounder and **multimodal** (can also read the screenshot) — handy if the user wants one model for both passes. Custom (not OSI) license. |

### Enthusiast tier (~12–24 GB RAM) — 16–24 GB GPU / big-RAM workstation
| Model | Params | ~Disk | Context | License | Take |
|---|---|---|---|---|---|
| **`qwen3:14b`** ⭐ | 14B | 9.3 GB | 40K | Apache-2.0 | Top dense quality that still fits a 12–16 GB card. The closest local model to "just works" on our mapping task. |
| `mistral-small3.2:24b` | 24B | 15 GB | 128K | Apache-2.0 | Explicitly tuned for precise instruction-following + robust function-calling, **and multimodal** — best single model if you can afford it. |
| `qwen3:30b` (30B-A3B MoE) | 30B / 3B active | 19 GB | **256K** | Apache-2.0 | MoE: 14B-class quality at ~4B inference speed if you have the RAM/VRAM. Fast + huge context. |

### Vision tier — for the screenshot-driven "visual fix" pass
| Model | Params | ~Disk | Context | License | Take |
|---|---|---|---|---|---|
| **`qwen3-vl:8b`** ⭐ | 8B | 6.1 GB | 256K | Apache-2.0 | Best local vision pick. Built for "generate code/layout from design mockups" + spatial grounding — exactly our use. |
| `qwen3-vl:4b` | 4B | 3.3 GB | 256K | Apache-2.0 | Lighter vision option for mainstream PCs; same capability family, smaller. |
| `gemma3:12b` | 12B | 8.1 GB | 128K | Gemma Terms | Strong multimodal alternative if the user already runs Gemma. Custom license. |
| `mistral-small3.2:24b` | 24B | 15 GB | 128K | Apache-2.0 | Doubles as the enthusiast text model *and* vision — good "one model, both passes" for big rigs. |

---

## Why these, in priority order

1. **Instruction-following + clean JSON (top priority).** Qwen3, Granite 4, and Mistral Small 3.2 are the three families explicitly tuned this generation for instruction adherence and function-calling (which is the same discipline as emitting a fixed JSON shape). Granite 4 and Mistral 3.2 call it out by name; Qwen3 backs it with the strongest small-model IFEval-class scores. **All three should be paired with Ollama's `format`/JSON-schema constraint** so output is grammar-guaranteed valid — this de-risks even the 3–4B models.
2. **HTML/CSS reasoning.** This is where size shows. 3–4B models make correct easy calls (logo vs. menu vs. CTA) but slip on ambiguous layout/behavior inference (sticky vs. static, bg token choice). 8B is the comfort floor; 14B/24B is where judgment gets reliable. Qwen3's reasoning-tuned line leads its size class.
3. **Context length.** Our payload (region HTML + per-element computed styles) is ~8–16K tokens. Everything recommended clears it; **Qwen3 4B/30B and all Qwen3-VL at 256K** give the most headroom for large headers/footers or multi-region batches. Note `qwen3:8b`/`14b`/`32b` are 40K (still plenty); only the 4B and MoE variants carry the 256K window.
4. **Hardware fit.** Tiers above map to real RAM budgets. The standout is `qwen3:4b` landing in the *light* tier on disk while punching at mainstream quality.
5. **Vision.** `qwen3-vl` is the current, correct replacement for the aging `qwen2.5vl` — same permissive license, newer, and marketed for the exact "design mockup → code" job.
6. **License.** Qwen3 / Qwen3-VL / Granite 4 / Mistral Small 3.2 are **Apache-2.0** (clean commercial use — preferred). **Gemma** is Google's *Gemma Terms of Use* (permissive but a custom license with a use-restriction/AUP, not OSI — usable but flag it). **Llama 3.2** is the Llama Community License (fine at our scale; has the >700M-MAU clause). Nothing recommended is non-commercial, but prefer the Apache options where all else is equal.

## Licensing notes (quick reference)
- **Apache-2.0 (safest):** Qwen3, Qwen3-VL, Qwen3-Coder, Granite 3.3 / Granite 4, Mistral Small 3.2. Ship freely.
- **Gemma Terms of Use:** Gemma 3 family — permissive, redistributable, but carries Google's prohibited-use policy; not OSI-approved. Offer, but don't call it "open source."
- **Llama 3.x Community License:** Llama 3.2 — fine for this product; the only real string is the 700M-MAU clause and attribution.
- **Phi-4 / Phi-4-mini:** MIT (Microsoft) — permissive.

---

## Models evaluated and where they landed
| Family | Verdict for this task |
|---|---|
| **Qwen3** (4B/8B/14B/30B/32B) | **Primary backbone.** Best IF + reasoning per size, Apache-2.0, 256K on 4B/30B. Adopt across tiers. Disable thinking. |
| **Qwen3-VL** (4B/8B/30B) | **New vision tier.** Purpose-built for design-mockup→code. Replaces qwen2.5vl. |
| **IBM Granite 4** (3B, MoE 7b-a1b/32b-a9b) | **Light-tier structured-output specialist.** Apache-2.0, IF/tool-calling tuned. Adopt `granite4:3b`. |
| **Mistral Small 3.2** (24B, multimodal) | **Enthusiast IF leader + vision.** Apache-2.0, "precise instruction following," robust function-calling. Adopt for big rigs. |
| **Gemma 3** (4B/12B/27B, multimodal) | Good multimodal all-rounders; keep `gemma3:4b`/`12b` as vision alternatives. Custom license — flag. |
| **Qwen2.5 / 2.5-VL** (current product default) | **Superseded by Qwen3 / Qwen3-VL.** Retire from the shortlist (still works, just no reason to prefer it now). |
| **Phi-4-mini** (3.8B, MIT) | Decent tiny reasoner, 128K ctx, function-calling — but Qwen3 4B / Granite 3B out-follow it for JSON. Drop from default shortlist. |
| **Llama 3.2 3B** (Community license) | Keep only as a familiar fallback; out-performed by Qwen3 4B and Granite 3B here. |
| **Llama 3.3 (8B-class), 3.2-Vision** | 3.3 has excellent IFEval, but Qwen3 8B matches it with a cleaner (Apache) license; not needed alongside Qwen3. |
| **DeepSeek-R1 distills / Coder-V2** | R1 distills are reasoning-verbose (leak think traces) → bad for terse JSON unless heavily constrained. Coder-V2 is code-gen, not our mapping job. Skip. |
| **Qwen3-Coder (30B/480B)** | Coder-agentic, big; overkill and not better than qwen3:14b for our schema-mapping. Skip. |
| **MiniCPM-V / moondream / llava** | Older/lighter vision; superseded by Qwen3-VL and Gemma 3 for quality. Skip. |
| **Command-R** | RAG/tool-calling focus, larger footprint, weaker cost/quality here. Skip. |

---

## What to change in the product

1. **Swap the backbone Qwen2.5 → Qwen3** and the vision model `qwen2.5vl:7b` → `qwen3-vl:8b` (with `qwen3-vl:4b` as the lighter option).
2. **Add the two structured-output specialists:** `granite4:3b` (light) and `mistral-small3.2:24b` (enthusiast/vision).
3. **Make `qwen3:4b` the recommended *value* default and `qwen3:8b` the recommended *quality* option** — the dashboard can suggest 4B by default and offer 8B when RAM allows.
4. **Runtime change (do this regardless of model list):** for every request to a Qwen3 model, **disable thinking** (`/no_think` in the prompt, or `think:false` on the `/api/chat` call) so no `<think>` block leaks into the JSON. Then **send Ollama's `format` parameter with the target JSON schema** so output is grammar-constrained to valid JSON. This is the single biggest reliability improvement and makes even the 3–4B tier dependable.
5. **Keep the honest UI framing** already in the notes: all local options trail Claude; the gap narrows with size. Present tiers by RAM so users self-select.
6. **Retire** `phi4-mini` and demote `qwen2.5:3b`/`llama3.2:3b` from the default shortlist (Qwen3 4B + Granite 3B cover that niche better).

---

## Proposed `LOCAL_AI_MODELS` replacement
See the ready-to-paste JS array delivered in the chat reply (same `{tag,label,params,ram,recommended?,vision?,note}` shape).

*Deliverable: this Markdown report. (No `.docx` was generated this run — Markdown was produced as the primary format; can render a `.docx` on request.)*
