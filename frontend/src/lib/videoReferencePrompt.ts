// Locked prompt template for video-to-video motion transfer (v2v): a
// reference video supplies the MOTION, one or more upstream character /
// image / visual_asset nodes supply the APPEARANCE. Mirrors
// storyboardPrompt.ts's buildStoryboardVideoPrompt — tweak wording here,
// never inline at the dispatch site.
//
// `refMentions` are ready-to-use mention tags for the upstream appearance
// nodes, in edge order — `@<title>` for a node the user actually renamed,
// `#<shortId>` for one still sitting on its generic default ("Image",
// "Character", …), since an "@Image" mention reads as noise rather than a
// real reference. The first is treated as the primary identity source;
// any additional ones are framed as close-up / detail references for the
// same character (mirrors how Flow's own "@" ingredient mentions work in
// the web UI).
export function buildVideoReferencePrompt(refMentions: string[]): string {
  const primary = refMentions[0] ?? "the reference character image";
  const extras = refMentions.slice(1);
  const extraLine = extras.length
    ? ` The image ${extras.join(", ")} is an additional close-up facial reference used only to maintain maximum accuracy of the character's facial features.`
    : "";

  return [
    `Use the reference video as the primary and strict motion-performance reference.`,
    `Reproduce the motion from the reference video as accurately as possible, including the exact timing, movement sequence, body motion, posture changes, head movement, facial expressions, eye movement, blinking, mouth movement, lip motion, subtle facial movements, gestures, and natural pauses.`,
    `The animation should closely follow the reference video's motion trajectory, timing, rhythm, acceleration, deceleration, and overall performance from beginning to end. Preserve the same temporal flow and movement dynamics of the reference video.`,
    `Apply all of these movements to the character from ${primary} while preserving the character's exact identity and appearance. The character's face, facial structure, hairstyle, hair color, skin, clothing, body proportions, and natural facial details must remain consistent with ${primary}.`,
    `Do not copy, recreate, or preserve the identity, facial features, appearance, clothing, or physical characteristics of the person in the reference video. Extract only the motion and performance information from the video and transfer it to the character from ${primary}.`,
    `The image ${primary} is the definitive source for the character's identity and visual appearance.${extraLine}`,
    `Keep the character's mouth movement natural and consistent with the reference video's performance, including subtle mouth opening and closing when present.`,
    `Maintain the background, environment, lighting, and overall visual setting from ${primary} throughout the animation unless movement in the reference video explicitly requires otherwise.`,
    `Create one continuous shot. Do not add, remove, or invent actions that are not present in the reference video.`,
    `Prioritize motion fidelity to the reference video while strictly preserving the identity and visual appearance of ${primary}.`,
  ].join(" ");
}
