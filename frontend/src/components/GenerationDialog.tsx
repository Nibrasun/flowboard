import { useEffect, useRef, useState } from "react";
import { useGenerationStore } from "../store/generation";
import { useBoardStore, TYPE_TITLE, type StoryboardGrid } from "../store/board";
import {
  STORYBOARD_GRIDS,
  buildStoryboardPrompt,
  buildStoryboardVideoPrompt,
  normaliseStoryboardGrid,
  totalPanels,
} from "../lib/storyboardPrompt";
import { buildVideoReferencePrompt } from "../lib/videoReferencePrompt";
import {
  useSettingsStore,
  OMNI_FLASH_CREDIT_COST,
  OMNI_FLASH_DURATIONS,
  type OmniFlashDuration,
  type VideoQuality,
} from "../store/settings";
import {
  autoPrompt as autoPromptApi,
  autoPromptBatch as autoPromptBatchApi,
  mediaUrl,
  patchEdge,
  patchNode,
  uploadVideo,
} from "../api/client";
import {
  CHARACTER_GENDERS,
  CHARACTER_COUNTRIES,
  CHARACTER_VIBES,
  type GenderKey,
  type CountryKey,
  type VibeKey,
} from "../constants/character";

const REF_SOURCE_TYPES = new Set([
  "character",
  "image",
  "visual_asset",
  // Storyboard outputs are first-class refs — they're composite images
  // that can feed downstream image / Omni-video / character nodes.
  "Storyboard",
]);

function buildCharacterPrompt(
  gender: GenderKey | null,
  country: CountryKey | null,
  vibe: VibeKey,
  extras: string,
): string {
  const g = CHARACTER_GENDERS.find((x) => x.key === gender)?.tag;
  const c = CHARACTER_COUNTRIES.find((x) => x.key === country)?.tag;
  const subject = [c, g].filter(Boolean).join(" ") || "person";
  const vibeTokens = CHARACTER_VIBES.find((v) => v.key === vibe)?.tokens ?? [];
  const tail = extras.trim();
  // Pose anchor is front-loaded (right after subject) because diffusion
  // models weight earlier tokens more — vibe tokens like "editorial /
  // magazine beauty" otherwise pull toward fashion 3/4 turns. The trailing
  // negatives reinforce the lock so the headshot stays usable as a
  // character reference across every downstream shot.
  return [
    `Studio portrait headshot of a ${subject} character`,
    "subject directly faces the camera, head perfectly straight with zero tilt and zero turn",
    "shoulders square to camera, axially symmetric pose, nose centered, both eyes equally visible at the same height",
    ...vibeTokens,
    tail || null,
    "head and shoulders framing, centered composition, sharp focus on face",
    "strictly front-on orientation, no head tilt, no head turn, no profile angle, no three-quarter view, no over-the-shoulder pose",
    "no glasses, no hat, no mask, no occlusion, nothing covering the face",
    "photorealistic, ultra-detailed, consistent character reference",
  ]
    .filter(Boolean)
    .join(", ");
}

const IMAGE_ASPECT_RATIOS = [
  { key: "IMAGE_ASPECT_RATIO_SQUARE", label: "1:1" },
  { key: "IMAGE_ASPECT_RATIO_PORTRAIT", label: "9:16" },
  { key: "IMAGE_ASPECT_RATIO_LANDSCAPE", label: "16:9" },
] as const;

const VIDEO_ASPECT_RATIOS = [
  { key: "VIDEO_ASPECT_RATIO_LANDSCAPE", label: "16:9 landscape" },
  { key: "VIDEO_ASPECT_RATIO_PORTRAIT", label: "9:16 portrait" },
] as const;

// Camera movement presets for video.
// - `static` (default): locked-off, no zoom/pan — best for e-commerce
//   product showcase since it keeps the product fully framed.
// - `dynamic`: no camera constraint — the auto-prompt synthesiser is free
//   to suggest dolly / pan / etc. as it sees fit. Empty instruction → no
//   constraint string appended to the final prompt either.
const CAMERA_MOVEMENTS = [
  {
    key: "static",
    label: "Static",
    instruction:
      "Camera: locked-off static frame, no zoom and no pan. Keep the full "
      + "subject and any product clearly visible in the frame for the "
      + "entire clip. Background and crop must not change.",
  },
  {
    key: "dynamic",
    label: "Dynamic",
    instruction: "",
  },
] as const;

type CameraKey = (typeof CAMERA_MOVEMENTS)[number]["key"];

// Video model picker shown in the dialog — mirrors the unified list from
// SettingsPanel so the user can override the model per-dispatch without
// opening the gear menu. Selecting a chip mutates the global settings
// store (same pattern as the Omni-duration chips below), so the choice
// is sticky for subsequent dispatches.
// Each chip is either a Veo quality combo or Omni Flash. `ultraOnly`
// chips are locked when the detected paygate tier isn't TIER_TWO —
// the backend would silently fall back to Fast otherwise.
type VeoChip = {
  kind: "veo";
  quality: VideoQuality;
  label: string;
  ultraOnly: boolean;
};
type OmniChip = { kind: "omni"; label: string };
type VideoModelChip = VeoChip | OmniChip;

const VIDEO_MODEL_CHIPS: readonly VideoModelChip[] = [
  { kind: "veo", quality: "lite", label: "Veo 3.1 Lite", ultraOnly: false },
  { kind: "veo", quality: "fast", label: "Veo 3.1 Fast", ultraOnly: false },
  { kind: "veo", quality: "quality", label: "Veo 3.1 Quality", ultraOnly: false },
  { kind: "veo", quality: "lite_relaxed", label: "Veo 3.1 Lite (Low Priority)", ultraOnly: true },
  { kind: "omni", label: "Omni Flash" },
];

function cameraInstruction(key: CameraKey): string {
  return CAMERA_MOVEMENTS.find((c) => c.key === key)?.instruction ?? "";
}

type ImageAspectKey = (typeof IMAGE_ASPECT_RATIOS)[number]["key"];
type VideoAspectKey = (typeof VIDEO_ASPECT_RATIOS)[number]["key"];
type AspectKey = ImageAspectKey | VideoAspectKey;

// Map an upstream image aspect onto the closest video aspect. Square has
// no direct video equivalent — fall back to portrait per the
// "default-to-9:16 on mismatch" rule.
function imageAspectToVideo(img: string | undefined): VideoAspectKey | null {
  if (img === "IMAGE_ASPECT_RATIO_LANDSCAPE") return "VIDEO_ASPECT_RATIO_LANDSCAPE";
  if (img === "IMAGE_ASPECT_RATIO_PORTRAIT") return "VIDEO_ASPECT_RATIO_PORTRAIT";
  if (img === "IMAGE_ASPECT_RATIO_SQUARE") return "VIDEO_ASPECT_RATIO_PORTRAIT";
  return null;
}

// Walk upstream of the target node, collect each upstream's aspectRatio,
// then apply the user's rule:
//   • single distinct aspect → match it
//   • multiple distinct aspects → fall back to 9:16
//   • zero upstream / unknown → caller's default
function pickDefaultAspect(
  rfId: string,
  targetType: string,
  nodes: ReturnType<typeof useBoardStore.getState>["nodes"],
  edges: ReturnType<typeof useBoardStore.getState>["edges"],
): AspectKey | null {
  const upstreamAspects: string[] = [];
  for (const e of edges) {
    if (e.target !== rfId) continue;
    const src = nodes.find((n) => n.id === e.source);
    if (!src) continue;
    const ar = src.data.aspectRatio;
    if (typeof ar === "string" && ar.length > 0) upstreamAspects.push(ar);
  }
  if (upstreamAspects.length === 0) return null;

  if (targetType === "video") {
    const mapped = upstreamAspects
      .map(imageAspectToVideo)
      .filter((x): x is VideoAspectKey => x !== null);
    if (mapped.length === 0) return null;
    const unique = new Set(mapped);
    if (unique.size === 1) return mapped[0];
    return "VIDEO_ASPECT_RATIO_PORTRAIT";
  }
  // Image (and character — though character has its own opinionated
  // default; the caller short-circuits before reaching here).
  const validImg = upstreamAspects.filter((a): a is ImageAspectKey =>
    IMAGE_ASPECT_RATIOS.some((p) => p.key === a),
  );
  if (validImg.length === 0) return null;
  const unique = new Set(validImg);
  if (unique.size === 1) return validImg[0];
  return "IMAGE_ASPECT_RATIO_PORTRAIT";
}

// Small "ⓘ" affordance for moving static help-text out of the layout
// into a hover tooltip — keeps the dialog short while preserving the
// information for users who want it. Native `title` (plain text) is
// enough; we don't need rich markup in tooltips.
function InfoTip({ tip }: { tip: string }) {
  return (
    <span
      className="gen-dialog__info-tip"
      title={tip}
      aria-label={tip}
      role="img"
    >
      ⓘ
    </span>
  );
}

export function GenerationDialog() {
  const openDialog = useGenerationStore((s) => s.openDialog);
  const closeGenerationDialog = useGenerationStore((s) => s.closeGenerationDialog);
  const dispatchGeneration = useGenerationStore((s) => s.dispatchGeneration);
  const nodes = useBoardStore((s) => s.nodes);

  const [prompt, setPrompt] = useState(openDialog.prompt);
  const [aspectRatio, setAspectRatio] = useState<AspectKey>("IMAGE_ASPECT_RATIO_LANDSCAPE");
  const [variants, setVariants] = useState(1);
  const [camera, setCamera] = useState<CameraKey>("static");
  // Storyboard layout. The node dispatches via the standard image
  // handler with a locked template prompt wrapping the user's topic
  // into a single composite NxN grid. See lib/storyboardPrompt.ts.
  const [storyboardGrid, setStoryboardGrid] = useState<StoryboardGrid>("2x2");

  // Character builder state — only used when targetType === "character".
  const [charGender, setCharGender] = useState<GenderKey | null>(null);
  const [charCountry, setCharCountry] = useState<CountryKey | null>(null);
  const [charVibe, setCharVibe] = useState<VibeKey>("clean");
  const [charExtras, setCharExtras] = useState("");

  // Auto-prompt state — set when the user submits an empty prompt and we
  // synthesise one from upstream context. Surfaced as a small ✨ badge.
  const [autoBuilding, setAutoBuilding] = useState(false);
  const [autoPromptUsed, setAutoPromptUsed] = useState(false);

  // Per-variant selection for multi-source i2v. Default: all selected.
  // Stored as a Set of indices so the UI can toggle individual variants
  // and "All / None" without juggling parallel arrays.
  const [selectedSourceIdx, setSelectedSourceIdx] = useState<Set<number>>(new Set());
  // Tracks which Source-Reference chip's variant picker is currently
  // open. Holds the edge id the picker is anchored to (one open at a
  // time). Click another chip → swap; click the same chip → close;
  // click outside (handled inline) → close.
  const [openVariantPicker, setOpenVariantPicker] = useState<string | null>(null);

  // Reference video (v2v motion source) — the uploaded clip whose motion
  // drives the video-to-video edit. Persisted on the node as
  // data.referenceVideoMediaId so it survives dialog close / board reload.
  const [referenceVideoMediaId, setReferenceVideoMediaId] = useState<string | null>(null);
  const [referenceVideoName, setReferenceVideoName] = useState<string | null>(null);
  const [refVideoUploading, setRefVideoUploading] = useState(false);
  const [refVideoError, setRefVideoError] = useState<string | null>(null);
  const refVideoInputRef = useRef<HTMLInputElement>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFocusRef = useRef<HTMLTextAreaElement>(null);
  const triggerRef = useRef<Element | null>(null);

  const rfId = openDialog.rfId;
  const node = nodes.find((n) => n.id === rfId);
  const boardName = useBoardStore((s) => s.boardName);
  const nodeCount = nodes.length;
  const edges = useBoardStore((s) => s.edges);

  // Hooks MUST be called unconditionally on every render — pull
  // videoModel out first, derive the boolean after.
  const videoModelFamily = useSettingsStore((s) => s.videoModel);
  const videoQuality = useSettingsStore((s) => s.videoQuality);
  const setVideoModel = useSettingsStore((s) => s.setVideoModel);
  const setVideoQuality = useSettingsStore((s) => s.setVideoQuality);
  const omniFlashDuration = useSettingsStore((s) => s.omniFlashDuration);
  const setOmniFlashDuration = useSettingsStore(
    (s) => s.setOmniFlashDuration,
  );
  // Auto-detected paygate tier (PAYGATE_TIER_ONE / TIER_TWO). Used to
  // lock the Ultra-only model chips (lite_relaxed) for Pro users — same
  // gating as the SettingsPanel.
  const paygateTier = useGenerationStore((s) => s.paygateTier);

  const rawTargetType = node?.data.type ?? "image";
  // VR nodes generate through the standard video pipeline — a VR clip IS
  // a video; the dialog collects motion prompt + source image the same way.
  // `isVR` only tweaks labels so the dialog reads as VR, not Video.
  const targetType = rawTargetType === "video_reference" ? "video" : rawTargetType;
  const isVR = rawTargetType === "video_reference";
  const isVideo = targetType === "video";
  const isCharacter = targetType === "character";
  const isStoryboard = targetType === "Storyboard";
  // Omni Flash is a video model but with image-target semantics: it
  // takes ingredients (multi reference images), NOT a single i2v start
  // frame. So the dialog should show the same "Source references" chip
  // list that image targets use, and hide Veo's source-image selector.
  const isOmniVideo = isVideo && videoModelFamily === "omni_flash";
  // Prompt nodes are text-only — clicking Generate runs auto_prompt
  // synthesis from upstream context and writes the result back to
  // node.data.prompt. No image dispatch, no aspect/variants.
  const isPrompt = targetType === "prompt";

  // Find upstream source image for video nodes. When the upstream has
  // multiple variants, we batch-i2v one video per variant — `sourceMediaIds`
  // captures the full set; `sourceMediaId` is the active variant for the
  // legacy single-source path. Excludes video_reference sources — a video
  // node can have TWO upstream edges (appearance image + motion clip) and
  // this lookup is for the appearance side only.
  const sourceEdge = isVideo
    ? edges.find(
        (e) =>
          e.target === rfId &&
          nodes.find((n) => n.id === e.source)?.data.type !== "video_reference",
      )
    : undefined;
  const sourceNode = sourceEdge ? nodes.find((n) => n.id === sourceEdge.source) : undefined;

  // Upstream video_reference node, if wired in — its mediaId becomes the
  // v2v motion source automatically, taking priority over the manual
  // in-dialog upload below (connecting a node is the more deliberate act).
  const videoRefEdge = isVideo
    ? edges.find(
        (e) => e.target === rfId && nodes.find((n) => n.id === e.source)?.data.type === "video_reference",
      )
    : undefined;
  const videoRefNode = videoRefEdge ? nodes.find((n) => n.id === videoRefEdge.source) : undefined;
  const connectedVideoRefMediaId =
    typeof videoRefNode?.data.mediaId === "string" ? videoRefNode.data.mediaId : null;
  const connectedVideoRefUrl =
    typeof videoRefNode?.data.referenceVideoUrl === "string"
      ? videoRefNode.data.referenceVideoUrl
      : null;
  // True once a motion source is wired up (connected VR node or inline
  // upload) — switches the appearance-source UI from the single-node
  // variant picker (Veo i2v's normal shape) to the multi-node ingredient
  // chip list, since v2v accepts several distinct appearance refs
  // (e.g. a character node + a separate close-up face node).
  const hasReferenceVideo =
    !!connectedVideoRefMediaId || !!connectedVideoRefUrl || !!referenceVideoMediaId;
  const showRefChips = !isVideo || isOmniVideo || (isVideo && hasReferenceVideo);

  // Storyboard → video: when ANY upstream node is a Storyboard composite,
  // the motion prompt MUST follow a fixed template that asks Flow to
  // animate the panels in order. 2x2→4 frames; 2x3→6; 2x4→8. Other
  // refs (character / location / visual_asset) still flow as normal —
  // the prompt itself is what's locked. Pick the first storyboard
  // upstream's grid (multi-storyboard edges are an edge case we don't
  // optimize for).
  const storyboardUpstream = isVideo
    ? edges
        .filter((e) => e.target === rfId)
        .map((e) => nodes.find((n) => n.id === e.source))
        .find((n) => n?.data.type === "Storyboard")
    : undefined;
  const hasStoryboardUpstream = !!storyboardUpstream;
  const storyboardUpstreamGrid = normaliseStoryboardGrid(
    storyboardUpstream?.data.storyboardGrid,
  );
  const sourceMediaId = sourceNode?.data.mediaId ?? null;
  // Drop null placeholders from the upstream variant list — partial-
  // batch results may carry them, but downstream dispatch needs a
  // dense array of valid mediaIds to feed into Flow.
  const sourceMediaIds: string[] = isVideo
    ? (sourceNode?.data.mediaIds ?? (sourceMediaId ? [sourceMediaId] : []))
        .filter((m): m is string => typeof m === "string" && m.length > 0)
    : [];

  // Image nodes: list every upstream ref edge feeding this target. We
  // walk edges (not just nodes) so we can read each edge's variant pin
  // and show the EXACT thumbnail Flow will receive — when an edge is
  // pinned to variant 2 of a 4-variant source, the chip shows variant 2,
  // not the source's "active" mediaId. Mirrors the resolution used by
  // `collectUpstreamRefMediaIds` at dispatch time so the preview can't
  // diverge from the actual API call.
  //
  // We also surface the full `allVariants` list + the edge id so the
  // chip can offer a per-source variant picker without re-querying
  // the store on click.
  // Prompt sources — text-only upstream nodes whose `prompt` feeds the
  // auto-prompt synth as context. They have no mediaId so they live in a
  // separate list from refSourceNodes; the dialog renders them as a
  // text-only chip alongside image refs so the user can SEE that a
  // Prompt node is influencing the gen.
  // Both image targets AND Omni-video targets use the ingredient chip
  // list (multi-ref upstream → one chip per edge). Veo i2v video has
  // its own single-source-with-variant-batch picker below.
  const promptSourceNodes = showRefChips && rfId
    ? edges
        .filter((e) => e.target === rfId)
        .map((e) => {
          const n = nodes.find((node) => node.id === e.source);
          if (!n || n.data.type !== "prompt") return null;
          const text = typeof n.data.prompt === "string" ? n.data.prompt : "";
          return { edgeId: e.id, node: n, text };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    : [];

  const refSourceNodes = showRefChips && rfId
    ? edges
        .filter((e) => e.target === rfId)
        .map((e) => {
          const n = nodes.find((node) => node.id === e.source);
          if (!n || !REF_SOURCE_TYPES.has(n.data.type)) return null;
          const variants = (Array.isArray(n.data.mediaIds) ? n.data.mediaIds : [])
            .filter((m): m is string => typeof m === "string" && m.length > 0);
          const pin = (e.data?.sourceVariantIdx ?? null) as number | null;
          let mediaId: string | undefined;
          let variantIdx: number | null = null;
          if (pin !== null && pin >= 0 && pin < variants.length) {
            mediaId = variants[pin];
            variantIdx = pin;
          } else if (typeof n.data.mediaId === "string" && n.data.mediaId) {
            mediaId = n.data.mediaId;
            // When dispatch falls back to source.mediaId, that's
            // typically variants[0] (gen-result writes mediaId =
            // mediaIds[0]). Surface that as the displayed variantIdx
            // so the chip's badge matches what Flow will receive,
            // even before the user clicks to pin explicitly.
            const idx = variants.indexOf(n.data.mediaId);
            variantIdx = idx >= 0 ? idx : null;
          } else if (variants.length > 0) {
            mediaId = variants[0];
            variantIdx = 0;
          }
          if (!mediaId) return null;
          return {
            edgeId: e.id,
            node: n,
            mediaId,
            variantIdx,
            allVariants: variants,
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    : [];

  // Reset form when dialog opens for a different node
  useEffect(() => {
    if (rfId !== null) {
      // Default: whatever prompt the caller seeded (last-saved on the node,
      // or empty for a fresh gen). Storyboard→video overrides this below
      // with the locked motion template.
      let initialPrompt = openDialog.prompt;
      const openNode = nodes.find((n) => n.id === rfId);
      const openNodeType = (openNode?.data.type ?? "image") === "video_reference" ? "video" : (openNode?.data.type ?? "image");
      if (openNodeType === "video") {
        const boardState = useBoardStore.getState();
        const upstream = boardState.edges
          .filter((e) => e.target === rfId)
          .map((e) => boardState.nodes.find((n) => n.id === e.source))
          .filter((n): n is NonNullable<typeof n> => !!n);
        const sb = upstream.find((n) => n.data.type === "Storyboard");
        if (sb) {
          const g = normaliseStoryboardGrid(sb.data.storyboardGrid);
          initialPrompt = buildStoryboardVideoPrompt(g);
        } else {
          // v2v (motion transfer): a reference video wired in via a
          // "VR" node OR already uploaded inline on this node locks the
          // motion-transfer template, mirroring the storyboard case above.
          const vrNode = upstream.find((n) => n.data.type === "video_reference");
          const hasRefVideo =
            typeof vrNode?.data.mediaId === "string" && vrNode.data.mediaId
              ? true
              : typeof boardState.nodes.find((n) => n.id === rfId)?.data
                    .referenceVideoMediaId === "string";
          if (hasRefVideo) {
            // Every OTHER upstream node earns an @-mention in the locked
            // template — not just the media-bearing REF_SOURCE_TYPES.
            // A Prompt/Note node has no image to feed the actual v2v
            // dispatch (that still only pulls media from `refSourceNodes`
            // below, which stays restricted to real appearance images —
            // sending a Prompt/Note/video mediaId as an appearance ref
            // would just break the API call), but it's still valid
            // CONTEXT the user wants named in the motion-transfer prompt
            // text itself (e.g. "@wardrobe-notes" pointing at a Note).
            // video_reference is excluded — that's "the reference video"
            // itself, already named generically in the template.
            const refMentions = upstream
              .filter((n) => n.data.type !== "video_reference")
              .map((n) => {
                const t = typeof n.data.title === "string" ? n.data.title.trim() : "";
                // A node still sitting on its generic default ("Image",
                // "Character", …) hasn't been deliberately named — an
                // "@Image" mention reads as noise, not a real reference.
                // Only a title the user actually customised earns an
                // @-mention; otherwise fall back to the plain shortId tag.
                const isDefaultTitle = !t || t === TYPE_TITLE[n.data.type as keyof typeof TYPE_TITLE];
                return isDefaultTitle ? `#${n.data.shortId}` : `@${t}`;
              });
            initialPrompt = buildVideoReferencePrompt(refMentions);
          }
        }
      }
      setPrompt(initialPrompt);
      // Character → always 1:1 portrait headshot (its own opinionated
      // default; ignores upstream aspect because character is the source).
      // Image / video → match upstream aspect when available; fall back to
      // landscape (image) / landscape (video) when the graph has no info.
      let nextAspect: AspectKey;
      if (openNodeType === "character") {
        nextAspect = "IMAGE_ASPECT_RATIO_SQUARE";
      } else {
        const inherited = pickDefaultAspect(
          rfId,
          openNodeType,
          nodes,
          useBoardStore.getState().edges,
        );
        if (inherited !== null) {
          nextAspect = inherited;
        } else if (openNodeType === "video") {
          nextAspect = "VIDEO_ASPECT_RATIO_LANDSCAPE";
        } else {
          nextAspect = "IMAGE_ASPECT_RATIO_LANDSCAPE";
        }
      }
      setAspectRatio(nextAspect);
      setVariants(1);
      setCamera("static");
      // Hydrate storyboard grid from existing node data when reopening.
      // Fresh nodes + legacy values ("3x3" from 1.2.15-1.2.18) → "2x2".
      const openNodeData = useBoardStore
        .getState()
        .nodes.find((n) => n.id === rfId)?.data;
      setStoryboardGrid(normaliseStoryboardGrid(openNodeData?.storyboardGrid));
      setCharGender(null);
      setCharCountry(null);
      setCharVibe("clean");
      setCharExtras("");
      setAutoBuilding(false);
      setAutoPromptUsed(false);
      // Default-select every upstream source variant for video targets so
      // the user just hits Generate when they want all videos. Skip
      // video_reference sources — that edge feeds the motion clip, not
      // the appearance variants this selector is for.
      const upstreamEdge = useBoardStore
        .getState()
        .edges.find(
          (e) =>
            e.target === rfId &&
            useBoardStore.getState().nodes.find((n) => n.id === e.source)?.data.type !==
              "video_reference",
        );
      const upstreamNode = upstreamEdge
        ? useBoardStore.getState().nodes.find((n) => n.id === upstreamEdge.source)
        : undefined;
      const ups =
        upstreamNode?.data.mediaIds ??
        (upstreamNode?.data.mediaId ? [upstreamNode.data.mediaId] : []);
      setSelectedSourceIdx(new Set(ups.map((_, i) => i)));
      // Hydrate the persisted reference video (v2v motion source) so a
      // reopened dialog shows the clip the node already has.
      const refVid =
        typeof openNodeData?.referenceVideoMediaId === "string"
          ? openNodeData.referenceVideoMediaId
          : null;
      setReferenceVideoMediaId(refVid);
      setReferenceVideoName(
        typeof openNodeData?.referenceVideoName === "string"
          ? openNodeData.referenceVideoName
          : null,
      );
      setRefVideoError(null);
      triggerRef.current = document.activeElement;
      // Focus textarea on open
      setTimeout(() => firstFocusRef.current?.focus(), 50);
    } else {
      // Return focus on close
      if (triggerRef.current instanceof HTMLElement) {
        triggerRef.current.focus();
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rfId]);

  // Keyboard handling
  useEffect(() => {
    if (rfId === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // ESC closes the variant picker first if open, otherwise the
        // dialog. Lets the user back out of a stray picker click
        // without losing their prompt + form state.
        if (openVariantPicker !== null) {
          e.preventDefault();
          setOpenVariantPicker(null);
          return;
        }
        e.preventDefault();
        closeGenerationDialog();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleSubmit();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

  // Click-outside to close the variant picker. We listen on
  // `mousedown` instead of `click` so the close fires BEFORE the chip's
  // `onClick` toggle would otherwise re-open it on the same gesture.
  // A click that lands inside any `.ref-source-chip-wrap` is ignored —
  // chip-internal handlers (toggle / swap / pick) own those.
  useEffect(() => {
    if (openVariantPicker === null) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".ref-source-chip-wrap")) return;
      setOpenVariantPicker(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [openVariantPicker]);

  // Focus trap
  useEffect(() => {
    if (rfId === null) return;
    const el = dialogRef.current;
    if (!el) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusable = el.querySelectorAll<HTMLElement>(
        "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    el.addEventListener("keydown", onKeyDown);
    return () => el.removeEventListener("keydown", onKeyDown);
  }, [rfId]);

  if (rfId === null) return null;

  /** Pick a different variant on a Source Reference chip. PATCHes the
   * edge so the dispatch path picks the new variant, then mirrors the
   * change into the local store so the chip thumbnail updates without
   * waiting for a board refresh. The pick also surfaces on the canvas
   * via the `v{N}` chip on the edge. */
  async function pickVariantForEdge(edgeId: string, variantIdx: number) {
    setOpenVariantPicker(null);
    const edgeDbId = parseInt(edgeId, 10);
    if (isNaN(edgeDbId)) return;
    try {
      const updated = await patchEdge(edgeDbId, {
        source_variant_idx: variantIdx,
      });
      useBoardStore.getState().updateEdgeData(edgeId, {
        sourceVariantIdx: updated.source_variant_idx,
      });
    } catch (err) {
      useGenerationStore.setState({
        error: `Couldn't pin variant: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /** Upload a reference video (v2v motion source) into the board's Flow
   *  project and persist its media_id on the target node. */
  async function uploadReferenceVideo(file: File) {
    if (!rfId) return;
    setRefVideoError(null);
    setRefVideoUploading(true);
    try {
      const projectId = await useGenerationStore.getState().ensureProjectId();
      if (!projectId) {
        setRefVideoError("no project — open a board first");
        return;
      }
      const dbId = parseInt(rfId, 10);
      const resp = await uploadVideo(
        file,
        projectId,
        isNaN(dbId) ? undefined : dbId,
      );
      setReferenceVideoMediaId(resp.media_id);
      setReferenceVideoName(file.name);
      // Persist on the node so the clip survives dialog close / reload.
      useBoardStore.getState().updateNodeData(rfId, {
        referenceVideoMediaId: resp.media_id,
        referenceVideoName: file.name,
      });
      if (!isNaN(dbId)) {
        patchNode(dbId, {
          data: {
            referenceVideoMediaId: resp.media_id,
            referenceVideoName: file.name,
          },
        }).catch(() => {});
      }
    } catch (err) {
      setRefVideoError(
        err instanceof Error ? err.message : "video upload failed",
      );
    } finally {
      setRefVideoUploading(false);
    }
  }

  /** Detach the reference video from the node (local store + backend). */
  function clearReferenceVideo() {
    if (!rfId) return;
    setReferenceVideoMediaId(null);
    setReferenceVideoName(null);
    const dbId = parseInt(rfId, 10);
    // `undefined` clears in the local store merge; `null` is the
    // backend's explicit delete sentinel.
    useBoardStore.getState().updateNodeData(rfId, {
      referenceVideoMediaId: undefined,
      referenceVideoName: undefined,
    });
    if (!isNaN(dbId)) {
      patchNode(dbId, {
        data: {
          referenceVideoMediaId: null,
          referenceVideoName: null,
        },
      }).catch(() => {});
    }
  }

  async function handleSubmit() {
    if (!rfId) return;
    // Defense in depth — block submit if the LLM layer is still composing
    // for this node from a prior dialog session. The Generate button is
    // already `disabled` at this point, but the user could still trigger
    // ⌘↵ via keyboard.
    if (
      node?.data.autoPromptStatus === "pending"
      || node?.data.aiBriefStatus === "pending"
    ) {
      return;
    }
    if (isStoryboard) {
      // Storyboard is a thin image-node wrapper. The user's prompt
      // textarea is the TOPIC; we wrap it in the locked template and
      // dispatch via the standard image path — Flow renders a single
      // composite NxN grid that visually narrates the topic.
      const wrapped = buildStoryboardPrompt(
        prompt,
        storyboardGrid,
        aspectRatio,
      );
      // Persist the chosen grid + topic on the node so reload shows
      // the same settings and `StoryboardBody` can render the grid badge.
      useBoardStore.getState().updateNodeData(rfId, {
        storyboardGrid,
        aiBrief: prompt,
      });
      const dbId = parseInt(rfId, 10);
      if (!isNaN(dbId)) {
        patchNode(dbId, {
          data: { storyboardGrid, aiBrief: prompt },
        }).catch(() => {});
      }
      dispatchGeneration(rfId, {
        prompt: wrapped,
        aspectRatio,
        kind: "image",
        variantCount: variants,
      });
      closeGenerationDialog();
      return;
    }
    if (isPrompt) {
      // Prompt nodes are user-authored seed text. The dialog is just
      // an editor — Save persists whatever the user typed (or cleared).
      // No auto-synth, no image/video dispatch. Downstream image/video
      // nodes pick up this prompt as upstream context at their own
      // dispatch time.
      const dbId = parseInt(rfId, 10);
      if (isNaN(dbId)) {
        closeGenerationDialog();
        return;
      }
      const finalPrompt = prompt;
      useBoardStore.getState().updateNodeData(rfId, {
        prompt: finalPrompt,
        status: finalPrompt.trim() ? "done" : "idle",
      });
      patchNode(dbId, {
        status: finalPrompt.trim() ? "done" : "idle",
        data: { prompt: finalPrompt },
      }).catch(() => {});
      closeGenerationDialog();
      return;
    }
    if (isCharacter) {
      const built = buildCharacterPrompt(charGender, charCountry, charVibe, charExtras);
      // Stamp the picker selections directly onto the node so the detail
      // panel can show "Country: Jepang · Vibe: Douyin" later. These
      // choices don't round-trip through the backend params (they're
      // baked into the prompt text), so we persist them here at dispatch
      // time. patchNode merges, so this fires alongside the generation
      // store's own status patches without colliding.
      const charStamp: Record<string, unknown> = {};
      if (charCountry) charStamp.charCountry = charCountry;
      if (charVibe) charStamp.charVibe = charVibe;
      if (charGender) charStamp.charGender = charGender;
      if (Object.keys(charStamp).length > 0) {
        useBoardStore.getState().updateNodeData(rfId, charStamp);
        const dbId = parseInt(rfId, 10);
        if (!isNaN(dbId)) {
          patchNode(dbId, { data: charStamp }).catch(() => {});
        }
      }
      dispatchGeneration(rfId, {
        prompt: built,
        aspectRatio,
        variantCount: variants,
      });
      closeGenerationDialog();
      return;
    }
    // Image / video branch — if user left the prompt blank, synthesise
    // from upstream briefs (composition prompt for image, motion prompt
    // for video) before dispatching. For image with variants > 1 use the
    // batch endpoint so each variant gets its own pose-distinct prompt.
    let finalPrompt = prompt;
    let perVariantPrompts: string[] | undefined;
    if (!finalPrompt.trim()) {
      const dbId = parseInt(rfId, 10);
      if (isNaN(dbId)) {
        return;
      }
      setAutoBuilding(true);
      // Mark the target node as "auto-prompt running" so the canvas
      // can render a busy treatment + block duplicate dispatches on
      // the same node. Cleared in finally below regardless of outcome.
      useBoardStore.getState().updateNodeData(rfId, { autoPromptStatus: "pending" });
      try {
        if (!isVideo && variants > 1) {
          const res = await autoPromptBatchApi(dbId, variants);
          perVariantPrompts = res.prompts;
          // Show all N prompts joined so the user can verify before
          // dispatch — we don't dispatch until they re-click Generate
          // (so they see what was synthesised first time around either)…
          // actually simpler: dispatch immediately with the first as the
          // "display" prompt; full per-variant list goes through opts.
          finalPrompt = res.prompts[0] ?? "";
          setPrompt(res.prompts.join("\n\n— variant —\n\n"));
        } else {
          const res = await autoPromptApi(dbId, isVideo ? { camera } : undefined);
          finalPrompt = res.prompt;
          setPrompt(finalPrompt);
        }
        setAutoPromptUsed(true);
        useBoardStore.getState().updateNodeData(rfId, { autoPromptStatus: undefined });
      } catch (err) {
        setAutoBuilding(false);
        useBoardStore.getState().updateNodeData(rfId, { autoPromptStatus: "failed" });
        useGenerationStore.setState({
          error: err instanceof Error
            ? `Auto-prompt failed: ${err.message}`
            : "Auto-prompt failed",
        });
        return;
      }
      setAutoBuilding(false);
    }
    if (isVideo) {
      // Append the camera-movement constraint to whatever motion prompt
      // we have (manual or auto-synthesised). Putting it last makes it
      // the dominant instruction the model resolves against — overrides
      // any conflicting "slow dolly-in" the synthesizer might have output.
      // Skip entirely for v2v (reference video) — the locked template
      // already says "do not add/invent actions not in the reference
      // video", so appending a camera move fights its own instruction.
      const camInstruction = hasReferenceVideo ? "" : cameraInstruction(camera);
      const videoPrompt = camInstruction
        ? `${finalPrompt}. ${camInstruction}`
        : finalPrompt;
      // v2v (reference video present): source images come from EVERY
      // wired-up appearance ref node (character + optional close-up face
      // node, etc.), not the single-node variant picker — mirrors Omni
      // Flash's ingredient list. Otherwise, filter the upstream variants
      // to the user's selection from the toggleable thumbnail picker.
      const picked = hasReferenceVideo
        ? refSourceNodes.map((r) => r.mediaId)
        : sourceMediaIds.filter((_, i) => selectedSourceIdx.has(i));
      const useMulti = hasReferenceVideo ? true : picked.length > 1;
      dispatchGeneration(rfId, {
        prompt: videoPrompt,
        aspectRatio,
        kind: "video",
        sourceMediaId: useMulti ? undefined : picked[0],
        sourceMediaIds: useMulti ? picked : undefined,
        // Reference video (v2v motion source) — a connected "VR"
        // node wins over the inline dialog upload. Forwarded
        // to the backend as reference_video_media_id / reference_video_url
        // (link-only: fetched in-memory at Generate, never stored locally).
        referenceVideoMediaId: connectedVideoRefMediaId ?? referenceVideoMediaId ?? undefined,
        referenceVideoUrl: connectedVideoRefUrl ?? undefined,
        // Tell the node UI how many video tiles to reserve while pending —
        // otherwise it defaults to 1 placeholder even though we're
        // dispatching N i2v ops. v2v is always a single agent-dispatched
        // job (one output video) no matter how many appearance refs feed
        // it, unlike Veo's one-job-per-source-variant batch.
        variantCount: hasReferenceVideo ? 1 : picked.length,
      });
    } else {
      dispatchGeneration(rfId, {
        prompt: finalPrompt,
        aspectRatio,
        variantCount: variants,
        prompts: perVariantPrompts,
      });
    }
    closeGenerationDialog();
  }

  // The dialog's local `autoBuilding` flag covers the in-flight window
  // when THIS dialog instance is composing. But the dialog can be closed
  // + reopened mid-flight, leaving the local flag fresh while the node-
  // level `autoPromptStatus` / `aiBriefStatus` is still pending from the
  // first run. Treat both signals as "busy" so the user can't double-fire.
  const nodeLLMBusy =
    node?.data.autoPromptStatus === "pending"
    || node?.data.aiBriefStatus === "pending";
  const isWorking = autoBuilding || nodeLLMBusy;

  // Both image and video allow empty prompt — we'll auto-synth on submit.
  // Veo i2v needs at least one selected source variant; Omni Flash and v2v
  // (reference video present) need at least one ingredient (any upstream
  // image-bearing node). Other targets just need the LLM not be busy.
  const canGenerate = isCharacter
    ? charGender !== null || charCountry !== null || charExtras.trim().length > 0
    : isOmniVideo
    ? refSourceNodes.length > 0 && !isWorking
    : isVideo && hasReferenceVideo
    ? refSourceNodes.length > 0 && !isWorking
    : isVideo
    ? selectedSourceIdx.size > 0 && !isWorking
    : !isWorking;

  return (
    <div
      className="gen-dialog-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeGenerationDialog();
      }}
    >
      <div
        className="gen-dialog"
        role="dialog"
        aria-labelledby="gen-dialog-title"
        aria-modal="true"
        ref={dialogRef}
      >
        {/* Header */}
        <div className="gen-dialog__header">
          <div>
            <h2 id="gen-dialog-title" className="gen-dialog__title">
              {isVR
                ? "Generate VR clip"
                : isVideo
                ? "Generate video"
                : isCharacter
                ? "Generate character"
                : isStoryboard
                ? "Generate storyboard"
                : isPrompt
                ? "Edit prompt"
                : "Generate image"}
            </h2>
            <span className="gen-dialog__subtitle">
              Node #{node?.data.shortId ?? rfId}
            </span>
          </div>
          <button
            className="gen-dialog__close"
            onClick={closeGenerationDialog}
            aria-label="Close dialog (Escape)"
          >
            esc
          </button>
        </div>

        {/* Prompt — hidden when character mode shows the builder instead */}
        {!isCharacter && (
          <div className="gen-dialog__field">
            <div className="gen-dialog__label-row">
              <label className="gen-dialog__label" htmlFor="gen-prompt">
                {isVideo ? "Motion prompt" : "Prompt"}
                {autoPromptUsed && (
                  <span className="gen-dialog__auto-badge" title="Auto-generated from upstream nodes">
                    ✨ auto
                  </span>
                )}
              </label>
              <span className="gen-dialog__char-count">{prompt.length}/500</span>
            </div>
            <textarea
              id="gen-prompt"
              ref={firstFocusRef}
              className="gen-dialog__textarea"
              rows={5}
              maxLength={500}
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                if (autoPromptUsed) setAutoPromptUsed(false);
              }}
              placeholder={
                isVideo
                  ? "Kosongkan untuk auto-generate motion prompt dari source image ✨"
                  : isPrompt
                  ? "Masukkan prompt awal untuk downstream image / video…"
                  : "Kosongkan untuk auto-generate prompt dari upstream nodes ✨"
              }
              disabled={isWorking}
              readOnly={hasStoryboardUpstream}
              title={
                hasStoryboardUpstream
                  ? "Locked: storyboard motion template (animates panels in order)"
                  : undefined
              }
            />
            {hasStoryboardUpstream && (
              <p className="gen-dialog__hint gen-dialog__hint--locked">
                🎬 <strong>Storyboard motion template</strong> — locked because an
                upstream Storyboard node is feeding this video. Flow animates
                the composite panels in order (frame 1 →
                {" "}{totalPanels(storyboardUpstreamGrid)}). Other refs
                (character / location / visual_asset) still flow through normally.
              </p>
            )}
            {isWorking && (
              <p className="gen-dialog__hint">
                {node?.data.aiBriefStatus === "pending"
                  ? "✨ Sedang menganalisis image…"
                  : "✨ Sedang menyusun prompt dari upstream context…"}
              </p>
            )}
          </div>
        )}

        {/* Character builder (character node only) */}
        {isCharacter && (
          <>
            <div className="gen-dialog__field">
              <span className="gen-dialog__label">Gender</span>
              <div className="aspect-chip-row">
                {CHARACTER_GENDERS.map((g) => (
                  <button
                    key={g.key}
                    type="button"
                    className={`aspect-chip${charGender === g.key ? " aspect-chip--active" : ""}`}
                    onClick={() => setCharGender(charGender === g.key ? null : g.key)}
                  >
                    {g.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="gen-dialog__field">
              <span className="gen-dialog__label">Negara</span>
              <div className="aspect-chip-row">
                {CHARACTER_COUNTRIES.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    className={`aspect-chip${charCountry === c.key ? " aspect-chip--active" : ""}`}
                    onClick={() => setCharCountry(charCountry === c.key ? null : c.key)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="gen-dialog__field">
              <span className="gen-dialog__label">Vibe</span>
              <div className="aspect-chip-row">
                {CHARACTER_VIBES.map((v) => (
                  <button
                    key={v.key}
                    type="button"
                    className={`aspect-chip${charVibe === v.key ? " aspect-chip--active" : ""}`}
                    onClick={() => setCharVibe(v.key)}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="gen-dialog__field">
              <div className="gen-dialog__label-row">
                <label className="gen-dialog__label" htmlFor="gen-char-extras">
                  Deskripsi tambahan (opsional)
                  <InfoTip tip="Prompt dibuat otomatis: portrait headshot · vibe styling · photorealistic — optimal untuk character reference." />
                </label>
                <span className="gen-dialog__char-count">{charExtras.length}/200</span>
              </div>
              <textarea
                id="gen-char-extras"
                ref={firstFocusRef}
                className="gen-dialog__textarea"
                rows={3}
                maxLength={200}
                value={charExtras}
                onChange={(e) => setCharExtras(e.target.value)}
                placeholder="Umur, gaya rambut, pakaian, ekspresi…"
              />
            </div>
          </>
        )}

        {/* Source image — Veo i2v ONLY. Omni Flash AND v2v (reference
            video present) use the ingredient chip list (`refSourceNodes`)
            above instead — v2v accepts several distinct appearance refs
            (e.g. character + a separate close-up face node), which the
            single-node variant picker below can't express. */}
        {isVideo && !isOmniVideo && !hasReferenceVideo && (
          <div className="gen-dialog__field">
            <div className="gen-dialog__label-row">
              <span className="gen-dialog__label">
                Source image{sourceMediaIds.length > 1 ? `s (${sourceMediaIds.length})` : ""}
              </span>
              {sourceMediaIds.length > 1 && (
                <div className="source-select-actions">
                  <button
                    type="button"
                    className="source-select-mini"
                    onClick={() =>
                      setSelectedSourceIdx(
                        new Set(sourceMediaIds.map((_, i) => i)),
                      )
                    }
                  >
                    All
                  </button>
                  <button
                    type="button"
                    className="source-select-mini"
                    onClick={() => setSelectedSourceIdx(new Set())}
                  >
                    None
                  </button>
                </div>
              )}
            </div>
            {sourceMediaIds.length > 0 && sourceNode ? (
              <>
                <div className="source-image-row">
                  {sourceMediaIds.map((mid, i) => {
                    const checked = selectedSourceIdx.has(i);
                    return (
                      <button
                        key={mid}
                        type="button"
                        className={`source-thumb${checked ? " source-thumb--checked" : ""}`}
                        onClick={() => {
                          setSelectedSourceIdx((prev) => {
                            const next = new Set(prev);
                            if (next.has(i)) next.delete(i);
                            else next.add(i);
                            return next;
                          });
                        }}
                        aria-pressed={checked}
                        aria-label={`Variant ${i + 1}${checked ? " selected" : ""}`}
                      >
                        <img
                          className="source-image-row__thumb"
                          src={mediaUrl(mid)}
                          alt={sourceNode.data.title}
                        />
                        <span className="source-thumb__check" aria-hidden="true">
                          {checked ? "✓" : ""}
                        </span>
                      </button>
                    );
                  })}
                  <span className="source-image-row__label">
                    #{sourceNode.data.shortId}
                  </span>
                </div>
                <p className="gen-dialog__hint">
                  {selectedSourceIdx.size === 0 ? (
                    <span style={{ color: "#ef4444" }}>
                      Pilih minimal 1 variant untuk gen video.
                    </span>
                  ) : (
                    <>
                      Akan gen <strong>{selectedSourceIdx.size} video</strong>
                      {selectedSourceIdx.size === sourceMediaIds.length
                        ? " (semua variants)"
                        : ` (${selectedSourceIdx.size}/${sourceMediaIds.length} variants)`}
                      — dengan prompt + camera setting yang sama.
                    </>
                  )}
                </p>
              </>
            ) : (
              <div className="source-image-row source-image-row--empty">
                Connect an upstream image node with rendered media first
              </div>
            )}
          </div>
        )}

        {/* Reference video — v2v motion source. Video targets only. The
            clip supplies the MOTION for a video-to-video edit; the
            upstream image(s) supply the appearance. Two ways in: wire a
            "VR" node upstream (preferred — visible on the
            board, reusable across nodes), or upload inline below as a
            quick one-off. A connected node always wins. */}
        {isVideo && (
          <div className="gen-dialog__field">
            <div className="gen-dialog__label-row">
              <span className="gen-dialog__label">
                Video referensi (motion source)
                <InfoTip tip="Sumber GERAKAN untuk video-to-video (motion transfer / abra_edit): penampilan diambil dari source image, gerakan dari klip ini. Sambungkan node 'VR' ke node ini, atau unggah langsung di sini." />
              </span>
            </div>
            {isOmniVideo && hasReferenceVideo && (
              <p className="gen-dialog__hint">
                Omni Flash dipilih di Settings, tapi generate ini otomatis
                jalan lewat Veo v2v — Omni Flash tidak dukung motion
                transfer sama sekali.
              </p>
            )}
            {connectedVideoRefMediaId || connectedVideoRefUrl ? (
              <div className="ref-video">
                <video
                  className="ref-video__preview"
                  src={connectedVideoRefMediaId ? mediaUrl(connectedVideoRefMediaId) : (connectedVideoRefUrl ?? "")}
                  controls
                  muted
                  preload="metadata"
                />
                <div className="ref-video__meta">
                  <span className="ref-video__name">
                    ❏ Terhubung dari node #{videoRefNode?.data.shortId}
                    {connectedVideoRefUrl && !connectedVideoRefMediaId ? " (link — tanpa unduh)" : ""}
                  </span>
                </div>
              </div>
            ) : referenceVideoMediaId ? (
              <div className="ref-video">
                <video
                  className="ref-video__preview"
                  src={mediaUrl(referenceVideoMediaId)}
                  controls
                  muted
                  preload="metadata"
                />
                <div className="ref-video__meta">
                  <span
                    className="ref-video__name"
                    title={referenceVideoName ?? "VR"}
                  >
                    ❏ {referenceVideoName ?? "VR"}
                  </span>
                  <button
                    type="button"
                    className="ref-video__remove"
                    onClick={clearReferenceVideo}
                    aria-label="Remove reference video"
                    title="Remove reference video"
                  >
                    ✕ Remove
                  </button>
                </div>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  className="ref-video-drop"
                  onClick={() => refVideoInputRef.current?.click()}
                  disabled={refVideoUploading}
                >
                  {refVideoUploading ? "Uploading…" : "⬆ Upload video referensi"}
                </button>
                <p className="gen-dialog__hint">
                  mp4 / webm / mov · max 200 MB — gerakan klip ini dipakai
                  untuk motion transfer ke source image
                </p>
              </>
            )}
            {refVideoError && (
              <p className="gen-dialog__hint ref-video__error">{refVideoError}</p>
            )}
            <input
              ref={refVideoInputRef}
              type="file"
              accept="video/mp4,video/webm,video/quicktime"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void uploadReferenceVideo(f);
                e.target.value = "";
              }}
            />
          </div>
        )}

        {/* Source references — image refs (character/image/visual_asset/
            Storyboard) AND prompt-text refs. Prompt nodes don't have
            media but their text feeds the auto-prompt synth, so we
            surface them as text chips next to the thumbnails. */}
        {showRefChips
          && (refSourceNodes.length > 0 || promptSourceNodes.length > 0)
          && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              Source references ({refSourceNodes.length + promptSourceNodes.length})
            </span>
            <div className="ref-source-row">
              {promptSourceNodes.map((p) => {
                const preview = p.text.trim() || "(empty prompt)";
                return (
                  <div
                    key={p.edgeId}
                    className="ref-source-chip ref-source-chip--prompt"
                    title={`${p.node.data.title || "Prompt"} — ${preview}`}
                  >
                    <div className="ref-source-chip__prompt-body">
                      <span className="ref-source-chip__prompt-icon" aria-hidden="true">✦</span>
                      <span className="ref-source-chip__prompt-text">
                        {preview}
                      </span>
                    </div>
                    <span className="ref-source-chip__id">
                      #{p.node.data.shortId}
                    </span>
                  </div>
                );
              })}
              {refSourceNodes.map((r) => {
                const isMulti = r.allVariants.length >= 2;
                const isPickerOpen = openVariantPicker === r.edgeId;
                const tooltip = isMulti
                  ? `${r.node.data.title} — variant ${(r.variantIdx ?? 0) + 1} · click to switch`
                  : r.node.data.title;
                return (
                  <div key={r.edgeId} className="ref-source-chip-wrap">
                    {isMulti ? (
                      <button
                        type="button"
                        className={`ref-source-chip ref-source-chip--switchable${
                          isPickerOpen ? " ref-source-chip--active" : ""
                        }`}
                        title={tooltip}
                        onClick={() =>
                          setOpenVariantPicker(isPickerOpen ? null : r.edgeId)
                        }
                      >
                        <img
                          className="ref-source-chip__img"
                          src={mediaUrl(r.mediaId)}
                          alt={r.node.data.title}
                        />
                        <span className="ref-source-chip__variant">
                          v{(r.variantIdx ?? 0) + 1}
                        </span>
                        <span className="ref-source-chip__id">
                          #{r.node.data.shortId}
                        </span>
                      </button>
                    ) : (
                      <div className="ref-source-chip" title={tooltip}>
                        <img
                          className="ref-source-chip__img"
                          src={mediaUrl(r.mediaId)}
                          alt={r.node.data.title}
                        />
                        <span className="ref-source-chip__id">
                          #{r.node.data.shortId}
                        </span>
                      </div>
                    )}
                    {isMulti && isPickerOpen && (
                      <div
                        className="ref-source-chip__picker"
                        role="dialog"
                        aria-label={`Pick variant for ${r.node.data.title}`}
                      >
                        {r.allVariants.map((mid, i) => {
                          const isCurrent = i === (r.variantIdx ?? 0);
                          return (
                            <button
                              key={mid}
                              type="button"
                              className={`ref-source-chip__picker-item${
                                isCurrent ? " ref-source-chip__picker-item--current" : ""
                              }`}
                              onClick={() => void pickVariantForEdge(r.edgeId, i)}
                              title={`Variant ${i + 1}`}
                              aria-current={isCurrent ? "true" : undefined}
                            >
                              <img
                                className="ref-source-chip__picker-img"
                                src={mediaUrl(mid)}
                                alt={`Variant ${i + 1}`}
                              />
                              <span className="ref-source-chip__picker-label">
                                v{i + 1}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Aspect ratio — irrelevant for prompt nodes (text-only). */}
        {!isPrompt && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">Aspect ratio</span>
            <div className="aspect-chip-row">
              {(isVideo ? VIDEO_ASPECT_RATIOS : IMAGE_ASPECT_RATIOS).map((ar) => (
                <button
                  key={ar.key}
                  className={`aspect-chip${aspectRatio === ar.key ? " aspect-chip--active" : ""}`}
                  onClick={() => setAspectRatio(ar.key)}
                  type="button"
                >
                  {ar.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Omni Flash duration picker — video only, when the user's
            settings select the Omni model family. Replaces the implicit
            ~8s Veo duration with a per-dispatch radio. Credit cost is
            surfaced beside each option. */}
        {isOmniVideo && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              Duration (Omni Flash)
              <InfoTip tip="Omni Flash dispatches via video:batchAsyncGenerateVideoReferenceImages with the upstream image(s) as IMAGE_USAGE_TYPE_ASSET refs. Duration scales credit cost: 4s=15, 6s=20, 8s=25, 10s=30." />
            </span>
            <div className="aspect-chip-row">
              {OMNI_FLASH_DURATIONS.map((d) => {
                const active = omniFlashDuration === d;
                return (
                  <button
                    key={d}
                    type="button"
                    className={`aspect-chip${active ? " aspect-chip--active" : ""}`}
                    onClick={() =>
                      setOmniFlashDuration(d as OmniFlashDuration)
                    }
                    title={`${d}s — ${OMNI_FLASH_CREDIT_COST[d]} credits`}
                  >
                    {d}s · {OMNI_FLASH_CREDIT_COST[d]}c
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Model picker (video only) — mirrors the unified list from
            SettingsPanel. Native <select> for compactness; selecting an
            option stamps videoModel + videoQuality on the global
            settings store so the override sticks for the next dispatch.
            Encode option `value` as "veo:<quality>" or "omni" so the
            change handler can split it back into the two store fields. */}
        {isVideo && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              Model
              <InfoTip tip="Sticky — pilihan tersimpan untuk dispatch berikutnya (sinkron dengan Settings). Veo memakai i2v (1 source image); Omni Flash memakai reference ingredients (multi-gambar) dengan duration 4/6/8/10s, pilih di bawah." />
            </span>
            <select
              className="gen-dialog__select"
              value={
                videoModelFamily === "omni_flash"
                  ? "omni"
                  : `veo:${videoQuality}`
              }
              onChange={(e) => {
                const v = e.target.value;
                if (v === "omni") {
                  setVideoModel("omni_flash");
                  return;
                }
                const [, quality] = v.split(":") as ["veo", VideoQuality];
                setVideoModel("veo");
                setVideoQuality(quality);
              }}
            >
              {VIDEO_MODEL_CHIPS.map((m) => {
                if (m.kind === "omni") {
                  return (
                    <option key="omni" value="omni">
                      Omni Flash
                    </option>
                  );
                }
                const locked =
                  m.ultraOnly && paygateTier !== "PAYGATE_TIER_TWO";
                return (
                  <option
                    key={`veo:${m.quality}`}
                    value={`veo:${m.quality}`}
                    disabled={locked}
                  >
                    {m.label}
                    {m.ultraOnly ? " · Ultra only" : ""}
                  </option>
                );
              })}
            </select>
          </div>
        )}

        {/* Camera movement (video only, not v2v — motion comes from the reference video) */}
        {isVideo && !hasReferenceVideo && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              Camera
              <InfoTip tip="Static = locked-off, tanpa zoom/pan — cocok untuk product shot e-commerce. Dynamic = biarkan auto-prompt menentukan camera move (dolly / micro-shift / …)." />
            </span>
            <div className="aspect-chip-row">
              {CAMERA_MOVEMENTS.map((c) => (
                <button
                  key={c.key}
                  className={`aspect-chip${camera === c.key ? " aspect-chip--active" : ""}`}
                  onClick={() => setCamera(c.key)}
                  type="button"
                  title={c.instruction}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Variants stepper — image + storyboard (storyboard reuses the
            image dispatch path; up to 4 composite variants per request).
            Hidden for video (its own one-clip-per-source-variant flow
            above) and prompt nodes. */}
        {!isVideo && !isPrompt && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">Variants</span>
            <div className="variants-stepper">
              <button
                type="button"
                disabled={variants <= 1}
                aria-label="Decrease variants"
                onClick={() => setVariants((v) => Math.max(1, v - 1))}
              >
                −
              </button>
              <span>{variants}</span>
              <button
                type="button"
                disabled={variants >= 4}
                aria-label="Increase variants"
                onClick={() => setVariants((v) => Math.min(4, v + 1))}
              >
                +
              </button>
              <span className="variants-stepper__hint">1–4 images per request</span>
            </div>
          </div>
        )}

        {/* Grid radio — storyboard only. Three options: 2x2 (4 panels),
            2x3 (6), 2x4 (8). For 2x3 / 2x4 the rows × cols flip based on
            the chosen aspect ratio: landscape → wide grid (e.g. 2×3),
            portrait → tall grid (3×2). */}
        {isStoryboard && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              Grid
              <InfoTip tip="Storyboard renders as a SINGLE composite image — Flow draws the whole grid as one picture. The topic field above is your story (mis. Kura-kura dan Kelinci); the locked template wraps it for you. For 2×3 / 2×4 the rows × cols flip with the aspect ratio so panels stay readable on both landscape and portrait composites." />
            </span>
            <div className="aspect-chip-row">
              {STORYBOARD_GRIDS.map((g) => {
                const total = totalPanels(g);
                const isPortrait = aspectRatio.includes("PORTRAIT");
                // For symmetric 2x2 the label is just "2×2". For 2x3 /
                // 2x4 we render the concrete rows×cols pair that Flow
                // will receive, so the user sees orientation reflected.
                let dimsLabel = "2×2";
                if (g !== "2x2") {
                  const big = g === "2x3" ? 3 : 4;
                  dimsLabel = isPortrait ? `${big}×2` : `2×${big}`;
                }
                return (
                  <button
                    key={g}
                    type="button"
                    className={`aspect-chip${storyboardGrid === g ? " aspect-chip--active" : ""}`}
                    onClick={() => setStoryboardGrid(g)}
                    title={`${total} panels (${dimsLabel})`}
                  >
                    {dimsLabel} · {total} panels
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="gen-dialog__footer">
          <span className="gen-dialog__board-ctx">
            {boardName} · {nodeCount} node{nodeCount !== 1 ? "s" : ""}
          </span>
          <button
            className="gen-dialog__cta"
            type="button"
            onClick={handleSubmit}
            disabled={!canGenerate}
            title={
              nodeLLMBusy && !autoBuilding
                ? "Backend is still composing — try again in a moment"
                : undefined
            }
          >
            {isWorking
              ? "Building…"
              : isPrompt
              ? "Save ⌘↵"
              : "Generate ⌘↵"}
          </button>
        </div>
      </div>
    </div>
  );
}
