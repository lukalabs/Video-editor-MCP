import React, { useCallback } from "react";
import { ToolcraftCard as Card } from "@openreel/ui";
import { ToolcraftSelectControl as Selector } from "@openreel/ui";
import { ToolcraftText as Text } from "@openreel/ui";
import {
  CAPTION_ANIMATION_STYLES,
  deriveWordTimings,
  getAnimationStyleDisplayName,
  type CaptionAnimationStyle,
} from "@openreel/core";
import { useProjectStore } from "../../../stores/project-store";

/**
 * Word-by-word animation for a caption clip.
 *
 * Reads and writes the text clip's own `words` / `animationStyle`. The section this
 * replaces was bound to `timeline.subtitles`, which nothing ever populates, so its
 * dropdown could never affect anything on screen.
 */

const STYLE_HINTS: Record<CaptionAnimationStyle, string> = {
  none: "Static text, no animation",
  "word-highlight": "Each word is colour-highlighted as it is spoken",
  "word-by-word": "Only the word being spoken is on screen",
  karaoke: "Spoken words stay lit, upcoming words stay dim",
  bounce: "Each word bounces in as it arrives",
  typewriter: "Words appear one after another and stay",
};

export interface CaptionAnimationSectionProps {
  clipId: string;
}

export const CaptionAnimationSection: React.FC<CaptionAnimationSectionProps> = ({
  clipId,
}) => {
  const clip = useProjectStore((state) => state.getTextClip(clipId));
  // Re-reads after every project mutation; the title engine holds the clips, so the
  // store object alone would not tell this component a word list changed.
  useProjectStore((state) => state.project);
  const setCaptionAnimation = useProjectStore((state) => state.setCaptionAnimation);
  const updateTextStyle = useProjectStore((state) => state.updateTextStyle);

  const wordCount = clip?.words?.length ?? 0;
  const animationStyle = clip?.animationStyle ?? "none";

  const handleStyleChange = useCallback(
    (value: string) => {
      if (!clip) return;
      const nextStyle = value as CaptionAnimationStyle;
      // A caption written before word timings existed, or one whose text was edited
      // since, has nothing to animate. Deriving on demand means picking a style is
      // always enough on its own - there is no second step to discover.
      const needsWords = nextStyle !== "none" && (clip.words?.length ?? 0) === 0;
      setCaptionAnimation(clip.id, {
        animationStyle: nextStyle,
        ...(needsWords
          ? { words: deriveWordTimings(clip.text, clip.duration) }
          : {}),
      });
    },
    [clip, setCaptionAnimation],
  );

  const handleColourChange = useCallback(
    (field: "highlightColor" | "upcomingColor", value: string) => {
      if (!clip) return;
      updateTextStyle(clip.id, { [field]: value });
    },
    [clip, updateTextStyle],
  );

  if (!clip) return null;

  const showColours =
    animationStyle === "word-highlight" || animationStyle === "karaoke";

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <Text type="supporting" color="secondary" className="text-[10px]">
          Style
        </Text>
        <Selector
          label="Caption animation style"
          isLabelHidden
          value={animationStyle}
          onChange={handleStyleChange}
          options={CAPTION_ANIMATION_STYLES.map((style) => ({
            value: style,
            label: getAnimationStyleDisplayName(style),
          }))}
        />
      </div>

      <Text type="supporting" color="secondary" className="text-[10px]">
        {STYLE_HINTS[animationStyle]}
      </Text>

      {showColours && (
        <div className="space-y-2 border-t border-border pt-2">
          <div className="flex items-center justify-between gap-2">
            <Text type="supporting" color="secondary" className="text-[10px]">
              Spoken word
            </Text>
            <input
              aria-label="Highlight colour"
              type="color"
              value={clip.style.highlightColor ?? "#ffd400"}
              onChange={(event) =>
                handleColourChange("highlightColor", event.target.value)
              }
              className="h-7 w-12 rounded-md border border-border/70 bg-bg-2"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <Text type="supporting" color="secondary" className="text-[10px]">
              Not yet spoken
            </Text>
            <input
              aria-label="Upcoming word colour"
              type="color"
              value={clip.style.upcomingColor ?? clip.style.color}
              onChange={(event) =>
                handleColourChange("upcomingColor", event.target.value)
              }
              className="h-7 w-12 rounded-md border border-border/70 bg-bg-2"
            />
          </div>
        </div>
      )}

      {animationStyle !== "none" && wordCount === 0 && (
        <Card variant="muted" padding={2} className="bg-amber-400/10">
          <Text
            type="supporting"
            display="block"
            className="text-[9px] text-amber-400"
          >
            This caption has no word timing, so it will draw as plain text. Pick a
            style again to time it from the text.
          </Text>
        </Card>
      )}

      {wordCount > 0 && (
        <Text type="supporting" color="secondary" className="text-[10px]">
          {wordCount} word{wordCount === 1 ? "" : "s"} timed
        </Text>
      )}
    </div>
  );
};

export default CaptionAnimationSection;
