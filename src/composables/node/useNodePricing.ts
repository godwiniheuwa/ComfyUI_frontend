// JSONata-based pricing badge evaluation for API nodes.
//
// IMPORTANT (current phase):
// - Rules are declared locally in this file (LOCAL_PRICING_RULES) so we can migrate
//   existing pricing badges and validate behavior end-to-end.
// - Once ComfyUI injects `pricing_bundle` into the schema, LOCAL_PRICING_RULES will be
//   replaced by rules loaded from schema (and this file will only contain the evaluator).
//
// JSONata v2.x NOTE:
// - jsonata(expression).evaluate(input) returns a Promise in JSONata 2.x.
// - Therefore, pricing evaluation is async. This file implements:
//   - sync getter (returns cached label / last-known label),
//   - async evaluation + cache,
//   - reactive tick to update UI when async evaluation completes.

import { ref, readonly } from 'vue'
import { formatCreditsFromUsd } from '@/base/credits/comfyCredits'
import type { LGraphNode } from '@/lib/litegraph/src/litegraph'
import jsonata from 'jsonata'

const DEFAULT_NUMBER_OPTIONS: Intl.NumberFormatOptions = {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0
}

type CreditFormatOptions = {
  suffix?: string
  note?: string
  approximate?: boolean
  separator?: string
}

const formatCreditsValue = (usd: number): string =>
  formatCreditsFromUsd({
    usd,
    numberOptions: DEFAULT_NUMBER_OPTIONS
  })

const makePrefix = (approximate?: boolean) => (approximate ? '~' : '')

const makeSuffix = (suffix?: string) => suffix ?? '/Run'

const appendNote = (note?: string) => (note ? ` ${note}` : '')

const formatCreditsLabel = (
  usd: number,
  { suffix, note, approximate }: CreditFormatOptions = {}
): string =>
  `${makePrefix(approximate)}${formatCreditsValue(usd)} credits${makeSuffix(suffix)}${appendNote(note)}`

const formatCreditsRangeLabel = (
  minUsd: number,
  maxUsd: number,
  { suffix, note, approximate }: CreditFormatOptions = {}
): string => {
  const min = formatCreditsValue(minUsd)
  const max = formatCreditsValue(maxUsd)
  const rangeValue = min === max ? min : `${min}-${max}`
  return `${makePrefix(approximate)}${rangeValue} credits${makeSuffix(suffix)}${appendNote(note)}`
}

const formatCreditsListLabel = (
  usdValues: number[],
  { suffix, note, approximate, separator }: CreditFormatOptions = {}
): string => {
  const parts = usdValues.map((value) => formatCreditsValue(value))
  const value = parts.join(separator ?? '/')
  return `${makePrefix(approximate)}${value} credits${makeSuffix(suffix)}${appendNote(note)}`
}

// -----------------------------
// JSONata pricing types
// -----------------------------
type PricingResult =
  | { type: 'text'; text: string }
  | { type: 'usd'; usd: number; format?: CreditFormatOptions }
  | {
      type: 'range_usd'
      min_usd: number
      max_usd: number
      format?: CreditFormatOptions
    }
  | { type: 'list_usd'; usd: number[]; format?: CreditFormatOptions }

type NormalizedWidgetValue = {
  raw: unknown
  s: string
  n: number | null
  b: boolean | null
}

type JsonataPricingRule = {
  engine: 'jsonata'
  depends_on: { widgets: string[]; inputs: string[] }
  result_defaults?: CreditFormatOptions
  expr: string
}

type CompiledJsonataPricingRule = JsonataPricingRule & {
  _compiled: { evaluate: (input: unknown) => unknown } | null
}

type JsonataEvalContext = {
  w: Record<string, NormalizedWidgetValue>
  i: Record<string, { connected: boolean }>
}

// -----------------------------
// Normalization helpers
// -----------------------------
const asFiniteNumber = (v: unknown): number | null => {
  if (v === null || v === undefined) return null

  if (typeof v === 'number') return Number.isFinite(v) ? v : null

  if (typeof v === 'string') {
    const t = v.trim()
    if (t === '') return null
    const n = Number(t)
    return Number.isFinite(n) ? n : null
  }

  // Do not coerce booleans/objects into numbers for pricing purposes.
  return null
}

const normalizeWidgetValue = (raw: unknown): NormalizedWidgetValue => {
  const s =
    raw === undefined || raw === null ? '' : String(raw).trim().toLowerCase()

  const n = asFiniteNumber(raw)

  let b: boolean | null = null
  if (typeof raw === 'boolean') {
    b = raw
  } else if (typeof raw === 'string') {
    const ls = raw.trim().toLowerCase()
    if (ls === 'true') b = true
    else if (ls === 'false') b = false
  }

  return { raw, s, n, b }
}

const buildJsonataContext = (
  node: LGraphNode,
  rule: JsonataPricingRule
): JsonataEvalContext => {
  const w: Record<string, NormalizedWidgetValue> = {}
  for (const name of rule.depends_on.widgets) {
    const widget = node.widgets?.find((x: any) => x?.name === name)
    w[name] = normalizeWidgetValue(widget?.value)
  }

  const i: Record<string, { connected: boolean }> = {}
  for (const name of rule.depends_on.inputs) {
    const slot = node.inputs?.find((x: any) => x?.name === name)
    i[name] = { connected: slot?.link != null }
  }

  return { w, i }
}

const safeValueForSig = (v: unknown): string => {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
    return String(v)
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

// Signature determines whether we need to re-evaluate when widgets/inputs change.
const buildSignature = (
  ctx: JsonataEvalContext,
  rule: JsonataPricingRule
): string => {
  const parts: string[] = []
  for (const name of rule.depends_on.widgets) {
    parts.push(`w:${name}=${safeValueForSig(ctx.w[name]?.raw)}`)
  }
  for (const name of rule.depends_on.inputs) {
    parts.push(`i:${name}=${ctx.i[name]?.connected ? '1' : '0'}`)
  }
  return parts.join('|')
}

// -----------------------------
// Result formatting
// -----------------------------
const formatPricingResult = (
  result: unknown,
  defaults: CreditFormatOptions = {}
): string => {
  if (!result || typeof result !== 'object') return ''

  const r = result as Partial<PricingResult>

  if (r.type === 'text') {
    return (r as any).text ?? ''
  }

  if (r.type === 'usd') {
    const usd = asFiniteNumber((r as any).usd)
    if (usd === null) return ''
    const fmt = { ...defaults, ...((r as any).format ?? {}) }
    return formatCreditsLabel(usd, fmt)
  }

  if (r.type === 'range_usd') {
    const minUsd = asFiniteNumber((r as any).min_usd)
    const maxUsd = asFiniteNumber((r as any).max_usd)
    if (minUsd === null || maxUsd === null) return ''
    const fmt = { ...defaults, ...((r as any).format ?? {}) }
    return formatCreditsRangeLabel(minUsd, maxUsd, fmt)
  }

  if (r.type === 'list_usd') {
    const arr = Array.isArray((r as any).usd) ? (r as any).usd : null
    if (!arr) return ''

    const usdValues = arr
      .map(asFiniteNumber)
      .filter((x: any) => x != null) as number[]

    if (usdValues.length === 0) return ''

    const fmt = { ...defaults, ...((r as any).format ?? {}) }
    return formatCreditsListLabel(usdValues, fmt)
  }

  return ''
}

// -----------------------------
// Compile rules (non-fatal)
// -----------------------------
const compileRule = (rule: JsonataPricingRule): CompiledJsonataPricingRule => {
  try {
    return { ...rule, _compiled: jsonata(rule.expr) as any }
  } catch (e) {
    // Do not crash app on bad expressions; just disable rule.
    console.error('[pricing/jsonata] failed to compile expr:', rule.expr, e)
    return { ...rule, _compiled: null }
  }
}

// -----------------------------
// JSONata expression helpers
// -----------------------------
// const exprText = (text: string): string =>
//   JSON.stringify({ type: 'text', text })

const exprUsd = (usd: number, format?: CreditFormatOptions): string =>
  JSON.stringify(format ? { type: 'usd', usd, format } : { type: 'usd', usd })

// const exprRangeUsd = (
//   min_usd: number,
//   max_usd: number,
//   format?: CreditFormatOptions
// ): string =>
//   JSON.stringify(
//     format
//       ? { type: 'range_usd', min_usd, max_usd, format }
//       : { type: 'range_usd', min_usd, max_usd }
//   )
//
// const exprListUsd = (usd: number[], format?: CreditFormatOptions): string =>
//   JSON.stringify(
//     format ? { type: 'list_usd', usd, format } : { type: 'list_usd', usd }
//   )

// -----------------------------
// Local pricing rules (TEMPORARY)
// -----------------------------
// These are the migrated equivalents of the old useNodePricing.ts pricing logic.
// When schema-injected pricing_bundle is available, this map should be replaced
// by rules loaded from schema.
const LOCAL_PRICING_RULES: Record<string, JsonataPricingRule> = {
  ByteDanceSeedreamNode: {
    engine: 'jsonata',
    depends_on: { widgets: ['model'], inputs: [] },
    expr: `(
      $price := $contains(w.model.s, "seedream-4-5-251128") ? 0.04 : 0.03;
      {"type":"usd","usd": $price, "format":{"suffix":" x images/Run","approximate":true}}
    )`
  },
  ByteDanceTextToVideoNode: {
    engine: 'jsonata',
    depends_on: { widgets: ['model', 'duration', 'resolution'], inputs: [] },
    expr: `(
      $p := {
        "seedance-1-0-pro": {
          "480p":[0.23,0.24],
          "720p":[0.51,0.56],
          "1080p":[1.18,1.22]
        },
        "seedance-1-0-pro-fast": {
          "480p":[0.09,0.1],
          "720p":[0.21,0.23],
          "1080p":[0.47,0.49]
        },
        "seedance-1-0-lite": {
          "480p":[0.17,0.18],
          "720p":[0.37,0.41],
          "1080p":[0.85,0.88]
        }
      };

      $r := $p[w.model.s][w.resolution.s];
      $scale := w.duration.n / 10;
      $min := $r[0] * $scale;
      $max := $r[1] * $scale;

      ($min = $max)
        ? {"type":"usd","usd": $min}
        : {"type":"range_usd","min_usd": $min, "max_usd": $max}
    )`
  },
  ByteDanceImageToVideoNode: {
    engine: 'jsonata',
    depends_on: { widgets: ['model', 'duration', 'resolution'], inputs: [] },
    expr: `(
      $p := {
        "seedance-1-0-pro": {
          "480p":[0.23,0.24],
          "720p":[0.51,0.56],
          "1080p":[1.18,1.22]
        },
        "seedance-1-0-pro-fast": {
          "480p":[0.09,0.1],
          "720p":[0.21,0.23],
          "1080p":[0.47,0.49]
        },
        "seedance-1-0-lite": {
          "480p":[0.17,0.18],
          "720p":[0.37,0.41],
          "1080p":[0.85,0.88]
        }
      };

      $r := $p[w.model.s][w.resolution.s];
      $scale := w.duration.n / 10;
      $min := $r[0] * $scale;
      $max := $r[1] * $scale;

      ($min = $max)
        ? {"type":"usd","usd": $min}
        : {"type":"range_usd","min_usd": $min, "max_usd": $max}
    )`
  },
  ByteDanceFirstLastFrameNode: {
    engine: 'jsonata',
    depends_on: { widgets: ['model', 'duration', 'resolution'], inputs: [] },
    expr: `(
      $p := {
        "seedance-1-0-pro": {
          "480p":[0.23,0.24],
          "720p":[0.51,0.56],
          "1080p":[1.18,1.22]
        },
        "seedance-1-0-pro-fast": {
          "480p":[0.09,0.1],
          "720p":[0.21,0.23],
          "1080p":[0.47,0.49]
        },
        "seedance-1-0-lite": {
          "480p":[0.17,0.18],
          "720p":[0.37,0.41],
          "1080p":[0.85,0.88]
        }
      };

      $r := $p[w.model.s][w.resolution.s];
      $scale := w.duration.n / 10;
      $min := $r[0] * $scale;
      $max := $r[1] * $scale;

      ($min = $max)
        ? {"type":"usd","usd": $min}
        : {"type":"range_usd","min_usd": $min, "max_usd": $max}
    )`
  },
  ByteDanceImageReferenceNode: {
    engine: 'jsonata',
    depends_on: { widgets: ['model', 'duration', 'resolution'], inputs: [] },
    expr: `(
      $p := {
        "seedance-1-0-pro": {
          "480p":[0.23,0.24],
          "720p":[0.51,0.56],
          "1080p":[1.18,1.22]
        },
        "seedance-1-0-pro-fast": {
          "480p":[0.09,0.1],
          "720p":[0.21,0.23],
          "1080p":[0.47,0.49]
        },
        "seedance-1-0-lite": {
          "480p":[0.17,0.18],
          "720p":[0.37,0.41],
          "1080p":[0.85,0.88]
        }
      };

      $r := $p[w.model.s][w.resolution.s];
      $scale := w.duration.n / 10;
      $min := $r[0] * $scale;
      $max := $r[1] * $scale;

      ($min = $max)
        ? {"type":"usd","usd": $min}
        : {"type":"range_usd","min_usd": $min, "max_usd": $max}
    )`
  },
  FluxProExpandNode: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: exprUsd(0.05)
  },
  FluxProFillNode: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: exprUsd(0.05)
  },
  FluxProUltraImageNode: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: exprUsd(0.06)
  },
  FluxProKontextProNode: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: exprUsd(0.04)
  },
  FluxProKontextMaxNode: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: exprUsd(0.08)
  },
  Flux2ProImageNode: {
    engine: 'jsonata',
    depends_on: { widgets: ['width', 'height'], inputs: ['images'] },
    expr: `(
      $MP := 1024 * 1024;
      $outMP := $max([1, $floor(((w.width.n * w.height.n) + $MP - 1) / $MP)]);
      $outputCost := 0.03 + 0.015 * ($outMP - 1);
  
      i.images.connected
        ? {
            "type":"range_usd",
            "min_usd": $outputCost + 0.015,
            "max_usd": $outputCost + 0.12,
            "format": { "approximate": true }
          }
        : {"type":"usd","usd": $outputCost}
    )`
  },
  Flux2MaxImageNode: {
    engine: 'jsonata',
    depends_on: { widgets: ['width', 'height'], inputs: ['images'] },
    expr: `(
      $MP := 1024 * 1024;
      $outMP := $max([1, $floor(((w.width.n * w.height.n) + $MP - 1) / $MP)]);
      $outputCost := 0.07 + 0.03 * ($outMP - 1);

      i.images.connected
        ? {
            "type":"range_usd",
            "min_usd": $outputCost + 0.03,
            "max_usd": $outputCost + 0.24
          }
        : {"type":"usd","usd": $outputCost}
    )`
  },
  GeminiNode: {
    engine: 'jsonata',
    depends_on: { widgets: ['model'], inputs: [] },
    result_defaults: { suffix: ' per 1K tokens' },
    expr: `(
      $m := w.model.s;

      $contains($m, "veo-2.0")
        ? {"type":"usd","usd":0.5,"format":{"suffix":"/second"}}
        : $contains($m, "gemini-2.5-flash")
          ? {"type":"list_usd","usd":[0.0003,0.0025]}
          : $contains($m, "gemini-2.5-pro")
            ? {"type":"list_usd","usd":[0.00125,0.01]}
            : $contains($m, "gemini-3-pro-preview")
              ? {"type":"list_usd","usd":[0.002,0.012]}
              : {"type":"text","text":"Token-based"}
    )`
  },
  GeminiImageNode: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: `{"type":"usd","usd":0.039,"format":{"suffix":"/Image (1K)","approximate":true}}`
  },
  GeminiImage2Node: {
    engine: 'jsonata',
    depends_on: { widgets: ['resolution'], inputs: [] },
    expr: `(
      $r := w.resolution.s;

      ($contains($r,"1k") or $contains($r,"2k"))
        ? {"type":"usd","usd":0.134,"format":{"suffix":"/Image","approximate":true}}
        : $contains($r,"4k")
          ? {"type":"usd","usd":0.24,"format":{"suffix":"/Image","approximate":true}}
          : {"type":"text","text":"Token-based"}
    )`
  },
  IdeogramV1: {
    engine: 'jsonata',
    depends_on: { widgets: ['num_images', 'turbo'], inputs: [] },
    expr: `(
      $n := w.num_images.n;
      $base := (w.turbo.b = true) ? 0.0286 : 0.0858;
      {"type":"usd","usd": $round($base * $n, 2)}
    )`
  },
  IdeogramV2: {
    engine: 'jsonata',
    depends_on: { widgets: ['num_images', 'turbo'], inputs: [] },
    expr: `(
      $n := w.num_images.n;
      $base := (w.turbo.b = true) ? 0.0715 : 0.1144;
      {"type":"usd","usd": $round($base * $n, 2)}
    )`
  },
  IdeogramV3: {
    engine: 'jsonata',
    depends_on: {
      widgets: ['rendering_speed', 'num_images'],
      inputs: ['character_image']
    },
    expr: `(
      $n := w.num_images.n;
      $speed := w.rendering_speed.s;
      $hasChar := i.character_image.connected;

      $base :=
        $contains($speed,"quality") ? ($hasChar ? 0.286 : 0.1287) :
        $contains($speed,"default") ? ($hasChar ? 0.2145 : 0.0858) :
        $contains($speed,"turbo") ? ($hasChar ? 0.143 : 0.0429) :
        0.0858;

      {"type":"usd","usd": $round($base * $n, 2)}
    )`
  },
  KlingCameraControlI2VNode: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: exprUsd(0.49)
  },
  KlingCameraControlT2VNode: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: exprUsd(0.14)
  },
  KlingVideoExtendNode: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: exprUsd(0.28)
  },
  KlingVirtualTryOnNode: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: exprUsd(0.07)
  },
  KlingLipSyncAudioToVideoNode: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: exprUsd(0.1, { approximate: true })
  },
  KlingLipSyncTextToVideoNode: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: exprUsd(0.1, { approximate: true })
  },
  KlingOmniProEditVideoNode: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: exprUsd(0.168, { suffix: '/second' })
  },
  KlingOmniProImageNode: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: exprUsd(0.028)
  },
  KlingOmniProTextToVideoNode: {
    engine: 'jsonata',
    depends_on: { widgets: ['duration'], inputs: [] },
    expr: `(
      {"type":"usd","usd": 0.112 * w.duration.n}
    )`
  },
  KlingOmniProFirstLastFrameNode: {
    engine: 'jsonata',
    depends_on: { widgets: ['duration'], inputs: [] },
    expr: `(
      {"type":"usd","usd": 0.112 * w.duration.n}
    )`
  },
  KlingOmniProImageToVideoNode: {
    engine: 'jsonata',
    depends_on: { widgets: ['duration'], inputs: [] },
    expr: `(
      {"type":"usd","usd": 0.112 * w.duration.n}
    )`
  },
  KlingOmniProVideoToVideoNode: {
    engine: 'jsonata',
    depends_on: { widgets: ['duration'], inputs: [] },
    expr: `(
      {"type":"usd","usd": 0.168 * w.duration.n}
    )`
  },
  KlingMotionControl: {
    engine: 'jsonata',
    depends_on: { widgets: ['mode'], inputs: [] },
    expr: `(
      {"type":"usd","usd": {"std":0.07,"pro":0.112}[w.mode.s], "format":{"suffix":"/second"}}
    )`
  },
  KlingTextToVideoWithAudio: {
    engine: 'jsonata',
    depends_on: { widgets: ['duration', 'generate_audio'], inputs: [] },
    expr: `(
      {"type":"usd","usd": 0.07 * w.duration.n * (w.generate_audio.b ? 2 : 1)}
    )`
  },
  KlingImageToVideoWithAudio: {
    engine: 'jsonata',
    depends_on: { widgets: ['duration', 'generate_audio'], inputs: [] },
    expr: `(
      {"type":"usd","usd": 0.07 * w.duration.n * (w.generate_audio.b ? 2 : 1)}
    )`
  },
  KlingImageGenerationNode: {
    engine: 'jsonata',
    depends_on: { widgets: ['model_name', 'n'], inputs: ['image'] },
    expr: `(
      $m := w.model_name.s;
      $base :=
        $contains($m,"kling-v1-5")
          ? (i.image.connected ? 0.028 : 0.014)
          : ($contains($m,"kling-v1") ? 0.0035 : 0.014);

      {"type":"usd","usd": $base * w.n.n}
    )`
  },
  KlingSingleImageVideoEffectNode: {
    engine: 'jsonata',
    depends_on: { widgets: ['effect_scene'], inputs: [] },
    expr: `(
      ($contains(w.effect_scene.s,"dizzydizzy") or $contains(w.effect_scene.s,"bloombloom"))
        ? {"type":"usd","usd":0.49}
        : {"type":"usd","usd":0.28}
    )`
  },
  KlingStartEndFrameNode: {
    engine: 'jsonata',
    depends_on: { widgets: ['mode'], inputs: [] },
    expr: `(
      $m := w.mode.s;
  
      $contains($m,"v2-5-turbo")
        ? ($contains($m,"10") ? {"type":"usd","usd":0.7} : {"type":"usd","usd":0.35})
        : $contains($m,"v2-1")
          ? ($contains($m,"10s") ? {"type":"usd","usd":0.98} : {"type":"usd","usd":0.49})
          : $contains($m,"v2-master")
            ? ($contains($m,"10s") ? {"type":"usd","usd":2.8} : {"type":"usd","usd":1.4})
            : $contains($m,"v1-6")
              ? (
                  $contains($m,"pro")
                    ? ($contains($m,"10s") ? {"type":"usd","usd":0.98} : {"type":"usd","usd":0.49})
                    : ($contains($m,"10s") ? {"type":"usd","usd":0.56} : {"type":"usd","usd":0.28})
                )
              : $contains($m,"v1")
                ? (
                    $contains($m,"pro")
                      ? ($contains($m,"10s") ? {"type":"usd","usd":0.98} : {"type":"usd","usd":0.49})
                      : ($contains($m,"10s") ? {"type":"usd","usd":0.28} : {"type":"usd","usd":0.14})
                  )
                : {"type":"usd","usd":0.14}
    )`
  },
  KlingTextToVideoNode: {
    engine: 'jsonata',
    depends_on: { widgets: ['mode'], inputs: [] },
    expr: `(
      $m := w.mode.s;

      $contains($m,"v2-5-turbo")
        ? ($contains($m,"10") ? {"type":"usd","usd":0.7} : {"type":"usd","usd":0.35})
        : $contains($m,"v2-1-master")
          ? ($contains($m,"10s") ? {"type":"usd","usd":2.8} : {"type":"usd","usd":1.4})
          : $contains($m,"v2-master")
            ? ($contains($m,"10s") ? {"type":"usd","usd":2.8} : {"type":"usd","usd":1.4})
            : $contains($m,"v1-6")
              ? (
                  $contains($m,"pro")
                    ? ($contains($m,"10s") ? {"type":"usd","usd":0.98} : {"type":"usd","usd":0.49})
                    : ($contains($m,"10s") ? {"type":"usd","usd":0.56} : {"type":"usd","usd":0.28})
                )
              : $contains($m,"v1")
                ? (
                    $contains($m,"pro")
                      ? ($contains($m,"10s") ? {"type":"usd","usd":0.98} : {"type":"usd","usd":0.49})
                      : ($contains($m,"10s") ? {"type":"usd","usd":0.28} : {"type":"usd","usd":0.14})
                  )
                : {"type":"usd","usd":0.14}
    )`
  },
  KlingImage2VideoNode: {
    engine: 'jsonata',
    depends_on: { widgets: ['mode', 'model_name', 'duration'], inputs: [] },
    expr: `(
      $mode := w.mode.s;
      $model := w.model_name.s;
      $dur := w.duration.s;

      $contains($model,"v2-5-turbo")
        ? ($contains($dur,"10") ? {"type":"usd","usd":0.7} : {"type":"usd","usd":0.35})
        : ($contains($model,"v2-1-master") or $contains($model,"v2-master"))
          ? ($contains($dur,"10") ? {"type":"usd","usd":2.8} : {"type":"usd","usd":1.4})
          : ($contains($model,"v2-1") or $contains($model,"v1-6") or $contains($model,"v1-5"))
            ? (
                $contains($mode,"pro")
                  ? ($contains($dur,"10") ? {"type":"usd","usd":0.98} : {"type":"usd","usd":0.49})
                  : ($contains($dur,"10") ? {"type":"usd","usd":0.56} : {"type":"usd","usd":0.28})
              )
            : $contains($model,"v1")
              ? (
                  $contains($mode,"pro")
                    ? ($contains($dur,"10") ? {"type":"usd","usd":0.98} : {"type":"usd","usd":0.49})
                    : ($contains($dur,"10") ? {"type":"usd","usd":0.28} : {"type":"usd","usd":0.14})
                )
              : {"type":"usd","usd":0.14}
    )`
  },
  KlingDualCharacterVideoEffectNode: {
    engine: 'jsonata',
    depends_on: { widgets: ['mode', 'model_name', 'duration'], inputs: [] },
    expr: `(
      $mode := w.mode.s;
      $model := w.model_name.s;
      $dur := w.duration.s;

      ($contains($model,"v1-6") or $contains($model,"v1-5"))
        ? (
            $contains($mode,"pro")
              ? ($contains($dur,"10") ? {"type":"usd","usd":0.98} : {"type":"usd","usd":0.49})
              : ($contains($dur,"10") ? {"type":"usd","usd":0.56} : {"type":"usd","usd":0.28})
          )
        : $contains($model,"v1")
          ? (
              $contains($mode,"pro")
                ? ($contains($dur,"10") ? {"type":"usd","usd":0.98} : {"type":"usd","usd":0.49})
                : ($contains($dur,"10") ? {"type":"usd","usd":0.28} : {"type":"usd","usd":0.14})
            )
          : {"type":"usd","usd":0.14}
    )`
  },
  LumaImageToVideoNode: {
    engine: 'jsonata',
    depends_on: { widgets: ['model', 'resolution', 'duration'], inputs: [] },
    expr: `(
      $p := {
        "ray-flash-2": {
          "5s": {"4k":3.13,"1080p":0.79,"720p":0.34,"540p":0.2},
          "9s": {"4k":5.65,"1080p":1.42,"720p":0.61,"540p":0.36}
        },
        "ray-2": {
          "5s": {"4k":9.11,"1080p":2.27,"720p":1.02,"540p":0.57},
          "9s": {"4k":16.4,"1080p":4.1,"720p":1.83,"540p":1.03}
        }
      };

      $m := w.model.s;
      $d := w.duration.s;
      $r := w.resolution.s;

      $modelKey :=
        $contains($m,"ray-flash-2") ? "ray-flash-2" :
        $contains($m,"ray-2") ? "ray-2" :
        $contains($m,"ray-1-6") ? "ray-1-6" :
        "other";

      $durKey := $contains($d,"5s") ? "5s" : $contains($d,"9s") ? "9s" : "";
      $resKey :=
        $contains($r,"4k") ? "4k" :
        $contains($r,"1080p") ? "1080p" :
        $contains($r,"720p") ? "720p" :
        $contains($r,"540p") ? "540p" : "";

      $v := $p[$modelKey][$durKey][$resKey];

      $price :=
        ($modelKey = "ray-1-6") ? 0.5 :
        ($modelKey = "other") ? 0.79 :
        ($v ? $v : 0.79);

      {"type":"usd","usd": $price}
    )`
  },
  LumaVideoNode: {
    engine: 'jsonata',
    depends_on: { widgets: ['model', 'resolution', 'duration'], inputs: [] },
    expr: `(
      $p := {
        "ray-flash-2": {
          "5s": {"4k":3.13,"1080p":0.79,"720p":0.34,"540p":0.2},
          "9s": {"4k":5.65,"1080p":1.42,"720p":0.61,"540p":0.36}
        },
        "ray-2": {
          "5s": {"4k":9.11,"1080p":2.27,"720p":1.02,"540p":0.57},
          "9s": {"4k":16.4,"1080p":4.1,"720p":1.83,"540p":1.03}
        }
      };

      $m := w.model.s;
      $d := w.duration.s;
      $r := w.resolution.s;

      $modelKey :=
        $contains($m,"ray-flash-2") ? "ray-flash-2" :
        $contains($m,"ray-2") ? "ray-2" :
        $contains($m,"ray-1-6") ? "ray-1-6" :
        "other";

      $durKey := $contains($d,"5s") ? "5s" : $contains($d,"9s") ? "9s" : "";
      $resKey :=
        $contains($r,"4k") ? "4k" :
        $contains($r,"1080p") ? "1080p" :
        $contains($r,"720p") ? "720p" :
        $contains($r,"540p") ? "540p" : "";

      $v := $p[$modelKey][$durKey][$resKey];

      $price :=
        ($modelKey = "ray-1-6") ? 0.5 :
        ($modelKey = "other") ? 0.79 :
        ($v ? $v : 0.79);

      {"type":"usd","usd": $price}
    )`
  },
  LumaImageNode: {
    engine: 'jsonata',
    depends_on: { widgets: ['model', 'aspect_ratio'], inputs: [] },
    expr: `(
      $m := w.model.s;

      $contains($m,"photon-flash-1")
        ? {"type":"usd","usd":0.0027}
        : $contains($m,"photon-1")
          ? {"type":"usd","usd":0.0104}
          : {"type":"usd","usd":0.0246}
    )`
  },
  LumaImageModifyNode: {
    engine: 'jsonata',
    depends_on: { widgets: ['model', 'aspect_ratio'], inputs: [] },
    expr: `(
      $m := w.model.s;

      $contains($m,"photon-flash-1")
        ? {"type":"usd","usd":0.0027}
        : $contains($m,"photon-1")
          ? {"type":"usd","usd":0.0104}
          : {"type":"usd","usd":0.0246}
    )`
  },
  MinimaxImageToVideoNode: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: `{"type":"usd","usd":0.43}`
  },
  MinimaxTextToVideoNode: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: `{"type":"usd","usd":0.43}`
  },
  MinimaxHailuoVideoNode: {
    engine: 'jsonata',
    depends_on: { widgets: ['resolution', 'duration'], inputs: [] },
    expr: `(
      $r := w.resolution.s;
      $d := w.duration.s;

      $price :=
        $contains($r,"768p")
          ? (
              $contains($d,"6") ? 0.28 :
              $contains($d,"10") ? 0.56 :
              0.43
            )
          : $contains($r,"1080p")
            ? (
                $contains($d,"6") ? 0.49 : 0.43
              )
            : 0.43;

      {"type":"usd","usd": $price}
    )`
  },
  MoonvalleyTxt2VideoNode: {
    engine: 'jsonata',
    depends_on: { widgets: ['length'], inputs: [] },
    expr: `(
      $len := w.length.s;
      {"type":"usd","usd": ($len = "10s" ? 3.0 : 1.5)}
    )`
  },
  MoonvalleyImg2VideoNode: {
    engine: 'jsonata',
    depends_on: { widgets: ['length'], inputs: [] },
    expr: `(
      $len := w.length.s;
      {"type":"usd","usd": ($len = "10s" ? 3.0 : 1.5)}
    )`
  },
  MoonvalleyVideo2VideoNode: {
    engine: 'jsonata',
    depends_on: { widgets: ['length'], inputs: [] },
    expr: `(
      $len := w.length.s;
      {"type":"usd","usd": ($len = "10s" ? 4.0 : 2.25)}
    )`
  },
  OpenAIVideoSora2: {
    engine: 'jsonata',
    depends_on: { widgets: ['model', 'size', 'duration'], inputs: [] },
    expr: `(
      $m := w.model.s;
      $size := w.size.s;
      $dur := w.duration.n;

      $isPro := $contains($m, "sora-2-pro");
      $isSora2 := $contains($m, "sora-2");
      $isProSize := ($size = "1024x1792" or $size = "1792x1024");

      $perSec :=
        $isPro ? ($isProSize ? 0.5 : 0.3) :
        $isSora2 ? 0.1 :
        ($isProSize ? 0.5 : 0.1);

      {"type":"usd","usd": $round($perSec * $dur, 2)}
    )`
  },
  OpenAIDalle2: {
    engine: 'jsonata',
    depends_on: { widgets: ['size', 'n'], inputs: [] },
    expr: `(
      $size := w.size.s;
      $nRaw := w.n.n;
      $n := ($nRaw != null and $nRaw != 0) ? $nRaw : 1;

      $base :=
        $contains($size, "256x256") ? 0.016 :
        $contains($size, "512x512") ? 0.018 :
        0.02;

      {"type":"usd","usd": $round($base * $n, 3)}
    )`
  },
  OpenAIDalle3: {
    engine: 'jsonata',
    depends_on: { widgets: ['size', 'quality'], inputs: [] },
    expr: `(
      $size := w.size.s;
      $q := w.quality.s;
      $hd := $contains($q, "hd");

      $price :=
        $contains($size, "1024x1024")
          ? ($hd ? 0.08 : 0.04)
          : (($contains($size, "1792x1024") or $contains($size, "1024x1792"))
              ? ($hd ? 0.12 : 0.08)
              : 0.04);

      {"type":"usd","usd": $price}
    )`
  },
  OpenAIGPTImage1: {
    engine: 'jsonata',
    depends_on: { widgets: ['quality', 'n'], inputs: [] },
    expr: `(
      $q := w.quality.s;
      $nRaw := w.n.n;
      $n := ($nRaw != null and $nRaw != 0) ? $nRaw : 1;

      $range :=
        $contains($q,"high") ? [0.167,0.3] :
        $contains($q,"low") ? [0.011,0.02] :
        [0.046,0.07];

      ($n = 1)
        ? {"type":"range_usd","min_usd": $range[0], "max_usd": $range[1]}
        : {
            "type":"range_usd",
            "min_usd": $range[0],
            "max_usd": $range[1],
            "format": { "suffix": " x " & $string($n) & "/Run" }
          }
    )`
  },
  OpenAIChatNode: {
    engine: 'jsonata',
    depends_on: { widgets: ['model'], inputs: [] },
    result_defaults: { suffix: ' per 1K tokens' },
    expr: `(
      $m := w.model.s;

      $contains($m,"o4-mini") ? {"type":"list_usd","usd":[0.0011,0.0044]} :
      $contains($m,"o1-pro") ? {"type":"list_usd","usd":[0.15,0.6]} :
      $contains($m,"o1") ? {"type":"list_usd","usd":[0.015,0.06]} :
      $contains($m,"o3-mini") ? {"type":"list_usd","usd":[0.0011,0.0044]} :
      $contains($m,"o3") ? {"type":"list_usd","usd":[0.01,0.04]} :
      $contains($m,"gpt-4o") ? {"type":"list_usd","usd":[0.0025,0.01]} :
      $contains($m,"gpt-4.1-nano") ? {"type":"list_usd","usd":[0.0001,0.0004]} :
      $contains($m,"gpt-4.1-mini") ? {"type":"list_usd","usd":[0.0004,0.0016]} :
      $contains($m,"gpt-4.1") ? {"type":"list_usd","usd":[0.002,0.008]} :
      $contains($m,"gpt-5-nano") ? {"type":"list_usd","usd":[0.00005,0.0004]} :
      $contains($m,"gpt-5-mini") ? {"type":"list_usd","usd":[0.00025,0.002]} :
      $contains($m,"gpt-5") ? {"type":"list_usd","usd":[0.00125,0.01]} :
      {"type":"text","text":"Token-based"}
    )`
  },
  PixverseImageToVideoNode: {
    engine: 'jsonata',
    depends_on: {
      widgets: ['duration_seconds', 'quality', 'motion_mode'],
      inputs: []
    },
    expr: `(
      $d := w.duration_seconds.s;
      $q := w.quality.s;
      $m := w.motion_mode.s;

      $price :=
        $contains($d,"5")
          ? (
              $contains($q,"1080p") ? 1.2 :
              ($contains($q,"720p") and $contains($m,"fast")) ? 1.2 :
              ($contains($q,"720p") and $contains($m,"normal")) ? 0.6 :
              ($contains($q,"540p") and $contains($m,"fast")) ? 0.9 :
              ($contains($q,"540p") and $contains($m,"normal")) ? 0.45 :
              ($contains($q,"360p") and $contains($m,"fast")) ? 0.9 :
              ($contains($q,"360p") and $contains($m,"normal")) ? 0.45 :
              0.9
            )
          : $contains($d,"8")
            ? (
                ($contains($q,"540p") and $contains($m,"normal")) ? 0.9 :
                ($contains($q,"540p") and $contains($m,"fast")) ? 1.2 :
                ($contains($q,"360p") and $contains($m,"normal")) ? 0.9 :
                ($contains($q,"360p") and $contains($m,"fast")) ? 1.2 :
                ($contains($q,"1080p") and $contains($m,"normal")) ? 1.2 :
                ($contains($q,"1080p") and $contains($m,"fast")) ? 1.2 :
                ($contains($q,"720p") and $contains($m,"normal")) ? 1.2 :
                ($contains($q,"720p") and $contains($m,"fast")) ? 1.2 :
                0.9
              )
            : 0.9;

      {"type":"usd","usd": $price}
    )`
  },
  PixverseTextToVideoNode: {
    engine: 'jsonata',
    depends_on: {
      widgets: ['duration_seconds', 'quality', 'motion_mode'],
      inputs: []
    },
    expr: `(
      $d := w.duration_seconds.s;
      $q := w.quality.s;
      $m := w.motion_mode.s;

      $price :=
        $contains($d,"5")
          ? (
              $contains($q,"1080p") ? 1.2 :
              ($contains($q,"720p") and $contains($m,"fast")) ? 1.2 :
              ($contains($q,"720p") and $contains($m,"normal")) ? 0.6 :
              ($contains($q,"540p") and $contains($m,"fast")) ? 0.9 :
              ($contains($q,"540p") and $contains($m,"normal")) ? 0.45 :
              ($contains($q,"360p") and $contains($m,"fast")) ? 0.9 :
              ($contains($q,"360p") and $contains($m,"normal")) ? 0.45 :
              0.9
            )
          : $contains($d,"8")
            ? (
                ($contains($q,"540p") and $contains($m,"normal")) ? 0.9 :
                ($contains($q,"540p") and $contains($m,"fast")) ? 1.2 :
                ($contains($q,"360p") and $contains($m,"normal")) ? 0.9 :
                ($contains($q,"360p") and $contains($m,"fast")) ? 1.2 :
                ($contains($q,"1080p") and $contains($m,"normal")) ? 1.2 :
                ($contains($q,"1080p") and $contains($m,"fast")) ? 1.2 :
                ($contains($q,"720p") and $contains($m,"normal")) ? 1.2 :
                ($contains($q,"720p") and $contains($m,"fast")) ? 1.2 :
                0.9
              )
            : 0.9;

      {"type":"usd","usd": $price}
    )`
  },
  PixverseTransitionVideoNode: {
    engine: 'jsonata',
    depends_on: {
      widgets: ['duration_seconds', 'quality', 'motion_mode'],
      inputs: []
    },
    expr: `(
      $d := w.duration_seconds.s;
      $q := w.quality.s;
      $m := w.motion_mode.s;

      $price :=
        $contains($d,"5")
          ? (
              $contains($q,"1080p") ? 1.2 :
              ($contains($q,"720p") and $contains($m,"fast")) ? 1.2 :
              ($contains($q,"720p") and $contains($m,"normal")) ? 0.6 :
              ($contains($q,"540p") and $contains($m,"fast")) ? 0.9 :
              ($contains($q,"540p") and $contains($m,"normal")) ? 0.45 :
              ($contains($q,"360p") and $contains($m,"fast")) ? 0.9 :
              ($contains($q,"360p") and $contains($m,"normal")) ? 0.45 :
              0.9
            )
          : $contains($d,"8")
            ? (
                ($contains($q,"540p") and $contains($m,"normal")) ? 0.9 :
                ($contains($q,"540p") and $contains($m,"fast")) ? 1.2 :
                ($contains($q,"360p") and $contains($m,"normal")) ? 0.9 :
                ($contains($q,"360p") and $contains($m,"fast")) ? 1.2 :
                ($contains($q,"1080p") and $contains($m,"normal")) ? 1.2 :
                ($contains($q,"1080p") and $contains($m,"fast")) ? 1.2 :
                ($contains($q,"720p") and $contains($m,"normal")) ? 1.2 :
                ($contains($q,"720p") and $contains($m,"fast")) ? 1.2 :
                0.9
              )
            : 0.9;

      {"type":"usd","usd": $price}
    )`
  },
  RecraftCreativeUpscaleNode: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: exprUsd(0.25)
  },
  RecraftCrispUpscaleNode: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: exprUsd(0.004)
  },
  RecraftRemoveBackgroundNode: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: exprUsd(0.01)
  },
  RecraftReplaceBackgroundNode: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: exprUsd(0.04)
  },
  RecraftTextToImageNode: {
    engine: 'jsonata',
    depends_on: { widgets: ['n'], inputs: [] },
    expr: `(
      {"type":"usd","usd": $round(0.04 * w.n.n, 2)}
    )`
  },
  RecraftImageToImageNode: {
    engine: 'jsonata',
    depends_on: { widgets: ['n'], inputs: [] },
    expr: `(
      {"type":"usd","usd": $round(0.04 * w.n.n, 2)}
    )`
  },
  RecraftImageInpaintingNode: {
    engine: 'jsonata',
    depends_on: { widgets: ['n'], inputs: [] },
    expr: `(
      {"type":"usd","usd": $round(0.04 * w.n.n, 2)}
    )`
  },
  RecraftGenerateColorFromImageNode: {
    engine: 'jsonata',
    depends_on: { widgets: ['n'], inputs: [] },
    expr: `(
      {"type":"usd","usd": $round(0.04 * w.n.n, 2)}
    )`
  },
  RecraftGenerateImageNode: {
    engine: 'jsonata',
    depends_on: { widgets: ['n'], inputs: [] },
    expr: `(
      {"type":"usd","usd": $round(0.04 * w.n.n, 2)}
    )`
  },
  RecraftGenerateVectorImageNode: {
    engine: 'jsonata',
    depends_on: { widgets: ['n'], inputs: [] },
    expr: `(
      {"type":"usd","usd": $round(0.08 * w.n.n, 2)}
    )`
  },
  RecraftTextToVectorNode: {
    engine: 'jsonata',
    depends_on: { widgets: ['n'], inputs: [] },
    expr: `(
      {"type":"usd","usd": $round(0.08 * w.n.n, 2)}
    )`
  },
  RecraftVectorizeImageNode: {
    engine: 'jsonata',
    depends_on: { widgets: ['n'], inputs: [] },
    expr: `(
      {"type":"usd","usd": $round(0.01 * w.n.n, 2)}
    )`
  },
  Rodin3D_Regular: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: `{"type":"usd","usd":0.4}`
  },
  Rodin3D_Detail: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: `{"type":"usd","usd":0.4}`
  },
  Rodin3D_Smooth: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: `{"type":"usd","usd":0.4}`
  },
  Rodin3D_Sketch: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: `{"type":"usd","usd":0.4}`
  },
  StabilityStableImageSD_3_5Node: {
    engine: 'jsonata',
    depends_on: { widgets: ['model'], inputs: [] },
    expr: `(
      $contains(w.model.s,"large")
        ? {"type":"usd","usd":0.065}
        : {"type":"usd","usd":0.035}
    )`
  },
  StabilityStableImageUltraNode: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: exprUsd(0.08)
  },
  StabilityUpscaleConservativeNode: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: exprUsd(0.25)
  },
  StabilityUpscaleCreativeNode: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: exprUsd(0.25)
  },
  StabilityUpscaleFastNode: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: exprUsd(0.01)
  },
  StabilityTextToAudio: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: exprUsd(0.2)
  },
  StabilityAudioToAudio: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: exprUsd(0.2)
  },
  StabilityAudioInpaint: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: exprUsd(0.2)
  },
  TripoTextToModelNode: {
    engine: 'jsonata',
    depends_on: {
      widgets: [
        'model_version',
        'style',
        'texture',
        'pbr',
        'quad',
        'texture_quality',
        'geometry_quality'
      ],
      inputs: []
    },
    expr: `(
      $mv := w.model_version.s;

      ($mv = "")
        ? {
            "type":"range_usd",
            "min_usd":0.1,
            "max_usd":0.65,
            "format":{"note":"(varies with quad, style, texture & quality)"}
          }
        : (
            $isV14 := $contains($mv,"v1.4");

            $style := w.style.s;
            $hasStyle := ($style != "" and $style != "none");

            $withTexture := w.texture.b or w.pbr.b;

            $isHdTexture := (w.texture_quality.s = "detailed");
            $isDetailedGeometry := (w.geometry_quality.s = "detailed");

            $baseCredits :=
              $isV14 ? 20 : ($withTexture ? 20 : 10);

            $credits :=
              $baseCredits
              + ($hasStyle ? 5 : 0)
              + (w.quad.b ? 5 : 0)
              + ($isHdTexture ? 10 : 0)
              + ($isDetailedGeometry ? 20 : 0);

            {"type":"usd","usd": $round($credits * 0.01, 2)}
          )
    )`
  },
  TripoImageToModelNode: {
    engine: 'jsonata',
    depends_on: {
      widgets: [
        'model_version',
        'style',
        'texture',
        'pbr',
        'quad',
        'texture_quality',
        'geometry_quality'
      ],
      inputs: []
    },
    expr: `(
      $mv := w.model_version.s;

      ($mv = "")
        ? {
            "type":"range_usd",
            "min_usd":0.1,
            "max_usd":0.65,
            "format":{"note":"(varies with quad, style, texture & quality)"}
          }
        : (
            $isV14 := $contains($mv,"v1.4");

            $style := w.style.s;
            $hasStyle := ($style != "" and $style != "none");

            $withTexture := w.texture.b or w.pbr.b;

            $isHdTexture := (w.texture_quality.s = "detailed");
            $isDetailedGeometry := (w.geometry_quality.s = "detailed");

            $baseCredits :=
              $isV14 ? 30 : ($withTexture ? 30 : 20);

            $credits :=
              $baseCredits
              + ($hasStyle ? 5 : 0)
              + (w.quad.b ? 5 : 0)
              + ($isHdTexture ? 10 : 0)
              + ($isDetailedGeometry ? 20 : 0);

            {"type":"usd","usd": $round($credits * 0.01, 2)}
          )
    )`
  },
  TripoMultiviewToModelNode: {
    engine: 'jsonata',
    depends_on: {
      widgets: [
        'model_version',
        'style',
        'texture',
        'pbr',
        'quad',
        'texture_quality',
        'geometry_quality'
      ],
      inputs: []
    },
    expr: `(
      $mv := w.model_version.s;

      ($mv = "")
        ? {
            "type":"range_usd",
            "min_usd":0.1,
            "max_usd":0.65,
            "format":{"note":"(varies with quad, style, texture & quality)"}
          }
        : (
            $isV14 := $contains($mv,"v1.4");

            $style := w.style.s;
            $hasStyle := ($style != "" and $style != "none");

            /* booleans guaranteed => use .b directly */
            $withTexture := w.texture.b or w.pbr.b;

            $isHdTexture := (w.texture_quality.s = "detailed");
            $isDetailedGeometry := (w.geometry_quality.s = "detailed");

            /* Multiview treated same as Image */
            $baseCredits :=
              $isV14 ? 30 : ($withTexture ? 30 : 20);

            $credits :=
              $baseCredits
              + ($hasStyle ? 5 : 0)
              + (w.quad.b ? 5 : 0)
              + ($isHdTexture ? 10 : 0)
              + ($isDetailedGeometry ? 20 : 0);

            {"type":"usd","usd": $round($credits * 0.01, 2)}
          )
    )`
  },
  TripoTextureNode: {
    engine: 'jsonata',
    depends_on: { widgets: ['texture_quality'], inputs: [] },
    expr: `(
      $tq := w.texture_quality.s;
      {"type":"usd","usd": ($contains($tq,"detailed") ? 0.2 : 0.1)}
    )`
  },
  TripoRigNode: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: `{"type":"usd","usd":0.25}`
  },
  TripoConversionNode: {
    engine: 'jsonata',
    depends_on: {
      widgets: [
        'quad',
        'face_limit',
        'texture_size',
        'texture_format',
        'force_symmetry',
        'flatten_bottom',
        'flatten_bottom_threshold',
        'pivot_to_center_bottom',
        'scale_factor',
        'with_animation',
        'pack_uv',
        'bake',
        'part_names',
        'fbx_preset',
        'export_vertex_colors',
        'export_orientation',
        'animate_in_place'
      ],
      inputs: []
    },
    expr: `(
    $face := (w.face_limit.n != null) ? w.face_limit.n : -1;
    $texSize := (w.texture_size.n != null) ? w.texture_size.n : 4096;
    $flatThresh := (w.flatten_bottom_threshold.n != null) ? w.flatten_bottom_threshold.n : 0;
    $scale := (w.scale_factor.n != null) ? w.scale_factor.n : 1;

    $texFmt := (w.texture_format.s != "" ? w.texture_format.s : "jpeg");
    $part := w.part_names.s;
    $fbx := (w.fbx_preset.s != "" ? w.fbx_preset.s : "blender");
    $orient := (w.export_orientation.s != "" ? w.export_orientation.s : "default");

    $advanced :=
      w.quad.b or
      w.force_symmetry.b or
      w.flatten_bottom.b or
      w.pivot_to_center_bottom.b or
      w.with_animation.b or
      w.pack_uv.b or
      w.bake.b or
      w.export_vertex_colors.b or
      w.animate_in_place.b or
      ($face != -1) or
      ($texSize != 4096) or
      ($flatThresh != 0) or
      ($scale != 1) or
      ($texFmt != "jpeg") or
      ($part != "") or
      ($fbx != "blender") or
      ($orient != "default");

    {"type":"usd","usd": ($advanced ? 0.1 : 0.05)}
  )`
  },
  TripoRetargetNode: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: `{"type":"usd","usd":0.1}`
  },
  TripoRefineNode: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: `{"type":"usd","usd":0.3}`
  },
  VeoVideoGenerationNode: {
    engine: 'jsonata',
    depends_on: { widgets: ['duration_seconds'], inputs: [] },
    expr: `(
      {"type":"usd","usd": 0.5 * w.duration_seconds.n}
    )`
  },
  Veo3VideoGenerationNode: {
    engine: 'jsonata',
    depends_on: { widgets: ['model', 'generate_audio'], inputs: [] },
    expr: `(
      $m := w.model.s;
      $a := w.generate_audio.b;

      ($contains($m,"veo-3.0-fast-generate-001") or $contains($m,"veo-3.1-fast-generate"))
        ? {"type":"usd","usd": ($a ? 1.2 : 0.8)}
        : ($contains($m,"veo-3.0-generate-001") or $contains($m,"veo-3.1-generate"))
          ? {"type":"usd","usd": ($a ? 3.2 : 1.6)}
          : {"type":"range_usd","min_usd":0.8,"max_usd":3.2}
    )`
  },
  Veo3FirstLastFrameNode: {
    engine: 'jsonata',
    depends_on: {
      widgets: ['model', 'generate_audio', 'duration'],
      inputs: []
    },
    expr: `(
      $m := w.model.s;
      $a := w.generate_audio.b;

      /* mirror old parseFloat(String(duration)) behavior */
      $seconds := (w.duration.n != null) ? w.duration.n : $number($replace(w.duration.s, "s", ""));

      $pps :=
        $contains($m,"veo-3.1-fast-generate") ? ($a ? 0.15 : 0.1) :
        $contains($m,"veo-3.1-generate") ? ($a ? 0.4 : 0.2) :
        null;

      ($pps = null)
        ? {"type":"range_usd","min_usd":0.4,"max_usd":3.2}
        : {"type":"usd","usd": $pps * $seconds}
    )`
  },
  ViduTextToVideoNode: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: exprUsd(0.4)
  },
  ViduImageToVideoNode: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: exprUsd(0.4)
  },
  ViduReferenceVideoNode: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: exprUsd(0.4)
  },
  ViduStartEndToVideoNode: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: exprUsd(0.4)
  },
  WanTextToVideoApi: {
    engine: 'jsonata',
    depends_on: { widgets: ['duration', 'size'], inputs: [] },
    expr: `(
      $pps := {"480p":0.05,"720p":0.1,"1080p":0.15}[w.size.s];
      {"type":"usd","usd": $round($pps * w.duration.n, 2)}
    )`
  },
  WanImageToVideoApi: {
    engine: 'jsonata',
    depends_on: { widgets: ['duration', 'resolution'], inputs: [] },
    expr: `(
      $pps := {"480p":0.05,"720p":0.1,"1080p":0.15}[w.resolution.s];
      {"type":"usd","usd": $round($pps * w.duration.n, 2)}
    )`
  },
  WanTextToImageApi: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: exprUsd(0.03)
  },
  WanImageToImageApi: {
    engine: 'jsonata',
    depends_on: { widgets: [], inputs: [] },
    expr: exprUsd(0.03)
  },
  LtxvApiTextToVideo: {
    engine: 'jsonata',
    depends_on: { widgets: ['model', 'duration', 'resolution'], inputs: [] },
    expr: `(
      $pps := {
        "ltx-2 (pro)": {"1920x1080":0.06,"2560x1440":0.12,"3840x2160":0.24},
        "ltx-2 (fast)": {"1920x1080":0.04,"2560x1440":0.08,"3840x2160":0.16}
      }[w.model.s][w.resolution.s];

      {"type":"usd","usd": $pps * w.duration.n}
    )`
  },
  LtxvApiImageToVideo: {
    engine: 'jsonata',
    depends_on: { widgets: ['model', 'duration', 'resolution'], inputs: [] },
    expr: `(
      $pps := {
        "ltx-2 (pro)": {"1920x1080":0.06,"2560x1440":0.12,"3840x2160":0.24},
        "ltx-2 (fast)": {"1920x1080":0.04,"2560x1440":0.08,"3840x2160":0.16}
      }[w.model.s][w.resolution.s];

      {"type":"usd","usd": $pps * w.duration.n}
    )`
  }

  // If you need a non-USD badge (e.g. "Token-based"), use:
  // SomeNode: { engine:'jsonata', depends_on:{widgets:[],inputs:[]}, expr: exprText("Token-based") }
}

// Pre-compile once at module load
const COMPILED_LOCAL_RULES: Record<string, CompiledJsonataPricingRule> =
  Object.fromEntries(
    Object.entries(LOCAL_PRICING_RULES).map(([k, v]) => [k, compileRule(v)])
  ) as Record<string, CompiledJsonataPricingRule>

// -----------------------------
// Async evaluation + cache (JSONata 2.x)
// -----------------------------

// Reactive tick to force UI updates when async evaluations resolve.
// We purposely read pricingTick.value inside getNodeDisplayPrice to create a dependency.
const pricingTick = ref(0)

// WeakMaps avoid memory leaks when nodes are removed.
type CacheEntry = { sig: string; label: string }
type InflightEntry = { sig: string; promise: Promise<void> }

const cache = new WeakMap<LGraphNode, CacheEntry>()
const desiredSig = new WeakMap<LGraphNode, string>()
const inflight = new WeakMap<LGraphNode, InflightEntry>()

const DEBUG_JSONATA_PRICING = true

const scheduleEvaluation = (
  node: LGraphNode,
  rule: CompiledJsonataPricingRule,
  ctx: JsonataEvalContext,
  sig: string
) => {
  desiredSig.set(node, sig)

  const running = inflight.get(node)
  if (running && running.sig === sig) return

  if (!rule._compiled) return

  const nodeName = (node.constructor as any)?.nodeData?.name ?? ''

  const promise = Promise.resolve(rule._compiled.evaluate(ctx as any))
    .then((res) => {
      const label = formatPricingResult(res, rule.result_defaults ?? {})

      // Ignore stale results: if the node changed while we were evaluating,
      // desiredSig will no longer match.
      if (desiredSig.get(node) !== sig) return

      cache.set(node, { sig, label })

      if (DEBUG_JSONATA_PRICING) {
        console.warn('[pricing/jsonata] resolved', nodeName, {
          sig,
          res,
          label
        })
      }
    })
    .catch((err) => {
      if (process.env.NODE_ENV === 'development') {
        console.warn('[pricing/jsonata] evaluation failed', nodeName, err)
      }

      // Cache empty to avoid retry-spam for same signature
      if (desiredSig.get(node) === sig) {
        cache.set(node, { sig, label: '' })
      }
    })
    .finally(() => {
      const cur = inflight.get(node)
      if (cur && cur.sig === sig) inflight.delete(node)

      // Trigger reactive updates for any callers depending on pricingTick
      pricingTick.value++
    })

  inflight.set(node, { sig, promise })
}

const getRuleForNode = (
  node: LGraphNode
): CompiledJsonataPricingRule | undefined => {
  const nodeData = (node.constructor as any)?.nodeData as
    | { name?: string; api_node?: boolean }
    | undefined

  const nodeName = nodeData?.name ?? ''
  return COMPILED_LOCAL_RULES[nodeName]
}

// -----------------------------
// Public composable API
// -----------------------------
export const useNodePricing = () => {
  /**
   * Sync getter:
   * - returns cached label for the current node signature when available
   * - schedules async evaluation when needed
   * - remains non-fatal on errors (returns safe fallback '')
   */
  const getNodeDisplayPrice = (node: LGraphNode): string => {
    // Make this function reactive: when async evaluation completes, we bump pricingTick,
    // which causes this getter to recompute in Vue render/computed contexts.
    pricingTick.value

    const nodeData = (node.constructor as any)?.nodeData as
      | { name?: string; api_node?: boolean }
      | undefined

    if (!nodeData?.api_node) return ''

    const rule = getRuleForNode(node)
    if (!rule) return ''
    if (rule.engine !== 'jsonata') return ''
    if (!rule._compiled) return ''

    const ctx = buildJsonataContext(node, rule)
    const sig = buildSignature(ctx, rule)

    const cached = cache.get(node)
    if (cached && cached.sig === sig) {
      return cached.label
    }

    // Cache miss: start async evaluation.
    // Return last-known label (if any) to avoid flicker; otherwise return empty.
    scheduleEvaluation(node, rule, ctx, sig)
    return cached?.label ?? ''
  }

  /**
   * Expose raw pricing config for tooling/debug UI.
   * (Strips compiled expression from returned object.)
   */
  const getNodePricingConfig = (node: LGraphNode) => {
    const rule = getRuleForNode(node)
    if (!rule) return undefined
    const { _compiled, ...config } = rule
    return config
  }

  /**
   * Caller compatibility helper:
   * returns union of widget dependencies + input dependencies for a node type.
   */
  const getRelevantWidgetNames = (nodeType: string): string[] => {
    const rule = LOCAL_PRICING_RULES[nodeType]
    if (!rule) return []

    // Keep stable output (dedupe while preserving order)
    const out: string[] = []
    for (const n of [...rule.depends_on.widgets, ...rule.depends_on.inputs]) {
      if (!out.includes(n)) out.push(n)
    }
    return out
  }

  return {
    getNodeDisplayPrice,
    getNodePricingConfig,
    getRelevantWidgetNames,
    pricingRevision: readonly(pricingTick) // reactive invalidation signal
  }
}
