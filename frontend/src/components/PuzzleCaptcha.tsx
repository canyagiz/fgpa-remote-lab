import { Check } from "lucide-react";

interface PuzzleCaptchaProps {
  trackWidth: number;
  pieceSize: number;
  targetX: number;
  value: number;
  onChange: (x: number) => void;
}

// Cosmetic-only echo of the backend's tolerance (routers/auth.py -
// CAPTCHA_TOLERANCE_PX) so the piece visibly "snaps" green once it's close
// enough. The real check happens server-side against the session-stored
// target_x - this is just what tells the user they can let go.
const TOLERANCE_PX = 5;

// A slide-the-piece-into-the-gap captcha: an <input type="range"> drives
// the piece's x position, so dragging, clicking the track, and keyboard
// arrows (once focused) all work for free - the custom visuals on top are
// decorative, not the input.
export default function PuzzleCaptcha({ trackWidth, pieceSize, targetX, value, onChange }: PuzzleCaptchaProps) {
  const aligned = Math.abs(value - targetX) <= TOLERANCE_PX;
  const hue = (targetX * 37) % 360;

  return (
    <div className="space-y-1.5">
      <div
        className="relative overflow-hidden rounded-md border border-border"
        style={{
          width: trackWidth,
          height: pieceSize + 16,
          background: `linear-gradient(135deg, hsl(${hue} 70% 88%), hsl(${(hue + 60) % 360} 70% 78%))`,
        }}
      >
        {/* The gap the piece must be dragged into. */}
        <div
          className="absolute top-2 rounded-md border-2 border-dashed border-card/80"
          style={{
            left: targetX,
            width: pieceSize,
            height: pieceSize,
            boxShadow: "inset 0 0 0 999px rgba(15, 23, 42, 0.35)",
          }}
        />
        {/* The draggable piece. */}
        <div
          className={
            "absolute top-2 flex items-center justify-center rounded-md border-2 shadow transition-colors " +
            (aligned ? "border-success bg-success/90" : "border-primary bg-primary/90")
          }
          style={{ left: value, width: pieceSize, height: pieceSize }}
          aria-hidden="true"
        >
          {aligned && <Check className="h-5 w-5 text-success-foreground" />}
        </div>
        <input
          type="range"
          min={0}
          max={trackWidth - pieceSize}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          required
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          aria-label="Slide the piece into the outlined gap"
          aria-valuetext={aligned ? "Piece is aligned with the gap" : value < targetX ? "Slide right" : "Slide left"}
        />
      </div>
      <p className="text-xs text-muted-foreground">Slide the piece into the gap</p>
    </div>
  );
}
