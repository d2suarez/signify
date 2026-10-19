/** The Signify mark: red circle, blue square, yellow triangle. Recolours with the palette. */
export function BrandMark({ size = 14 }: { size?: number }) {
  return (
    <span aria-hidden className="inline-flex items-end gap-[3px]" style={{ fontSize: size }}>
      <span className="shape shape-circle text-p1" style={{ width: "1em", height: "1em" }} />
      <span className="shape shape-square text-p2" style={{ width: "1em", height: "1em" }} />
      <span className="shape shape-triangle" style={{ width: "1.1em", height: "1em", color: "var(--p3)" }} />
    </span>
  );
}
