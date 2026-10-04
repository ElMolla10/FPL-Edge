// The supplied FPL Edge logo, unchanged: lime FPL / white EDGE on the near-black rounded square (public/brand/primary-logo-1024.png,
// resampled only for the two display sizes). It stays dark in both themes, is never recoloured, shadowed or wrapped in another container,
// and is never rendered below 48px (the identity's minimum for the detailed mark).
export function BrandMark({ size = 48 }: { size?: number }) {
  const px = Math.max(48, size);
  return <img className="brand-logo" src="/brand/primary-logo-96.png" srcSet="/brand/primary-logo-96.png 1x, /brand/primary-logo-192.png 2x" width={px} height={px} alt="" decoding="async" />;
}
